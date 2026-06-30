import { describe, it, expect } from "vitest";
import {
  signResponse,
  verifyResponse,
  getSignerPubkey,
} from "../src/utils/response-signer.js";

const WSOL = "So11111111111111111111111111111111111111112";
const payload = {
  mint: WSOL,
  checked_at: "2026-06-30T00:00:00.000Z",
  rpc_slot: 123456789,
  risk_score: 15,
};

describe("response attestation verify", () => {
  it("verifies a signature produced by signResponse", () => {
    const sig = signResponse(payload);
    expect(verifyResponse(payload, sig)).toBe(true);
  });

  it("rejects a tampered risk_score", () => {
    const sig = signResponse(payload);
    expect(verifyResponse({ ...payload, risk_score: 99 }, sig)).toBe(false);
  });

  it("rejects a tampered mint", () => {
    const sig = signResponse(payload);
    expect(
      verifyResponse(
        { ...payload, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
        sig,
      ),
    ).toBe(false);
  });

  it("rejects a garbage / non-hex signature without throwing", () => {
    expect(verifyResponse(payload, "not-a-hex-sig")).toBe(false);
    expect(verifyResponse(payload, "")).toBe(false);
    expect(verifyResponse(payload, "deadbeef")).toBe(false);
  });

  it("exposes a 32-byte (64-hex-char) signer pubkey", () => {
    expect(getSignerPubkey()).toMatch(/^[0-9a-f]{64}$/);
  });
});
