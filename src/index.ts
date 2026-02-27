import express from "express";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { ApiError } from "./utils/errors.js";
import { x402Middleware } from "./x402/middleware.js";
import { checkToken } from "./analysis/token-checker.js";
import { cacheStats } from "./utils/cache.js";
import { rateLimiter } from "./utils/rate-limit.js";

const app = express();
const startTime = Date.now();

const rateLimit = parseInt(process.env.RATE_LIMIT_PER_MINUTE || "60", 10);

// 1. Latency tracking — top of stack
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

// 2. Rate limiter — before x402 to reject abusers early
app.use(rateLimiter(rateLimit));

// 3. Health endpoint — free, not gated by x402
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "0.1.0",
    network: config.solanaNetwork,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    cache: cacheStats(),
  });
});

// 4. x402 payment gate for paid routes
app.use(x402Middleware);

// 5. Token safety check — gated by x402
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

app.listen(config.port, () => {
  logger.info(
    { port: config.port, network: config.solanaNetwork },
    "TokenSafe server started",
  );
});
