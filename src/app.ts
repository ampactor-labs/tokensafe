import crypto from "node:crypto";
import express from "express";
import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { ApiError } from "./utils/errors.js";
import { x402Middleware } from "./x402/middleware.js";
import { checkToken, checkTokenLite } from "./analysis/token-checker.js";
import { monitorTokens } from "./analysis/monitor.js";
import { cacheStats } from "./utils/cache.js";
import { monitorCacheStats } from "./utils/monitor-cache.js";
import { rateLimiter } from "./utils/rate-limit.js";

export const app = express();
app.set("trust proxy", 1);
const startTime = Date.now();

const rateLimit = parseInt(process.env.RATE_LIMIT_PER_MINUTE || "60", 10);
const liteRateLimit = parseInt(process.env.LITE_RATE_LIMIT_PER_MINUTE || "10", 10);
const healthRateLimiter = rateLimiter(rateLimit);
const paidRateLimiter = rateLimiter(rateLimit);
const liteRateLimiter = rateLimiter(liteRateLimit);

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

// 3. Health endpoint — free, separate rate limiter
app.get("/health", healthRateLimiter, (_req, res) => {
  res.json({
    status: "ok",
    version: "0.2.0",
    network: config.solanaNetwork,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    cache: cacheStats(),
    monitorCache: monitorCacheStats(),
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

    const { result, fromCache } = await checkTokenLite(mint);
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
    // Strip internal-only fields before sending
    const { _summary, ...publicResult } = result;
    res.json(publicResult);
  } catch (err) {
    next(err);
  }
});

// 8. Portfolio monitor — gated by x402
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
