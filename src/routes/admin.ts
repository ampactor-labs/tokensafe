import crypto from "node:crypto";
import express, { Router } from "express";
import { config } from "../config.js";
import { ApiError } from "../utils/errors.js";
import { validateMint } from "../utils/validation.js";
import { validateWebhookUrl } from "../utils/ssrf-guard.js";
import {
  createSubscription,
  listSubscriptions,
  updateSubscription,
  deleteSubscription,
} from "../utils/db.js";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  getApiKeyUsage,
  checkUsageLimit,
} from "../utils/api-keys.js";
import { registry } from "../utils/metrics.js";
import { webhookAuth } from "../utils/auth-middleware.js";

export const adminRouter = Router();

// --- Webhook CRUD ---

function generateHmacKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

function redactHmac(full: string): string {
  return "***" + full.slice(-8);
}

const webhookJsonParser = express.json({ limit: "16kb" });

adminRouter.post(
  "/v1/webhooks",
  webhookAuth,
  webhookJsonParser,
  async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
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

      try {
        await validateWebhookUrl(callback_url);
      } catch (err) {
        throw new ApiError(
          "INVALID_WEBHOOK_URL",
          `Invalid callback URL: ${err instanceof Error ? err.message : String(err)}`,
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

adminRouter.get(
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

adminRouter.patch(
  "/v1/webhooks/:id",
  webhookAuth,
  webhookJsonParser,
  async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
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
        try {
          await validateWebhookUrl(callback_url);
        } catch (err) {
          throw new ApiError(
            "INVALID_WEBHOOK_URL",
            `Invalid callback URL: ${err instanceof Error ? err.message : String(err)}`,
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

adminRouter.delete(
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

// --- API Key CRUD ---

const apiKeyJsonParser = express.json({ limit: "16kb" });

adminRouter.post(
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

adminRouter.get(
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

adminRouter.get(
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

adminRouter.delete(
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

// --- Prometheus metrics ---

adminRouter.get("/metrics", (req, res, next) => {
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
