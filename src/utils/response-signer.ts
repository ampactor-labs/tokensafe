import crypto from "node:crypto";

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
    const privDer = Buffer.from(envKey, "hex");
    const priv = crypto.createPrivateKey({
      key: privDer,
      format: "der",
      type: "pkcs8",
    });
    const pub = crypto.createPublicKey(priv);
    return { privateKey: priv, publicKey: pub };
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

export function getSignerPubkey(): string {
  const spki = publicKey.export({ type: "spki", format: "der" });
  // Ed25519 SPKI is 44 bytes: 12 bytes header + 32 bytes raw key
  const rawKey = (spki as Buffer).subarray(12);
  return rawKey.toString("hex");
}
