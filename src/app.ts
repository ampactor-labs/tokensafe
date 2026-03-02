import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { ApiError } from "./utils/errors.js";
import { validateMint } from "./utils/validation.js";
import {
  createSubscription,
  listSubscriptions,
  updateSubscription,
  deleteSubscription,
} from "./utils/db.js";
import {
  createApiKey,
  validateApiKey,
  checkUsageLimit,
  incrementUsage,
  checkKeyRateLimit,
  listApiKeys,
  revokeApiKey,
  getApiKeyUsage,
} from "./utils/api-keys.js";
import { x402Middleware } from "./x402/middleware.js";
import { checkToken, checkTokenLite } from "./analysis/token-checker.js";
import { cacheStats } from "./utils/cache.js";
import { rateLimiter } from "./utils/rate-limit.js";
import {
  getSignerPubkey,
  hashAuditResults,
  signAuditAttestation,
} from "./utils/response-signer.js";
import {
  registry,
  httpRequestDuration,
  httpRequestsTotal,
  tokenChecksTotal,
  apiKeyRequestsTotal,
} from "./utils/metrics.js";
import { createMcpServer } from "./mcp/server.js";
import {
  evaluatePolicy,
  DEFAULT_POLICY,
  type Policy,
} from "./analysis/policy-engine.js";
import {
  saveAuditResult,
  getAuditResult,
  listAuditHistory,
  pruneExpiredAudits,
} from "./utils/audit-db.js";
import { generateMarkdownReport } from "./utils/audit-report.js";

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
  req.id = crypto.randomUUID();
  res.setHeader("X-Request-ID", req.id);
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
        requestId: req.id,
        status: res.statusCode,
        latencyMs,
        ip: req.ip,
        cache: res.getHeader("X-Cache") ?? null,
      },
      "request",
    );

    // Prometheus metrics — route pattern prevents cardinality explosion from unique mints
    const route =
      (req.route?.path as string | undefined) ?? req.path.split("?")[0];
    const status = String(res.statusCode);
    httpRequestDuration
      .labels(req.method, route, status)
      .observe(latencyMs / 1000);
    httpRequestsTotal.labels(req.method, route, status).inc();
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
      "| `POST /v1/audit/small` | $0.08 USDC (up to 10) | Treasury audit with policy evaluation |",
      "| `POST /v1/audit/standard` | $0.30 USDC (up to 50) | Treasury audit with policy evaluation |",
      "| `GET /v1/audit/history` | API key or Bearer | Audit history |",
      "| `GET /v1/audit/:id/report` | API key or Bearer | Compliance report (markdown) |",
      "| `POST /v1/webhooks` | Bearer auth | Webhook subscription management (CRUD) |",
      "| `POST /v1/api-keys` | Bearer auth | API key management (CRUD) |",
      "| `GET /health` | Free | Server status |",
      "",
      "## Authentication",
      "",
      "- **x402 (default):** Pay $0.008 USDC per request. No API key needed.",
      "- **API key (subscription):** Include `X-API-Key: tks_...` header to skip x402.",
      "  Pro ($49/mo): 200 req/min, 6K checks/month. Enterprise ($199/mo): 600 req/min, unlimited.",
      "",
      "## Rate Limits",
      "",
      "- Paid endpoints (x402): 60 req/min per IP",
      "- Paid endpoints (API key): per-tier rate limit",
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
    version: "1.0.0",
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
          "/v1/audit/small",
          "/v1/audit/standard",
          "/v1/audit/history",
          "/v1/audit/:id/report",
          "/v1/webhooks",
          "/v1/api-keys",
          "/metrics",
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
    validateMint(mint);

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const { result, fromCache } = await checkTokenLite(mint, baseUrl);
    tokenChecksTotal.labels("lite").inc();
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
    validateMint(mint);

    const parsed = parseInt(req.query.threshold as string, 10);
    const threshold = Math.max(
      0,
      Math.min(100, Number.isFinite(parsed) ? parsed : 30),
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
  const hdr = req.headers.authorization ?? "";
  const expected = `Bearer ${config.webhookAdminBearer}`;
  const match =
    hdr.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(hdr), Buffer.from(expected));
  if (!match) {
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

const webhookJsonParser = express.json({ limit: "16kb" });

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
        validateMint(mint);
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
          validateMint(mint);
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

// 4d. API key CRUD — bearer-gated, same admin auth as webhooks
const apiKeyJsonParser = express.json({ limit: "16kb" });

app.post(
  "/v1/api-keys",
  webhookAuth,
  apiKeyJsonParser,
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const { label, tier, expires_at } = req.body as {
        label?: unknown;
        tier?: unknown;
        expires_at?: unknown;
      };

      if (typeof label !== "string" || !label) {
        throw new ApiError(
          "MISSING_REQUIRED_PARAM",
          "label is required and must be a non-empty string",
        );
      }

      if (tier !== "pro" && tier !== "enterprise") {
        throw new ApiError(
          "MISSING_REQUIRED_PARAM",
          "tier must be 'pro' or 'enterprise'",
        );
      }

      const expiresAt =
        typeof expires_at === "string" && expires_at ? expires_at : undefined;

      const { fullKey, record } = createApiKey(label, tier, expiresAt);

      res.status(201).json({
        ...record,
        key: fullKey,
      });
    } catch (err) {
      next(err);
    }
  },
);

app.get(
  "/v1/api-keys",
  webhookAuth,
  (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      res.json(listApiKeys());
    } catch (err) {
      next(err);
    }
  },
);

app.get(
  "/v1/api-keys/:id/usage",
  webhookAuth,
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const rawId = Array.isArray(req.params.id)
        ? req.params.id[0]
        : req.params.id;
      const id = parseInt(rawId, 10);
      if (!Number.isFinite(id)) {
        throw new ApiError("INVALID_API_KEY", "Invalid API key ID");
      }
      const usage = getApiKeyUsage(id);
      const limit = checkUsageLimit(id);
      res.json({ id, used: limit.used, limit: limit.limit, history: usage });
    } catch (err) {
      next(err);
    }
  },
);

app.delete(
  "/v1/api-keys/:id",
  webhookAuth,
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const rawId = Array.isArray(req.params.id)
        ? req.params.id[0]
        : req.params.id;
      const id = parseInt(rawId, 10);
      if (!Number.isFinite(id)) {
        throw new ApiError("INVALID_API_KEY", "Invalid API key ID");
      }
      const revoked = revokeApiKey(id);
      if (!revoked) {
        throw new ApiError("INVALID_API_KEY", `API key ${id} not found`);
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// 4e. Audit history + report — API key or admin bearer, before x402 gate

function auditReadAuth(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction,
) {
  // Check X-API-Key first
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (apiKey) {
    const record = validateApiKey(apiKey);
    if (record && record.active) {
      req.apiKeyRecord = record;
      return next();
    }
  }
  // Fall back to admin bearer (timing-safe comparison)
  if (config.webhookAdminBearer) {
    const hdr = req.headers.authorization ?? "";
    const expected = `Bearer ${config.webhookAdminBearer}`;
    if (
      hdr.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(hdr), Buffer.from(expected))
    ) {
      return next();
    }
  }
  throw new ApiError("UNAUTHORIZED", "Valid API key or admin bearer required");
}

app.get(
  "/v1/audit/history",
  auditReadAuth,
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const mint = req.query.mint as string | undefined;
      if (mint) validateMint(mint);
      const from = req.query.from as string | undefined;
      const to = req.query.to as string | undefined;
      const limit = req.query.limit
        ? parseInt(req.query.limit as string, 10)
        : 50;

      const record = req.apiKeyRecord;

      const rows = listAuditHistory({
        apiKeyId: record?.id,
        mint: mint || undefined,
        from: from || undefined,
        to: to || undefined,
        limit: Math.min(limit, 100),
      });

      res.json(
        rows.map((r) => ({
          id: r.id,
          created_at: r.created_at,
          expires_at: r.expires_at,
          token_count: (JSON.parse(r.mints_json) as string[]).length,
          aggregate_risk_score: r.aggregate_risk_score,
          violation_count: (JSON.parse(r.violations_json) as unknown[]).length,
        })),
      );
    } catch (err) {
      next(err);
    }
  },
);

app.get(
  "/v1/audit/:id/report",
  auditReadAuth,
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const rawId = Array.isArray(req.params.id)
        ? req.params.id[0]
        : req.params.id;
      const row = getAuditResult(rawId);
      if (!row || new Date(row.expires_at) < new Date()) {
        throw new ApiError(
          "AUDIT_NOT_FOUND",
          `Audit ${rawId} not found or expired`,
        );
      }
      const markdown = generateMarkdownReport(row);
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.send(markdown);
    } catch (err) {
      next(err);
    }
  },
);

// 4f. Prometheus metrics — bearer-protected, same auth as webhooks
app.get("/metrics", (req, res, next) => {
  if (!config.webhookAdminBearer) {
    return res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "Not found" } });
  }
  const hdr = req.headers.authorization ?? "";
  const expected = `Bearer ${config.webhookAdminBearer}`;
  if (
    hdr.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(hdr), Buffer.from(expected))
  ) {
    return res
      .status(401)
      .json({ error: { code: "UNAUTHORIZED", message: "Invalid bearer" } });
  }
  registry
    .metrics()
    .then((data) => {
      res.setHeader("Content-Type", registry.contentType);
      res.send(data);
    })
    .catch(next);
});

// 5. API key middleware — validates X-API-Key header, sets req.apiKeyRecord
app.use(
  (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const apiKey = req.headers["x-api-key"] as string | undefined;
    if (!apiKey) return next(); // No key → fall through to x402

    const record = validateApiKey(apiKey);
    if (!record) {
      throw new ApiError("INVALID_API_KEY", "Invalid API key");
    }
    if (!record.active) {
      throw new ApiError("INVALID_API_KEY", "API key has been revoked");
    }
    if (record.expires_at && new Date(record.expires_at) < new Date()) {
      throw new ApiError("API_KEY_EXPIRED", "API key has expired");
    }
    if (!checkKeyRateLimit(record)) {
      throw new ApiError(
        "RATE_LIMITED",
        `API key rate limit exceeded (${record.rate_limit_per_minute}/min)`,
      );
    }
    const usage = checkUsageLimit(record.id);
    if (!usage.allowed) {
      throw new ApiError(
        "API_KEY_LIMIT_EXCEEDED",
        `Monthly usage limit reached (${usage.limit} checks/month)`,
      );
    }

    req.apiKeyRecord = record;
    next();
  },
);

// 5b. x402 payment gate — skipped if API key is present
app.use(
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.apiKeyRecord) return next();
    return x402Middleware(req, res, next);
  },
);

// 5c. Post-auth: increment API key usage + set response headers
app.use(
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const record = req.apiKeyRecord;
    if (record) {
      incrementUsage(record.id);
      apiKeyRequestsTotal.labels(record.tier).inc();
      const usage = checkUsageLimit(record.id);
      res.setHeader("X-API-Key-Tier", record.tier);
      res.setHeader(
        "X-API-Key-Usage",
        record.monthly_limit === 0
          ? `${usage.used}/unlimited`
          : `${usage.used}/${usage.limit}`,
      );
      const now = new Date();
      const resetDate = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
      );
      res.setHeader("X-API-Key-Usage-Reset", resetDate.toISOString());
    }
    next();
  },
);

// 6. Rate limiter for paid routes (independent bucket from health) — only for non-API-key requests
app.use(
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.apiKeyRecord) return next(); // API key has its own rate limiter
    return paidRateLimiter(req, res, next);
  },
);

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
        validateMint(mint);
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

      tokenChecksTotal.labels("batch").inc();

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

const batchJsonParser = express.json({ limit: "256kb" });
app.post("/v1/check/batch/small", batchJsonParser, batchHandler(5));
app.post("/v1/check/batch/medium", batchJsonParser, batchHandler(20));
app.post("/v1/check/batch/large", batchJsonParser, batchHandler(50));

// 7b. Audit endpoint — gated by x402 or API key, tiered pricing
function auditHandler(maxTokens: number) {
  return async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { mints, policy: policyInput } = req.body as {
        mints?: unknown;
        policy?: unknown;
      };

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

      for (const mint of mints) {
        validateMint(mint);
      }

      const policy: Policy =
        policyInput &&
        typeof policyInput === "object" &&
        Array.isArray((policyInput as Policy).rules)
          ? (policyInput as Policy)
          : DEFAULT_POLICY;

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
      );
      const failedCount = results.length - succeeded.length;

      // Evaluate policy against each succeeded result
      const allViolations = succeeded.flatMap((r) => evaluatePolicy(r, policy));

      // Aggregate risk score (average of succeeded)
      const aggregateRisk =
        succeeded.length > 0
          ? succeeded.reduce(
              (sum, r) => sum + ((r as { risk_score: number }).risk_score ?? 0),
              0,
            ) / succeeded.length
          : 0;

      // Risk distribution
      const riskDist: Record<string, number> = {};
      for (const r of succeeded) {
        const level = (r as { risk_level: string }).risk_level;
        if (level) riskDist[level] = (riskDist[level] ?? 0) + 1;
      }

      const createdAt = new Date().toISOString();
      const expiresAt = new Date(
        Date.now() + 90 * 24 * 60 * 60 * 1000,
      ).toISOString();

      const attestationHash = hashAuditResults(
        mints as string[],
        results,
        createdAt,
      );
      const attestationSignature = signAuditAttestation(attestationHash);

      const auditId = crypto.randomUUID();
      const record = req.apiKeyRecord;

      saveAuditResult({
        id: auditId,
        api_key_id: record?.id ?? null,
        mints_json: JSON.stringify(mints),
        policy_json: JSON.stringify(policy),
        results_json: JSON.stringify(results),
        violations_json: JSON.stringify(allViolations),
        aggregate_risk_score: Math.round(aggregateRisk * 10) / 10,
        attestation_hash: attestationHash,
        attestation_signature: attestationSignature,
        created_at: createdAt,
        expires_at: expiresAt,
      });

      // Lazy prune (non-blocking)
      try {
        pruneExpiredAudits();
      } catch {
        // Best-effort
      }

      tokenChecksTotal.labels("audit").inc();

      res.json({
        audit_id: auditId,
        created_at: createdAt,
        expires_at: expiresAt,
        total: mints.length,
        succeeded: succeeded.length,
        failed: failedCount,
        aggregate_risk_score: Math.round(aggregateRisk * 10) / 10,
        risk_distribution: riskDist,
        policy_violations: allViolations,
        attestation: {
          hash: attestationHash,
          signature: attestationSignature,
          signer_pubkey: getSignerPubkey(),
        },
        results,
      });
    } catch (err) {
      next(err);
    }
  };
}

const auditJsonParser = express.json({ limit: "256kb" });
app.post("/v1/audit/small", auditJsonParser, auditHandler(10));
app.post("/v1/audit/standard", auditJsonParser, auditHandler(50));

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
    tokenChecksTotal.labels(req.apiKeyRecord ? "api_key" : "x402").inc();
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
