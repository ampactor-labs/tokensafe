import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { PublicKey } from "@solana/web3.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { ApiError } from "./utils/errors.js";
import {
  createSubscription,
  listSubscriptions,
  updateSubscription,
  deleteSubscription,
} from "./utils/db.js";
import { x402Middleware } from "./x402/middleware.js";
import { checkToken, checkTokenLite } from "./analysis/token-checker.js";
import { cacheStats } from "./utils/cache.js";
import { rateLimiter } from "./utils/rate-limit.js";
import { getSignerPubkey } from "./utils/response-signer.js";
import { createMcpServer } from "./mcp/server.js";

export const app = express();
app.set("trust proxy", 1);
const startTime = Date.now();

// Static icon for MCP registry metadata
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(
  "/icon.svg",
  express.static(path.join(__dirname, "../public/icon.svg")),
);

const healthRateLimiter = rateLimiter(config.rateLimitPerMinute);
const paidRateLimiter = rateLimiter(config.rateLimitPerMinute);
const liteRateLimiter = rateLimiter(config.liteRateLimitPerMinute);

// 1. Request ID — top of stack
app.use((req, res, next) => {
  (req as any).id = crypto.randomUUID();
  res.setHeader("X-Request-ID", (req as any).id);
  next();
});

// 2. Latency tracking
app.use((req, res, next) => {
  const start = Date.now();

  // Patch res.end to inject X-Response-Time header before send
  const originalEnd = res.end.bind(res);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.end = function (...args: any[]) {
    const latencyMs = Date.now() - start;
    if (!res.headersSent) {
      res.setHeader("X-Response-Time", `${latencyMs}ms`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return originalEnd(...(args as [any, any, any]));
  } as typeof res.end;

  res.on("finish", () => {
    const latencyMs = Date.now() - start;
    logger.info(
      {
        method: req.method,
        path: req.path,
        query: req.query,
        requestId: (req as any).id,
        status: res.statusCode,
        latencyMs,
        ip: req.ip,
        cache: res.getHeader("X-Cache") ?? null,
      },
      "request",
    );
  });
  next();
});

// 2b. Request-level timeout — hard ceiling so no single request blocks forever
app.use((req, res, next) => {
  req.setTimeout(15_000, () => {
    if (!res.headersSent) {
      res.status(504).json({
        error: {
          code: "TIMEOUT",
          message: "Request timed out after 15 seconds",
        },
      });
    }
  });
  next();
});

// 3. x402 discovery document — enables x402scan auto-registration
app.get("/.well-known/x402", (_req, res) => {
  const base = `${_req.protocol}://${_req.get("host")}`;
  res.json({
    version: 1,
    resources: [
      `${base}/v1/check?mint=So11111111111111111111111111111111111111112`,
    ],
    ownershipProofs: config.ownershipProof ? [config.ownershipProof] : [],
    instructions: [
      "# TokenSafe — Solana Token Safety Scanner",
      "",
      "Deterministic on-chain analysis. No third-party APIs, no opaque ML.",
      "",
      "## Endpoints",
      "",
      "| Endpoint | Price | Description |",
      "|----------|-------|-------------|",
      "| `GET /v1/check?mint=<ADDR>` | $0.008 USDC | Full safety analysis |",
      "| `GET /v1/check/lite?mint=<ADDR>` | Free | Risk score, name, symbol, extensions |",
      "| `GET /v1/decide?mint=<ADDR>&threshold=N` | Free | Binary SAFE/RISKY/UNKNOWN decision |",
      "| `POST /v1/check/batch/small` | $0.025 (up to 5) | Batch safety check |",
      "| `POST /v1/check/batch/medium` | $0.08 (up to 20) | Batch safety check |",
      "| `POST /v1/check/batch/large` | $0.15 (up to 50) | Batch safety check |",
      "| `POST /v1/webhooks` | Bearer auth | Webhook subscription management (CRUD) |",
      "| `GET /health` | Free | Server status |",
      "",
      "## Rate Limits",
      "",
      "- Paid endpoints: 60 req/min per IP",
      "- Lite endpoint: 10 req/min per IP",
      "- Cached results (< 5min): instant response",
      "",
      "## Checks Performed",
      "",
      "Mint authority, freeze authority, top holder concentration, liquidity depth,",
      "LP lock status, sell-side honeypot detection, metadata mutability, token age,",
      "Token-2022 extensions (transfer fees, permanent delegate, transfer hooks).",
      "",
      "## Support",
      "",
      "GitHub: https://github.com/ampactor-labs/tokensafe",
    ].join("\n"),
  });
});

// 4. Health endpoint — free, separate rate limiter
app.get("/health", healthRateLimiter, (_req, res) => {
  res.json({
    status: "ok",
    version: "0.2.0",
    network: config.solanaNetwork,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    cache: cacheStats(),
    signer_pubkey: getSignerPubkey(),
    facilitator_url: config.facilitatorUrl,
    api_versions: {
      v1: {
        status: "active",
        endpoints: [
          "/v1/check",
          "/v1/check/lite",
          "/v1/decide",
          "/v1/check/batch/small",
          "/v1/check/batch/medium",
          "/v1/check/batch/large",
          "/v1/webhooks",
        ],
      },
    },
  });
});

// 4. Free lite endpoint — before x402 gate, tight rate limit
app.get("/v1/check/lite", liteRateLimiter, async (req, res, next) => {
  try {
    const mint = req.query.mint as string | undefined;
    if (!mint) {
      throw new ApiError(
        "MISSING_REQUIRED_PARAM",
        "Missing required query parameter: mint",
      );
    }

    // Validate base58 early so garbage requests never touch the analysis pipeline
    try {
      new PublicKey(mint);
    } catch {
      throw new ApiError(
        "INVALID_MINT_ADDRESS",
        `Invalid Solana mint address: ${mint}`,
      );
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const { result, fromCache } = await checkTokenLite(mint, baseUrl);
    res.setHeader("X-Cache", fromCache ? "HIT" : "MISS");
    res.setHeader(
      "Cache-Control",
      "public, max-age=300, stale-while-revalidate=60",
    );
    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// 4b. Decide endpoint — free, returns SAFE/RISKY/UNKNOWN binary decision
app.get("/v1/decide", liteRateLimiter, async (req, res, next) => {
  try {
    const mint = req.query.mint as string | undefined;
    if (!mint) {
      throw new ApiError(
        "MISSING_REQUIRED_PARAM",
        "Missing required query parameter: mint",
      );
    }

    try {
      new PublicKey(mint);
    } catch {
      throw new ApiError(
        "INVALID_MINT_ADDRESS",
        `Invalid Solana mint address: ${mint}`,
      );
    }

    const threshold = Math.max(
      0,
      Math.min(100, parseInt(req.query.threshold as string, 10) || 30),
    );

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const { result, fromCache } = await checkTokenLite(mint, baseUrl);
    res.setHeader("X-Cache", fromCache ? "HIT" : "MISS");
    res.setHeader(
      "Cache-Control",
      "public, max-age=300, stale-while-revalidate=60",
    );
    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("Access-Control-Allow-Origin", "*");

    let decision: "SAFE" | "RISKY" | "UNKNOWN";
    if (result.degraded) {
      decision = "UNKNOWN";
    } else if (result.risk_score <= threshold) {
      decision = "SAFE";
    } else {
      decision = "RISKY";
    }

    res.json({
      mint: result.mint,
      decision,
      risk_score: result.risk_score,
      risk_level: result.risk_level,
      threshold_used: threshold,
      full_report: result.full_report,
    });
  } catch (err) {
    next(err);
  }
});

// 4c. Webhook CRUD — bearer-gated, before x402 paywall

function webhookAuth(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction,
) {
  if (!config.webhookAdminBearer) {
    throw new ApiError("UNAUTHORIZED", "Webhook admin not configured");
  }
  const hdr = req.headers.authorization;
  if (!hdr || hdr !== `Bearer ${config.webhookAdminBearer}`) {
    throw new ApiError("UNAUTHORIZED", "Invalid or missing bearer");
  }
  next();
}

function generateHmacKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

function redactHmac(full: string): string {
  return "***" + full.slice(-8);
}

const webhookJsonParser = express.json();

app.post(
  "/v1/webhooks",
  webhookAuth,
  webhookJsonParser,
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const { callback_url, mints, threshold } = req.body as {
        callback_url?: unknown;
        mints?: unknown;
        threshold?: unknown;
      };

      if (typeof callback_url !== "string" || !callback_url) {
        throw new ApiError(
          "MISSING_REQUIRED_PARAM",
          "callback_url is required and must be a non-empty string",
        );
      }

      if (!Array.isArray(mints) || mints.length === 0) {
        throw new ApiError(
          "MISSING_REQUIRED_PARAM",
          "mints is required and must be a non-empty array of strings",
        );
      }

      for (const mint of mints) {
        if (typeof mint !== "string") {
          throw new ApiError(
            "INVALID_MINT_ADDRESS",
            `Invalid mint address: expected string, got ${typeof mint}`,
          );
        }
        try {
          new PublicKey(mint);
        } catch {
          throw new ApiError(
            "INVALID_MINT_ADDRESS",
            `Invalid Solana mint address: ${mint}`,
          );
        }
      }

      const thresholdNum = threshold !== undefined ? Number(threshold) : 50;
      if (
        !Number.isFinite(thresholdNum) ||
        thresholdNum < 0 ||
        thresholdNum > 100
      ) {
        throw new ApiError(
          "MISSING_REQUIRED_PARAM",
          "threshold must be a number between 0 and 100",
        );
      }

      // Enforce per-token subscription limit
      const existing = listSubscriptions();
      for (const mint of mints as string[]) {
        const countForMint = existing.filter(
          (s) => s.active && s.mints.includes(mint),
        ).length;
        if (countForMint >= config.maxWebhooksPerToken) {
          throw new ApiError(
            "WEBHOOK_LIMIT_EXCEEDED",
            `Mint ${mint} already has ${countForMint} active subscriptions (max ${config.maxWebhooksPerToken})`,
          );
        }
      }

      const sub = createSubscription(
        callback_url,
        mints as string[],
        thresholdNum,
        generateHmacKey(),
      );

      // Full hmac shown only on creation
      res.status(201).json(sub);
    } catch (err) {
      next(err);
    }
  },
);

app.get(
  "/v1/webhooks",
  webhookAuth,
  (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const subs = listSubscriptions().map((s) => ({
        ...s,
        secret_hmac: redactHmac(s.secret_hmac),
      }));
      res.json(subs);
    } catch (err) {
      next(err);
    }
  },
);

app.patch(
  "/v1/webhooks/:id",
  webhookAuth,
  webhookJsonParser,
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const rawId = Array.isArray(req.params.id)
        ? req.params.id[0]
        : req.params.id;
      const id = parseInt(rawId, 10);
      if (!Number.isFinite(id)) {
        throw new ApiError("WEBHOOK_NOT_FOUND", "Invalid subscription ID");
      }

      const { callback_url, mints, threshold, active } = req.body as {
        callback_url?: unknown;
        mints?: unknown;
        threshold?: unknown;
        active?: unknown;
      };

      const updates: Parameters<typeof updateSubscription>[1] = {};

      if (callback_url !== undefined) {
        if (typeof callback_url !== "string" || !callback_url) {
          throw new ApiError(
            "MISSING_REQUIRED_PARAM",
            "callback_url must be a non-empty string",
          );
        }
        updates.callback_url = callback_url;
      }

      if (mints !== undefined) {
        if (!Array.isArray(mints) || mints.length === 0) {
          throw new ApiError(
            "MISSING_REQUIRED_PARAM",
            "mints must be a non-empty array of strings",
          );
        }
        for (const mint of mints) {
          if (typeof mint !== "string") {
            throw new ApiError(
              "INVALID_MINT_ADDRESS",
              `Invalid mint address: expected string, got ${typeof mint}`,
            );
          }
          try {
            new PublicKey(mint);
          } catch {
            throw new ApiError(
              "INVALID_MINT_ADDRESS",
              `Invalid Solana mint address: ${mint}`,
            );
          }
        }
        updates.mints = mints as string[];
      }

      if (threshold !== undefined) {
        const t = Number(threshold);
        if (!Number.isFinite(t) || t < 0 || t > 100) {
          throw new ApiError(
            "MISSING_REQUIRED_PARAM",
            "threshold must be a number between 0 and 100",
          );
        }
        updates.threshold = t;
      }

      if (active !== undefined) {
        updates.active = Boolean(active);
      }

      const sub = updateSubscription(id, updates);
      if (!sub) {
        throw new ApiError("WEBHOOK_NOT_FOUND", `Subscription ${id} not found`);
      }

      res.json({
        ...sub,
        secret_hmac: redactHmac(sub.secret_hmac),
      });
    } catch (err) {
      next(err);
    }
  },
);

app.delete(
  "/v1/webhooks/:id",
  webhookAuth,
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const rawId = Array.isArray(req.params.id)
        ? req.params.id[0]
        : req.params.id;
      const id = parseInt(rawId, 10);
      if (!Number.isFinite(id)) {
        throw new ApiError("WEBHOOK_NOT_FOUND", "Invalid subscription ID");
      }

      const deleted = deleteSubscription(id);
      if (!deleted) {
        throw new ApiError("WEBHOOK_NOT_FOUND", `Subscription ${id} not found`);
      }

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// 5. x402 payment gate for paid routes
app.use(x402Middleware);

// 6. Rate limiter for paid routes (independent bucket from health)
app.use(paidRateLimiter);

// 7. Batch token safety check — gated by x402, tiered pricing
function batchHandler(maxTokens: number) {
  return async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { mints } = req.body as { mints?: unknown };
      if (!Array.isArray(mints) || mints.length === 0) {
        throw new ApiError(
          "MISSING_REQUIRED_PARAM",
          "Request body must include a non-empty 'mints' array",
        );
      }
      if (mints.length > maxTokens) {
        throw new ApiError(
          "TOO_MANY_MINTS",
          `This tier supports up to ${maxTokens} mints, got ${mints.length}`,
        );
      }

      // Validate all mints are valid base58 before running any checks
      for (const mint of mints) {
        if (typeof mint !== "string") {
          throw new ApiError(
            "INVALID_MINT_ADDRESS",
            `Invalid mint address: expected string, got ${typeof mint}`,
          );
        }
        try {
          new PublicKey(mint);
        } catch {
          throw new ApiError(
            "INVALID_MINT_ADDRESS",
            `Invalid Solana mint address: ${mint}`,
          );
        }
      }

      const settled = await Promise.allSettled(
        mints.map((mint: string) => checkToken(mint)),
      );

      const results = settled.map((outcome, i) => {
        if (outcome.status === "fulfilled") {
          return outcome.value.result;
        }
        const err = outcome.reason;
        return {
          mint: mints[i],
          status: "error" as const,
          error: {
            code:
              err instanceof ApiError ? err.code : ("INTERNAL_ERROR" as const),
            message: err instanceof Error ? err.message : "Unknown error",
          },
        };
      });

      const succeeded = results.filter(
        (r) => !("status" in r && r.status === "error"),
      ).length;

      res.json({
        total: mints.length,
        succeeded,
        failed: mints.length - succeeded,
        checked_at: new Date().toISOString(),
        results,
      });
    } catch (err) {
      next(err);
    }
  };
}

const jsonParser = express.json();
app.post("/v1/check/batch/small", jsonParser, batchHandler(5));
app.post("/v1/check/batch/medium", jsonParser, batchHandler(20));
app.post("/v1/check/batch/large", jsonParser, batchHandler(50));

// 8. Token safety check — gated by x402
app.get("/v1/check", async (req, res, next) => {
  try {
    const mint = req.query.mint as string | undefined;
    if (!mint) {
      throw new ApiError(
        "MISSING_REQUIRED_PARAM",
        "Missing required query parameter: mint",
      );
    }

    const { result, fromCache } = await checkToken(mint);
    res.setHeader("X-Cache", fromCache ? "HIT" : "MISS");
    res.setHeader("Cache-Control", "private, no-store");
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// 8. MCP Streamable HTTP — stateless, free, rate-limited
const mcpRateLimiter = rateLimiter(config.liteRateLimitPerMinute);
app.post("/mcp", mcpRateLimiter, express.json(), async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const server = createMcpServer(baseUrl);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error({ err }, "MCP request failed");
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "Endpoint not found",
    },
  });
});

// Global error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (err instanceof ApiError) {
      res.status(err.status).json(err.toJSON());
      return;
    }

    logger.error({ err }, "Unhandled error");
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      },
    });
  },
);
