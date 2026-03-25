import crypto from "node:crypto";
import type express from "express";
import { config } from "../config.js";
import { validateApiKey } from "./api-keys.js";
import { ApiError } from "./errors.js";

export function webhookAuth(
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

export function auditReadAuth(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction,
) {
  // Check X-API-Key first
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (apiKey) {
    const record = validateApiKey(apiKey);
    if (record && record.active) {
      if (record.expires_at && new Date(record.expires_at) < new Date()) {
        // Expired — fall through to bearer check
      } else {
        req.apiKeyRecord = record;
        return next();
      }
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
