import crypto from "node:crypto";
import express, { Router } from "express";
import { ApiError } from "../utils/errors.js";
import { validateMint } from "../utils/validation.js";
import { checkToken } from "../analysis/token-checker.js";
import {
  evaluatePolicy,
  DEFAULT_POLICY,
  type Policy,
} from "../analysis/policy-engine.js";
import {
  saveAuditResult,
  getAuditResult,
  listAuditHistory,
  pruneExpiredAudits,
} from "../utils/audit-db.js";
import { generateMarkdownReport } from "../utils/audit-report.js";
import {
  getSignerPubkey,
  hashAuditResults,
  signAuditAttestation,
} from "../utils/response-signer.js";
import { tokenChecksTotal } from "../utils/metrics.js";
import { auditReadAuth } from "../utils/auth-middleware.js";

// Read routes — mounted BEFORE the auth stack (own auth via auditReadAuth)
export const auditReadRouter = Router();

auditReadRouter.get(
  "/v1/audit/history",
  auditReadAuth,
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const mint = req.query.mint as string | undefined;
      if (mint) validateMint(mint);
      const from = req.query.from as string | undefined;
      const to = req.query.to as string | undefined;
      if (from && isNaN(Date.parse(from))) {
        throw new ApiError(
          "MISSING_REQUIRED_PARAM",
          "from must be a valid ISO date",
        );
      }
      if (to && isNaN(Date.parse(to))) {
        throw new ApiError(
          "MISSING_REQUIRED_PARAM",
          "to must be a valid ISO date",
        );
      }
      const rawLimit = req.query.limit
        ? parseInt(req.query.limit as string, 10)
        : 50;
      const limit = Math.min(
        Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50,
        100,
      );

      const record = req.apiKeyRecord;

      const rows = listAuditHistory({
        apiKeyId: record?.id,
        mint: mint || undefined,
        from: from || undefined,
        to: to || undefined,
        limit,
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

auditReadRouter.get(
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

// Write routes — mounted AFTER the auth stack (x402 or API key)
export const auditWriteRouter = Router();

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

      const allViolations = succeeded.flatMap((r) => evaluatePolicy(r, policy));

      const aggregateRisk =
        succeeded.length > 0
          ? succeeded.reduce(
              (sum, r) => sum + ((r as { risk_score: number }).risk_score ?? 0),
              0,
            ) / succeeded.length
          : 0;

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

      const anyAuditCached = settled.some(
        (o) => o.status === "fulfilled" && o.value.fromCache,
      );
      res.setHeader("X-Cache", anyAuditCached ? "PARTIAL" : "MISS");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Access-Control-Allow-Origin", "*");
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
auditWriteRouter.post("/v1/audit/small", auditJsonParser, auditHandler(10));
auditWriteRouter.post("/v1/audit/standard", auditJsonParser, auditHandler(50));
