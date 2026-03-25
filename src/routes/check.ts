import express, { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { ApiError } from "../utils/errors.js";
import { validateMint } from "../utils/validation.js";
import { checkToken, checkTokenLite } from "../analysis/token-checker.js";
import { rateLimiter } from "../utils/rate-limit.js";
import { tokenChecksTotal } from "../utils/metrics.js";
import { createMcpServer } from "../mcp/server.js";

// Free check routes — mounted BEFORE the auth stack
export const freeCheckRouter = Router();

const liteRateLimiter = rateLimiter(config.liteRateLimitPerMinute);

freeCheckRouter.get(
  "/v1/check/lite",
  liteRateLimiter,
  async (req, res, next) => {
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
      res.setHeader("X-Data-Confidence", result.data_confidence);
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
  },
);

freeCheckRouter.get("/v1/decide", liteRateLimiter, async (req, res, next) => {
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
    res.setHeader("X-Data-Confidence", result.data_confidence);
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
      score_reliable: !result.degraded,
      ...(decision === "UNKNOWN" && {
        note: "Some safety checks failed. Risk score includes uncertainty penalties. Retry in 30s or use /v1/check for full details.",
        degraded_checks: result.degraded_checks,
      }),
      full_report: result.full_report,
    });
  } catch (err) {
    next(err);
  }
});

// Paid check routes — mounted AFTER the auth stack
export const paidCheckRouter = Router();

paidCheckRouter.get("/v1/check", async (req, res, next) => {
  try {
    const mint = req.query.mint as string | undefined;
    if (!mint) {
      throw new ApiError(
        "MISSING_REQUIRED_PARAM",
        "Missing required query parameter: mint",
      );
    }
    validateMint(mint);

    const { result, fromCache } = await checkToken(mint);
    tokenChecksTotal.labels(req.apiKeyRecord ? "api_key" : "x402").inc();
    res.setHeader("X-Cache", fromCache ? "HIT" : "MISS");
    res.setHeader("X-Data-Confidence", result.data_confidence);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Batch handlers
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

      const anyBatchCached = settled.some(
        (o) => o.status === "fulfilled" && o.value.fromCache,
      );
      res.setHeader("X-Cache", anyBatchCached ? "PARTIAL" : "MISS");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Access-Control-Allow-Origin", "*");
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
paidCheckRouter.post("/v1/check/batch/small", batchJsonParser, batchHandler(5));
paidCheckRouter.post(
  "/v1/check/batch/medium",
  batchJsonParser,
  batchHandler(20),
);
paidCheckRouter.post(
  "/v1/check/batch/large",
  batchJsonParser,
  batchHandler(50),
);

// MCP Streamable HTTP — stateless, free, rate-limited
const mcpRateLimiter = rateLimiter(config.liteRateLimitPerMinute);
paidCheckRouter.post(
  "/mcp",
  mcpRateLimiter,
  express.json(),
  async (req, res) => {
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
  },
);
