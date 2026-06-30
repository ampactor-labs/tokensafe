import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the resource server (facilitator-backed) so the gate logic is tested
// deterministically without a wallet / network. Real settlement is verified
// separately on testnet via scripts/x402-mcp-client.ts.
vi.mock("../src/x402/middleware.js", () => ({
  x402Middleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  resourceServer: {
    initialize: vi.fn().mockResolvedValue(undefined),
    createPaymentRequiredResponse: vi.fn(),
    verifyPayment: vi.fn(),
    settlePayment: vi.fn(),
  },
}));

vi.mock("../src/analysis/token-checker.js", () => ({
  checkToken: vi.fn(),
  checkTokenLite: vi.fn(),
}));

vi.mock("@x402/core/http", () => ({
  decodePaymentSignatureHeader: vi.fn(() => ({ x402Version: 2, scheme: "exact" })),
  encodePaymentRequiredHeader: vi.fn(() => "enc-payment-required"),
  encodePaymentResponseHeader: vi.fn(() => "enc-payment-response"),
}));

import { resourceServer } from "../src/x402/middleware.js";
import { checkToken } from "../src/analysis/token-checker.js";
import {
  isPaidMcpToolCall,
  handlePaidMcpToolCall,
} from "../src/mcp/payment.js";

const WSOL = "So11111111111111111111111111111111111111112";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rs = resourceServer as any;
const mockCheckToken = vi.mocked(checkToken);

const challenge = {
  x402Version: 2,
  resource: { url: "https://x/mcp" },
  accepts: [
    {
      scheme: "exact",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount: "20000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      payTo: "MgSxRMwW39uG1ehqW6nuKvHzJsq9A3wG2cgV3i8ctAz",
      maxTimeoutSeconds: 60,
      extra: { feePayer: "fp" },
    },
  ],
};

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  status(c: number): FakeRes;
  setHeader(k: string, v: string): void;
  json(o: unknown): FakeRes;
}

function makeRes(): FakeRes {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    },
    json(o: unknown) {
      this.body = o;
      return this;
    },
  };
}

function makeReq(body: unknown, headers: Record<string, string> = {}) {
  return {
    body,
    protocol: "https",
    get(name: string) {
      const k = name.toLowerCase();
      if (k === "host") return "localhost:3000";
      return headers[k];
    },
  };
}

function paidCall(args: Record<string, unknown> = { mint_address: WSOL }) {
  return {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "solana_token_safety_check_full", arguments: args },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rs.initialize.mockResolvedValue(undefined);
  rs.createPaymentRequiredResponse.mockResolvedValue(challenge);
  rs.verifyPayment.mockResolvedValue({ isValid: true, payer: "p" });
  rs.settlePayment.mockResolvedValue({
    success: true,
    transaction: "sig123",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  });
  mockCheckToken.mockResolvedValue({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result: { mint: WSOL, risk_score: 5, risk_level: "LOW" } as any,
    fromCache: false,
  });
});

describe("isPaidMcpToolCall", () => {
  it("matches a tools/call for the paid tool only", () => {
    expect(isPaidMcpToolCall(paidCall())).toBe(true);
    expect(
      isPaidMcpToolCall({
        method: "tools/call",
        params: { name: "solana_token_safety_check" },
      }),
    ).toBe(false);
    expect(isPaidMcpToolCall({ method: "tools/list" })).toBe(false);
    expect(isPaidMcpToolCall(null)).toBe(false);
  });
});

describe("handlePaidMcpToolCall", () => {
  it("returns HTTP 402 + PAYMENT-REQUIRED when no payment header is present", async () => {
    const res = makeRes();
    await handlePaidMcpToolCall(makeReq(paidCall()) as never, res as never);
    expect(res.statusCode).toBe(402);
    expect(res.headers["payment-required"]).toBe("enc-payment-required");
    expect(res.body).toBe(challenge);
    expect(mockCheckToken).not.toHaveBeenCalled();
    expect(rs.settlePayment).not.toHaveBeenCalled();
  });

  it("returns 402 (fail-closed) when verification is invalid", async () => {
    rs.verifyPayment.mockResolvedValue({ isValid: false, invalidReason: "bad" });
    const res = makeRes();
    await handlePaidMcpToolCall(
      makeReq(paidCall(), { "payment-signature": "x" }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(402);
    expect(mockCheckToken).not.toHaveBeenCalled();
    expect(rs.settlePayment).not.toHaveBeenCalled();
  });

  it("runs the full check then settles on a valid payment", async () => {
    const res = makeRes();
    await handlePaidMcpToolCall(
      makeReq(paidCall(), { "payment-signature": "x" }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(mockCheckToken).toHaveBeenCalledWith(WSOL);
    expect(rs.settlePayment).toHaveBeenCalledTimes(1);
    expect(res.headers["payment-response"]).toBe("enc-payment-response");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = res.body as any;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(7);
    expect(body.result.content[0].text).toContain("risk_score");
    expect(body.result.isError).toBeUndefined();
  });

  it("also accepts x-payment header", async () => {
    const res = makeRes();
    await handlePaidMcpToolCall(
      makeReq(paidCall(), { "x-payment": "x" }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(rs.settlePayment).toHaveBeenCalledTimes(1);
  });

  it("does NOT settle when the analysis fails (no charge for failed checks)", async () => {
    const res = makeRes();
    await handlePaidMcpToolCall(
      makeReq(paidCall({ mint_address: "not-a-valid-mint!!!" }), {
        "payment-signature": "x",
      }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(200); // JSON-RPC error envelope, HTTP 200
    expect(rs.settlePayment).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = res.body as any;
    expect(body.result.isError).toBe(true);
  });
});
