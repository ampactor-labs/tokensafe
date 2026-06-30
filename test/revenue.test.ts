import { describe, it, expect } from "vitest";
import {
  recordSettledPayment,
  getRevenueSummary,
  isPaidRoute,
  priceUsdForRoute,
} from "../src/utils/revenue.js";

describe("revenue signal", () => {
  it("identifies paid routes (incl. /mcp); free routes excluded", () => {
    expect(isPaidRoute("/v1/check")).toBe(true);
    expect(isPaidRoute("/v1/audit/standard")).toBe(true);
    expect(isPaidRoute("/mcp")).toBe(true);
    expect(isPaidRoute("/v1/check/lite")).toBe(false);
    expect(isPaidRoute("/health")).toBe(false);
    expect(priceUsdForRoute("/v1/check")).toBe(0.02);
    expect(priceUsdForRoute("/mcp")).toBe(0.02); // paid MCP tool charges the check rate
    expect(priceUsdForRoute("/health")).toBe(0);
  });

  it("records a settled x402 payment and accumulates USD", () => {
    const before = getRevenueSummary();
    recordSettledPayment({
      source: "x402",
      endpoint: "/v1/check",
      priceUsd: 0.02,
      payer: "PayerPubkey",
      tx: "TxSig",
      mint: "Mint",
    });
    const after = getRevenueSummary();
    expect(after.settled_payments).toBe(before.settled_payments + 1);
    expect(after.revenue_usd).toBeCloseTo(before.revenue_usd + 0.02, 6);
    expect(after.last_payment?.source).toBe("x402");
    expect(after.last_payment?.endpoint).toBe("/v1/check");
    expect(after.by_endpoint["/v1/check"]).toBeGreaterThan(0);
  });

  it("counts mcp_x402 as settled revenue", () => {
    const before = getRevenueSummary();
    recordSettledPayment({
      source: "mcp_x402",
      endpoint: "/mcp",
      priceUsd: 0.02,
    });
    const after = getRevenueSummary();
    expect(after.settled_payments).toBe(before.settled_payments + 1);
    expect(after.revenue_usd).toBeCloseTo(before.revenue_usd + 0.02, 6);
  });

  it("counts api-key calls without adding x402 USD revenue", () => {
    const before = getRevenueSummary();
    recordSettledPayment({ source: "api_key", endpoint: "/v1/check", priceUsd: 0 });
    const after = getRevenueSummary();
    expect(after.api_key_calls).toBe(before.api_key_calls + 1);
    expect(after.settled_payments).toBe(before.settled_payments); // not x402-settled
    expect(after.revenue_usd).toBeCloseTo(before.revenue_usd, 6);
  });
});
