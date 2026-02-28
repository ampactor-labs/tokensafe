import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type {
  TokenCheckResult,
  CheckTokenResponse,
  TokenCheckLiteResult,
  CheckTokenLiteResponse,
} from "../src/analysis/token-checker.js";

// Mock x402 middleware to passthrough — payment flow tested by smoke test + devnet
vi.mock("../src/x402/middleware.js", () => ({
  x402Middleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Mock checkToken + checkTokenLite — boundary between HTTP layer and Solana RPC
vi.mock("../src/analysis/token-checker.js", () => ({
  checkToken: vi.fn(),
  checkTokenLite: vi.fn(),
}));

import { app } from "../src/app.js";
import { checkToken, checkTokenLite } from "../src/analysis/token-checker.js";
import { clearCache } from "../src/utils/cache.js";
import { clearRateLimitBuckets } from "../src/utils/rate-limit.js";

const mockCheckToken = vi.mocked(checkToken);
const mockCheckTokenLite = vi.mocked(checkTokenLite);

const WSOL = "So11111111111111111111111111111111111111112";

function makeResult(overrides?: Partial<TokenCheckResult>): CheckTokenResponse {
  const result: TokenCheckResult = {
    mint: WSOL,
    name: "Wrapped SOL",
    symbol: "SOL",
    checked_at: "2026-02-27T00:00:00.000Z",
    cached_at: null,
    risk_score: 15,
    risk_level: "LOW",
    checks: {
      mint_authority: { status: "RENOUNCED", authority: null, risk: "SAFE" },
      freeze_authority: { status: "RENOUNCED", authority: null, risk: "SAFE" },
      supply: { total: "999999999", decimals: 9 },
      top_holders: {
        top_10_percentage: 12.5,
        top_1_percentage: 3.2,
        holder_count_estimate: 50000,
        top_holders_detail: null,
        note: null,
        risk: "SAFE",
      },
      liquidity: {
        has_liquidity: true,
        primary_pool: "Raydium",
        pool_address: null,
        price_impact_pct: 0.5,
        liquidity_rating: "DEEP",
        lp_locked: true,
        lp_lock_percentage: 95,
        lp_lock_expiry: null,
        lp_mint: null,
        lp_locker: null,
        risk: "SAFE",
      },
      metadata: null,
      honeypot: null,
      token_age_hours: 8760,
      token_age_minutes: 525600,
      token_program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      is_token_2022: false,
      token_2022_extensions: null,
    },
    rpc_slot: 300000000,
    methodology_version: "1.0.0",
    risk_factors: [],
    summary: "No risk factors detected",
    degraded: false,
    degraded_checks: [],
    changes: null,
    alerts: [],
    response_signature: "deadbeef",
    signer_pubkey: "cafebabe",
    ...overrides,
  };
  return { result, fromCache: false };
}

function makeLiteResult(
  overrides?: Partial<TokenCheckLiteResult>,
): CheckTokenLiteResponse {
  const result: TokenCheckLiteResult = {
    mint: WSOL,
    name: "Wrapped SOL",
    symbol: "SOL",
    risk_score: 15,
    risk_level: "LOW",
    summary: "No risk factors detected",
    degraded: false,
    is_token_2022: false,
    has_risky_extensions: false,
    full_report: {
      url: `/v1/check?mint=${WSOL}`,
      price_usd: "$0.008",
      payment_protocol: "x402",
      includes:
        "authority addresses, holder breakdown, LP lock status, honeypot details, delta detection",
    },
    ...overrides,
  };
  return { result, fromCache: false };
}

beforeEach(() => {
  mockCheckToken.mockReset();
  mockCheckTokenLite.mockReset();
  clearCache();
  clearRateLimitBuckets();
});

describe("GET /health", () => {
  it("returns 200 with correct shape", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      version: "0.2.0",
      cache: {
        size: expect.any(Number),
        maxSize: 10000,
        hits: expect.any(Number),
        misses: expect.any(Number),
        hitRate: expect.any(String),
      },
    });
    expect(res.body).toHaveProperty("network");
    expect(res.body).toHaveProperty("uptime");
  });

  it("includes signer_pubkey for response verification", async () => {
    const res = await request(app).get("/health");
    expect(res.body.signer_pubkey).toBeDefined();
    expect(typeof res.body.signer_pubkey).toBe("string");
    expect(res.body.signer_pubkey.length).toBe(64); // 32 bytes hex-encoded
  });

  it("includes api_versions with v1 endpoints", async () => {
    const res = await request(app).get("/health");
    expect(res.body.api_versions).toMatchObject({
      v1: {
        status: "active",
        endpoints: expect.arrayContaining(["/v1/check", "/v1/check/lite"]),
      },
    });
  });

  it("includes X-Response-Time header", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-response-time"]).toMatch(/^\d+ms$/);
  });

  it("includes X-RateLimit headers", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
  });
});

describe("GET /v1/check", () => {
  it("returns 200 with token analysis for valid mint", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.status).toBe(200);
    expect(res.body.mint).toBe(WSOL);
    expect(res.body.risk_score).toBe(15);
    expect(res.body.risk_level).toBe("LOW");
    expect(res.body.checks).toBeDefined();
  });

  it("includes methodology_version in response", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.body.methodology_version).toBe("1.0.0");
  });

  it("includes degraded: false when all checks succeed", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.body.degraded).toBe(false);
  });

  it("includes degraded: true when checks are unavailable", async () => {
    mockCheckToken.mockResolvedValue(
      makeResult({ degraded: true, summary: "No risk factors detected" }),
    );
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.body.degraded).toBe(true);
  });

  it("includes response_signature and signer_pubkey", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.body.response_signature).toBeDefined();
    expect(typeof res.body.response_signature).toBe("string");
    expect(res.body.signer_pubkey).toBeDefined();
    expect(typeof res.body.signer_pubkey).toBe("string");
  });

  it("includes risk_factors array and summary in response", async () => {
    mockCheckToken.mockResolvedValue(
      makeResult({
        risk_factors: ["active mint authority", "no liquidity detected"],
        summary: "active mint authority, no liquidity detected",
      }),
    );
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.body.risk_factors).toEqual([
      "active mint authority",
      "no liquidity detected",
    ]);
    expect(res.body.summary).toBe(
      "active mint authority, no liquidity detected",
    );
  });

  it("sets X-Cache: MISS on fresh result", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.headers["x-cache"]).toBe("MISS");
  });

  it("sets X-Cache: HIT when fromCache is true", async () => {
    mockCheckToken.mockResolvedValue({ ...makeResult(), fromCache: true });
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.headers["x-cache"]).toBe("HIT");
  });

  it("returns 400 for missing mint param", async () => {
    const res = await request(app).get("/v1/check");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_REQUIRED_PARAM");
  });

  it("returns 400 for invalid mint address", async () => {
    const { ApiError } = await import("../src/utils/errors.js");
    mockCheckToken.mockRejectedValue(
      new ApiError(
        "INVALID_MINT_ADDRESS",
        "Invalid Solana mint address: notbase58",
      ),
    );
    const res = await request(app).get("/v1/check?mint=notbase58");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_MINT_ADDRESS");
  });

  it("returns 503 for RPC errors", async () => {
    const { ApiError } = await import("../src/utils/errors.js");
    mockCheckToken.mockRejectedValue(
      new ApiError("RPC_ERROR", "Failed to fetch mint account from RPC"),
    );
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("RPC_ERROR");
  });

  it("returns 500 for unexpected errors", async () => {
    mockCheckToken.mockRejectedValue(new Error("kaboom"));
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("returns changes: null and alerts: [] on first check", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.body.changes).toBeNull();
    expect(res.body.alerts).toEqual([]);
  });

  it("passes through changes and alerts from checkToken", async () => {
    const changes = {
      previous_checked_at: "2026-02-27T00:00:00.000Z",
      risk_score_delta: 15,
      previous_risk_score: 15,
      previous_risk_level: "LOW",
      changed_fields: [],
    };
    const alerts = [
      {
        mint: WSOL,
        symbol: "SOL",
        severity: "HIGH",
        message: "Risk score increased from 15 to 30",
      },
    ];
    mockCheckToken.mockResolvedValue(makeResult({ changes, alerts } as any));
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.body.changes).toEqual(changes);
    expect(res.body.alerts).toEqual(alerts);
  });
});

describe("GET /v1/check/lite", () => {
  it("returns 200 with lite result for valid mint", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLiteResult());
    const res = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    expect(res.status).toBe(200);
    expect(res.body.mint).toBe(WSOL);
    expect(res.body.risk_score).toBe(15);
    expect(res.body.risk_level).toBe("LOW");
    expect(res.body.summary).toBeDefined();
    expect(res.body.full_report.url).toContain("/v1/check");
    expect(res.body.full_report.price_usd).toBe("$0.008");
    expect(res.body.full_report.payment_protocol).toBe("x402");
  });

  it("does not include detailed checks in lite response", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLiteResult());
    const res = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    expect(res.body.checks).toBeUndefined();
    expect(res.body.name).toBe("Wrapped SOL");
    expect(res.body.symbol).toBe("SOL");
  });

  it("returns 400 for missing mint param", async () => {
    const res = await request(app).get("/v1/check/lite");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_REQUIRED_PARAM");
  });

  it("returns 400 for invalid base58 mint without calling analysis", async () => {
    const res = await request(app).get(
      "/v1/check/lite?mint=not-a-real-mint!!!",
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_MINT_ADDRESS");
    // The key assertion: checkTokenLite should never be called for garbage input
    expect(mockCheckTokenLite).not.toHaveBeenCalled();
  });

  it("is rate limited more tightly than paid endpoint", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLiteResult());
    // LITE_RATE_LIMIT_PER_MINUTE defaults to 10 in test
    const requests = Array.from({ length: 12 }, () =>
      request(app).get(`/v1/check/lite?mint=${WSOL}`),
    );
    const responses = await Promise.all(requests);
    const rateLimited = responses.filter((r) => r.status === 429);
    expect(rateLimited.length).toBeGreaterThan(0);
  });
});

describe("404 handler", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await request(app).get("/no-such-route");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 for removed batch endpoint", async () => {
    const res = await request(app).get(`/v1/batch?mints=${WSOL}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for removed monitor endpoint", async () => {
    const res = await request(app).get(`/v1/monitor?mints=${WSOL}`);
    expect(res.status).toBe(404);
  });
});
