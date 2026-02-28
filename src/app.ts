import crypto from "node:crypto";
import express from "express";
import { PublicKey } from "@solana/web3.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { ApiError } from "./utils/errors.js";
import { x402Middleware } from "./x402/middleware.js";
import { checkToken, checkTokenLite } from "./analysis/token-checker.js";
import { monitorTokens } from "./analysis/monitor.js";
import { cacheStats } from "./utils/cache.js";
import { monitorCacheStats } from "./utils/monitor-cache.js";
import { rateLimiter } from "./utils/rate-limit.js";
import { getSignerPubkey } from "./utils/response-signer.js";
import { createMcpServer } from "./mcp/server.js";

export const app = express();
app.set("trust proxy", 1);
const startTime = Date.now();

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
      `${base}/v1/batch?mints=So11111111111111111111111111111111111111112`,
      `${base}/v1/monitor?mints=So11111111111111111111111111111111111111112`,
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
      "| `GET /v1/check?mint=<ADDR>` | $0.005 USDC | Full safety analysis |",
      "| `GET /v1/batch?mints=<ADDR1>,<ADDR2>,...` | $0.008 USDC | Up to 10 tokens (20% discount) |",
      "| `GET /v1/monitor?mints=<ADDR1>,<ADDR2>,...` | $0.005 USDC | Delta detection + alerts |",
      "| `GET /v1/check/lite?mint=<ADDR>` | Free | Risk score + summary only |",
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
    monitorCache: monitorCacheStats(),
    signer_pubkey: getSignerPubkey(),
    facilitator_url: config.facilitatorUrl,
    api_versions: {
      v1: {
        status: "active",
        endpoints: ["/v1/check", "/v1/check/lite", "/v1/batch", "/v1/monitor"],
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
        "INVALID_MINT_ADDRESS",
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
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// 5. x402 payment gate for paid routes
app.use(x402Middleware);

// 6. Rate limiter for paid routes (independent bucket from health)
app.use(paidRateLimiter);

// 7. Token safety check — gated by x402
app.get("/v1/check", async (req, res, next) => {
  try {
    const mint = req.query.mint as string | undefined;
    if (!mint) {
      throw new ApiError(
        "INVALID_MINT_ADDRESS",
        "Missing required query parameter: mint",
      );
    }

    const { result, fromCache } = await checkToken(mint);
    res.setHeader("X-Cache", fromCache ? "HIT" : "MISS");
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// 8. Batch check — gated by x402
app.get("/v1/batch", async (req, res, next) => {
  try {
    const mintsParam = req.query.mints as string | undefined;
    if (!mintsParam || mintsParam.trim().length === 0) {
      throw new ApiError(
        "INVALID_MINT_ADDRESS",
        "Missing required query parameter: mints",
      );
    }

    const mints = [
      ...new Set(
        mintsParam
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean),
      ),
    ];

    if (mints.length === 0) {
      throw new ApiError(
        "INVALID_MINT_ADDRESS",
        "No valid mint addresses provided",
      );
    }

    if (mints.length > 10) {
      throw new ApiError(
        "TOO_MANY_MINTS",
        `Maximum 10 mints per request, got ${mints.length}`,
      );
    }

    // Validate all addresses before running any checks
    for (const mint of mints) {
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
      mints.map((mint) => checkToken(mint)),
    );

    const results: any[] = [];
    const errors: any[] = [];

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome.status === "fulfilled") {
        res.setHeader("X-Cache", outcome.value.fromCache ? "HIT" : "MISS");
        results.push(outcome.value.result);
      } else {
        const err = outcome.reason;
        errors.push({
          mint: mints[i],
          error:
            err instanceof ApiError
              ? err.toJSON().error
              : { code: "INTERNAL_ERROR", message: "Analysis failed" },
        });
      }
    }

    res.json({
      checked_at: new Date().toISOString(),
      token_count: mints.length,
      results,
      errors,
    });
  } catch (err) {
    next(err);
  }
});

// 9. Portfolio monitor — gated by x402
app.get("/v1/monitor", async (req, res, next) => {
  try {
    const mintsParam = req.query.mints as string | undefined;
    if (!mintsParam || mintsParam.trim().length === 0) {
      throw new ApiError(
        "INVALID_MINT_ADDRESS",
        "Missing required query parameter: mints",
      );
    }

    const mints = [
      ...new Set(
        mintsParam
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean),
      ),
    ];

    if (mints.length === 0) {
      throw new ApiError(
        "INVALID_MINT_ADDRESS",
        "No valid mint addresses provided",
      );
    }

    if (mints.length > 10) {
      throw new ApiError(
        "TOO_MANY_MINTS",
        `Maximum 10 mints per request, got ${mints.length}`,
      );
    }

    const response = await monitorTokens(mints);
    res.json(response);
  } catch (err) {
    next(err);
  }
});

// 10. MCP Streamable HTTP — stateless, free, rate-limited
const mcpRateLimiter = rateLimiter(config.liteRateLimitPerMinute);
app.post("/mcp", mcpRateLimiter, express.json(), async (req, res) => {
  try {
    const server = createMcpServer();
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
