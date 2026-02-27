import express from "express";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { ApiError } from "./utils/errors.js";
import { x402Middleware } from "./x402/middleware.js";
import { checkToken } from "./analysis/token-checker.js";

const app = express();
const startTime = Date.now();

// Health endpoint — free, no payment
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "0.1.0",
    network: config.solanaNetwork,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

// x402 payment gate for paid routes
app.use(x402Middleware);

// Token safety check — gated by x402
app.get("/v1/check", async (req, res, next) => {
  try {
    const mint = req.query.mint as string | undefined;
    if (!mint) {
      throw new ApiError(
        "INVALID_MINT_ADDRESS",
        "Missing required query parameter: mint",
      );
    }

    const result = await checkToken(mint);
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
