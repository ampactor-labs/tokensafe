import crypto from "node:crypto";
import { logger } from "./logger.js";

/**
 * Ed25519 response signing for audit verifiability.
 *
 * At startup, generates an ephemeral ed25519 keypair (or loads from
 * RESPONSE_SIGNING_KEY env var as hex-encoded PKCS8 private key).
 *
 * Signs sha256(JSON.stringify({ mint, checked_at, rpc_slot, risk_score }))
 * for each response. Clients verify against signer_pubkey exposed in /health.
 */

interface SignablePayload {
  mint: string;
  checked_at: string;
  rpc_slot: number;
  risk_score: number;
}

const { privateKey, publicKey } = (() => {
  const envKey = process.env.RESPONSE_SIGNING_KEY;
  if (envKey) {
    try {
      const privDer = Buffer.from(envKey, "hex");
      const priv = crypto.createPrivateKey({
        key: privDer,
        format: "der",
        type: "pkcs8",
      });
      const pub = crypto.createPublicKey(priv);
      return { privateKey: priv, publicKey: pub };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to load RESPONSE_SIGNING_KEY, using ephemeral key",
      );
    }
  } else {
    logger.warn(
      "RESPONSE_SIGNING_KEY not set — using ephemeral Ed25519 key (changes on restart, attestations unverifiable across deploys)",
    );
  }
  return crypto.generateKeyPairSync("ed25519");
})();

export function signResponse(payload: SignablePayload): string {
  const canonical = JSON.stringify({
    mint: payload.mint,
    checked_at: payload.checked_at,
    rpc_slot: payload.rpc_slot,
    risk_score: payload.risk_score,
  });
  const digest = crypto.createHash("sha256").update(canonical).digest();
  const signature = crypto.sign(null, digest, privateKey);
  return signature.toString("hex");
}

/**
 * Verify a signature against the current signer pubkey. Recomputes the exact
 * canonical sha256 digest signResponse() signs, then ed25519-verifies. Returns
 * false on any malformed input rather than throwing. Note: only verifies
 * signatures from the CURRENT key — set RESPONSE_SIGNING_KEY so the key (and
 * thus verifiability) survives restarts/deploys.
 */
export function verifyResponse(
  payload: SignablePayload,
  signatureHex: string,
): boolean {
  try {
    const canonical = JSON.stringify({
      mint: payload.mint,
      checked_at: payload.checked_at,
      rpc_slot: payload.rpc_slot,
      risk_score: payload.risk_score,
    });
    const digest = crypto.createHash("sha256").update(canonical).digest();
    return crypto.verify(null, digest, publicKey, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

export function getSignerPubkey(): string {
  const spki = publicKey.export({ type: "spki", format: "der" });
  // Ed25519 SPKI is 44 bytes: 12 bytes header + 32 bytes raw key
  const rawKey = (spki as Buffer).subarray(12);
  return rawKey.toString("hex");
}

export function hashAuditResults(
  mints: string[],
  results: unknown[],
  timestamp: string,
): string {
  const canonical = JSON.stringify({ mints, results, timestamp });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function signAuditAttestation(hash: string): string {
  const hashBytes = Buffer.from(hash, "hex");
  const signature = crypto.sign(null, hashBytes, privateKey);
  return signature.toString("hex");
}
