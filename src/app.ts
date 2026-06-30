import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { ApiError } from "./utils/errors.js";
import {
  validateApiKey,
  checkUsageLimit,
  incrementUsage,
  checkKeyRateLimit,
} from "./utils/api-keys.js";
import { x402Middleware } from "./x402/middleware.js";
import { cacheStats } from "./utils/cache.js";
import { rateLimiter } from "./utils/rate-limit.js";
import { getSignerPubkey } from "./utils/response-signer.js";
import {
  httpRequestDuration,
  httpRequestsTotal,
  apiKeyRequestsTotal,
} from "./utils/metrics.js";
import {
  isPaidRoute,
  priceUsdForRoute,
  recordSettledPayment,
} from "./utils/revenue.js";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { adminRouter } from "./routes/admin.js";
import { freeCheckRouter, paidCheckRouter } from "./routes/check.js";
import { auditReadRouter, auditWriteRouter } from "./routes/audit.js";
import { discoveryRouter } from "./discovery/router.js";

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

// 1. Request ID — top of stack
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader("X-Request-ID", req.id);
  next();
});

// 1b. CORS preflight for all /v1/* routes (including paid endpoints)
app.options("/v1/*path", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-API-Key, Authorization, PAYMENT-SIGNATURE",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  res.status(204).end();
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

    // Revenue signal — real settled payment vs. unpaid 402 probe. A payer gets
    // a 2xx on a paid route carrying a PAYMENT-RESPONSE receipt; bots never do.
    if (res.statusCode >= 200 && res.statusCode < 300 && isPaidRoute(route)) {
      const receipt = res.getHeader("PAYMENT-RESPONSE");
      if (receipt) {
        let payer: string | undefined;
        let tx: string | undefined;
        try {
          const settle = decodePaymentResponseHeader(String(receipt));
          payer = settle.payer;
          tx = settle.transaction;
        } catch {
          // malformed receipt — still count the settlement
        }
        recordSettledPayment({
          source: route === "/mcp" ? "mcp_x402" : "x402",
          endpoint: route,
          priceUsd: priceUsdForRoute(route),
          payer,
          tx,
          mint: typeof req.query.mint === "string" ? req.query.mint : undefined,
        });
      } else if (req.apiKeyRecord && route !== "/mcp") {
        recordSettledPayment({
          source: "api_key",
          endpoint: route,
          priceUsd: 0,
        });
      }
    }
  });
  next();
});

// 2b. Request-level timeout — hard ceiling so no single request blocks forever
app.use((req, res, next) => {
  req.setTimeout(30_000, () => {
    if (!res.headersSent) {
      res.status(504).json({
        error: {
          code: "TIMEOUT",
          message: "Request timed out after 30 seconds",
        },
      });
    }
  });
  next();
});

// 3. Discovery documents — GET /openapi.json (+ /swagger.json, /v3/api-docs),
//    /.well-known/x402, /discovery/resources (+ aggregator path variants),
//    /llms.txt, /.well-known/api-catalog. Mounted before the x402 gate so
//    crawlers get 200s; all derived from the canonical resource catalog.
app.use("/", discoveryRouter);

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

// ═══ PRE-AUTH ROUTES ═══
// These routes use their own auth (bearer, rate-limiter) — before x402 gate

app.use("/", freeCheckRouter); // /v1/check/lite, /v1/decide
app.use("/", adminRouter); // /v1/webhooks, /v1/api-keys, /metrics
app.use("/", auditReadRouter); // /v1/audit/history, /v1/audit/:id/report

// ═══ AUTH MIDDLEWARE STACK ═══

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

// 6. Rate limiter for paid routes — only for non-API-key requests
app.use(
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.apiKeyRecord) return next(); // API key has its own rate limiter
    return paidRateLimiter(req, res, next);
  },
);

// ═══ POST-AUTH ROUTES ═══
// These routes require x402 payment or valid API key

app.use("/", paidCheckRouter); // /v1/check, /v1/check/batch/*, /mcp
app.use("/", auditWriteRouter); // /v1/audit/small, /v1/audit/standard

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
