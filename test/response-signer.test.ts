import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { signResponse, getSignerPubkey } from "../src/utils/response-signer.js";

describe("response-signer", () => {
  const payload = {
    mint: "So11111111111111111111111111111111111111112",
    checked_at: "2026-02-27T00:00:00.000Z",
    rpc_slot: 300000000,
    risk_score: 15,
  };

  it("returns a hex-encoded signature", () => {
    const sig = signResponse(payload);
    expect(typeof sig).toBe("string");
    expect(sig).toMatch(/^[0-9a-f]+$/);
    // Ed25519 signatures are 64 bytes = 128 hex chars
    expect(sig.length).toBe(128);
  });

  it("returns deterministic signatures for same payload", () => {
    const sig1 = signResponse(payload);
    const sig2 = signResponse(payload);
    expect(sig1).toBe(sig2);
  });

  it("returns different signatures for different payloads", () => {
    const sig1 = signResponse(payload);
    const sig2 = signResponse({ ...payload, risk_score: 50 });
    expect(sig1).not.toBe(sig2);
  });

  it("returns a 32-byte hex-encoded public key", () => {
    const pubkey = getSignerPubkey();
    expect(typeof pubkey).toBe("string");
    expect(pubkey).toMatch(/^[0-9a-f]+$/);
    expect(pubkey.length).toBe(64); // 32 bytes = 64 hex chars
  });

  it("signature is verifiable with the public key", () => {
    const sig = signResponse(payload);
    const pubkeyHex = getSignerPubkey();

    // Reconstruct the signed digest
    const canonical = JSON.stringify({
      mint: payload.mint,
      checked_at: payload.checked_at,
      rpc_slot: payload.rpc_slot,
      risk_score: payload.risk_score,
    });
    const digest = crypto.createHash("sha256").update(canonical).digest();

    // Reconstruct public key from raw bytes
    const rawPubkey = Buffer.from(pubkeyHex, "hex");
    const pubKeyObj = crypto.createPublicKey({
      key: Buffer.concat([
        // Ed25519 SPKI header (12 bytes)
        Buffer.from("302a300506032b6570032100", "hex"),
        rawPubkey,
      ]),
      format: "der",
      type: "spki",
    });

    const sigBuffer = Buffer.from(sig, "hex");
    const valid = crypto.verify(null, digest, pubKeyObj, sigBuffer);
    expect(valid).toBe(true);
  });
});
