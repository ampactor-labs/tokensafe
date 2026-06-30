import express, { Router } from "express";
import { ApiError } from "../utils/errors.js";
import { verifyResponse, getSignerPubkey } from "../utils/response-signer.js";

/**
 * Free, stateless attestation verification. A caller POSTs back the signed
 * fields + response_signature it received from /v1/check (it can POST the whole
 * response object — extra fields are ignored) and gets {valid, signer_pubkey}.
 *
 * This is the "verifiable" half of the deterministic-and-signed moat: anyone
 * can independently confirm TokenSafe asserted a given risk_score for a mint at
 * a given slot, without trusting the caller.
 */
export const verifyRouter = Router();

verifyRouter.post(
  "/v1/verify",
  express.json({ limit: "16kb" }),
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const { mint, checked_at, rpc_slot, risk_score, response_signature } =
        req.body as {
          mint?: unknown;
          checked_at?: unknown;
          rpc_slot?: unknown;
          risk_score?: unknown;
          response_signature?: unknown;
        };

      if (
        typeof mint !== "string" ||
        typeof checked_at !== "string" ||
        typeof rpc_slot !== "number" ||
        typeof risk_score !== "number" ||
        typeof response_signature !== "string"
      ) {
        throw new ApiError(
          "MISSING_REQUIRED_PARAM",
          "Required: mint (string), checked_at (string), rpc_slot (number), risk_score (number), response_signature (hex string) — POST the signed fields from a /v1/check response.",
        );
      }

      const valid = verifyResponse(
        { mint, checked_at, rpc_slot, risk_score },
        response_signature,
      );

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-store");
      res.json({ valid, signer_pubkey: getSignerPubkey() });
    } catch (err) {
      next(err);
    }
  },
);
