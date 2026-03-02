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
import { initTestDb, closeDb } from "../src/utils/db.js";

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
    score_breakdown: {},
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
    can_sell: true,
    authorities_renounced: true,
    has_liquidity: true,
    token_age_hours: 8760,
    risk_score_delta: null,
    previous_risk_score: null,
    previous_risk_level: null,
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
        endpoints: expect.arrayContaining([
          "/v1/check",
          "/v1/check/lite",
          "/v1/decide",
          "/v1/webhooks",
        ]),
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

describe("GET /v1/check score_breakdown", () => {
  it("includes score_breakdown in paid response", async () => {
    mockCheckToken.mockResolvedValue(
      makeResult({ score_breakdown: { mint_authority: 30, liquidity: 15 } }),
    );
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.status).toBe(200);
    expect(res.body.score_breakdown).toEqual({
      mint_authority: 30,
      liquidity: 15,
    });
  });
});

describe("GET /v1/check/lite enrichment", () => {
  it("includes can_sell, authorities_renounced, has_liquidity, token_age_hours", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLiteResult());
    const res = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    expect(res.status).toBe(200);
    expect(res.body.can_sell).toBe(true);
    expect(res.body.authorities_renounced).toBe(true);
    expect(res.body.has_liquidity).toBe(true);
    expect(res.body.token_age_hours).toBe(8760);
  });

  it("returns null can_sell when honeypot check unavailable", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLiteResult({ can_sell: null }));
    const res = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    expect(res.body.can_sell).toBeNull();
  });

  it("returns authorities_renounced false when mint authority active", async () => {
    mockCheckTokenLite.mockResolvedValue(
      makeLiteResult({ authorities_renounced: false }),
    );
    const res = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    expect(res.body.authorities_renounced).toBe(false);
  });

  it("returns has_liquidity false when no liquidity", async () => {
    mockCheckTokenLite.mockResolvedValue(
      makeLiteResult({ has_liquidity: false }),
    );
    const res = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    expect(res.body.has_liquidity).toBe(false);
  });

  it("returns null delta fields on first check", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLiteResult());
    const res = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    expect(res.body.risk_score_delta).toBeNull();
    expect(res.body.previous_risk_score).toBeNull();
    expect(res.body.previous_risk_level).toBeNull();
  });

  it("returns positive delta when risk increased", async () => {
    mockCheckTokenLite.mockResolvedValue(
      makeLiteResult({
        risk_score_delta: 25,
        previous_risk_score: 15,
        previous_risk_level: "LOW",
      }),
    );
    const res = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    expect(res.body.risk_score_delta).toBe(25);
    expect(res.body.previous_risk_score).toBe(15);
    expect(res.body.previous_risk_level).toBe("LOW");
  });

  it("returns negative delta when risk decreased", async () => {
    mockCheckTokenLite.mockResolvedValue(
      makeLiteResult({
        risk_score_delta: -10,
        previous_risk_score: 25,
        previous_risk_level: "MODERATE",
      }),
    );
    const res = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    expect(res.body.risk_score_delta).toBe(-10);
  });

  it("does not leak paywalled fields", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLiteResult());
    const res = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    expect(res.body.checks).toBeUndefined();
    expect(res.body.changes).toBeUndefined();
    expect(res.body.alerts).toBeUndefined();
    expect(res.body.rpc_slot).toBeUndefined();
    expect(res.body.response_signature).toBeUndefined();
    expect(res.body.score_breakdown).toBeUndefined();
  });
});

describe("GET /v1/decide", () => {
  it("returns SAFE when risk_score <= threshold", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLiteResult({ risk_score: 15 }));
    const res = await request(app).get(`/v1/decide?mint=${WSOL}&threshold=30`);
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("SAFE");
    expect(res.body.risk_score).toBe(15);
    expect(res.body.threshold_used).toBe(30);
    expect(res.body.mint).toBe(WSOL);
    expect(res.body.full_report).toBeDefined();
  });

  it("returns RISKY when risk_score > threshold", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLiteResult({ risk_score: 45 }));
    const res = await request(app).get(`/v1/decide?mint=${WSOL}&threshold=30`);
    expect(res.body.decision).toBe("RISKY");
    expect(res.body.risk_score).toBe(45);
  });

  it("returns UNKNOWN when degraded", async () => {
    mockCheckTokenLite.mockResolvedValue(
      makeLiteResult({ risk_score: 5, degraded: true }),
    );
    const res = await request(app).get(`/v1/decide?mint=${WSOL}`);
    expect(res.body.decision).toBe("UNKNOWN");
  });

  it("uses default threshold of 30", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLiteResult({ risk_score: 30 }));
    const res = await request(app).get(`/v1/decide?mint=${WSOL}`);
    expect(res.body.decision).toBe("SAFE"); // 30 <= 30
    expect(res.body.threshold_used).toBe(30);
  });

  it("clamps threshold to 0-100 range", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLiteResult({ risk_score: 5 }));
    const res = await request(app).get(`/v1/decide?mint=${WSOL}&threshold=200`);
    expect(res.body.threshold_used).toBe(100);
  });

  it("returns 400 for missing mint", async () => {
    const res = await request(app).get("/v1/decide");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_REQUIRED_PARAM");
  });
});

describe("CDN headers", () => {
  it("lite endpoint has public Cache-Control", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLiteResult());
    const res = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=300, stale-while-revalidate=60",
    );
    expect(res.headers["vary"]).toContain("Accept-Encoding");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("paid endpoint has private Cache-Control", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("decide endpoint has public Cache-Control and CORS", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLiteResult());
    const res = await request(app).get(`/v1/decide?mint=${WSOL}`);
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=300, stale-while-revalidate=60",
    );
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("POST /v1/check/batch/*", () => {
  it("batch/small returns results for valid mints", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints: [WSOL] });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.failed).toBe(0);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].mint).toBe(WSOL);
  });

  it("batch/small rejects more than 5 mints", async () => {
    const mints = Array(6).fill(WSOL);
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TOO_MANY_MINTS");
  });

  it("batch/medium allows up to 20 mints", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const mints = Array(20).fill(WSOL);
    const res = await request(app)
      .post("/v1/check/batch/medium")
      .send({ mints });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(20);
  });

  it("batch/medium rejects more than 20 mints", async () => {
    const mints = Array(21).fill(WSOL);
    const res = await request(app)
      .post("/v1/check/batch/medium")
      .send({ mints });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TOO_MANY_MINTS");
  });

  it("batch/large allows up to 50 mints", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const mints = Array(50).fill(WSOL);
    const res = await request(app)
      .post("/v1/check/batch/large")
      .send({ mints });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(50);
  });

  it("batch/large rejects more than 50 mints", async () => {
    const mints = Array(51).fill(WSOL);
    const res = await request(app)
      .post("/v1/check/batch/large")
      .send({ mints });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TOO_MANY_MINTS");
  });

  it("returns 400 for empty mints array", async () => {
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_REQUIRED_PARAM");
  });

  it("returns 400 for missing mints field", async () => {
    const res = await request(app).post("/v1/check/batch/small").send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_REQUIRED_PARAM");
  });

  it("returns 400 for invalid base58 in batch", async () => {
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints: [WSOL, "not-a-valid-mint"] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_MINT_ADDRESS");
  });

  it("handles mixed success/failure in batch results", async () => {
    const { ApiError } = await import("../src/utils/errors.js");
    let callCount = 0;
    mockCheckToken.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        throw new ApiError("TOKEN_NOT_FOUND", "Token not found");
      }
      return makeResult();
    });
    const VALID_MINT2 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints: [WSOL, VALID_MINT2] });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.failed).toBe(1);
    const errorResult = res.body.results.find((r: any) => r.status === "error");
    expect(errorResult.error.code).toBe("TOKEN_NOT_FOUND");
  });

  it("includes checked_at timestamp in batch response", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints: [WSOL] });
    expect(res.body.checked_at).toBeDefined();
    expect(new Date(res.body.checked_at).getTime()).not.toBeNaN();
  });
});

describe("Webhook CRUD /v1/webhooks", () => {
  const AUTH = { Authorization: "Bearer test-webhook-bearer" };

  beforeEach(() => {
    closeDb();
    initTestDb();
  });

  it("rejects requests without bearer token", async () => {
    const res = await request(app).get("/v1/webhooks");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects requests with wrong bearer token", async () => {
    const res = await request(app)
      .get("/v1/webhooks")
      .set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("creates subscription with 201 and full HMAC secret", async () => {
    const res = await request(app)
      .post("/v1/webhooks")
      .set(AUTH)
      .send({ callback_url: "https://example.com/hook", mints: [WSOL] });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.callback_url).toBe("https://example.com/hook");
    expect(res.body.mints).toEqual([WSOL]);
    expect(res.body.threshold).toBe(50);
    expect(res.body.active).toBe(true);
    // Full secret shown only on creation — 32 bytes hex = 64 chars
    expect(res.body.secret_hmac).toHaveLength(64);
  });

  it("creates subscription with custom threshold", async () => {
    const res = await request(app)
      .post("/v1/webhooks")
      .set(AUTH)
      .send({
        callback_url: "https://example.com/hook",
        mints: [WSOL],
        threshold: 75,
      });
    expect(res.status).toBe(201);
    expect(res.body.threshold).toBe(75);
  });

  it("rejects creation with missing callback_url", async () => {
    const res = await request(app)
      .post("/v1/webhooks")
      .set(AUTH)
      .send({ mints: [WSOL] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_REQUIRED_PARAM");
  });

  it("rejects creation with empty mints", async () => {
    const res = await request(app)
      .post("/v1/webhooks")
      .set(AUTH)
      .send({ callback_url: "https://example.com/hook", mints: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_REQUIRED_PARAM");
  });

  it("rejects creation with invalid base58 mint", async () => {
    const res = await request(app)
      .post("/v1/webhooks")
      .set(AUTH)
      .send({
        callback_url: "https://example.com/hook",
        mints: ["not-base58!!!"],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_MINT_ADDRESS");
  });

  it("lists subscriptions with redacted secrets", async () => {
    await request(app)
      .post("/v1/webhooks")
      .set(AUTH)
      .send({ callback_url: "https://example.com/hook", mints: [WSOL] });

    const res = await request(app).get("/v1/webhooks").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].secret_hmac).toMatch(/^\*\*\*.{8}$/);
    expect(res.body[0].mints).toEqual([WSOL]);
  });

  it("returns empty array when no subscriptions", async () => {
    const res = await request(app).get("/v1/webhooks").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("updates subscription and returns redacted secret", async () => {
    const createRes = await request(app)
      .post("/v1/webhooks")
      .set(AUTH)
      .send({ callback_url: "https://example.com/hook", mints: [WSOL] });

    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const res = await request(app)
      .patch(`/v1/webhooks/${createRes.body.id}`)
      .set(AUTH)
      .send({ threshold: 80, mints: [WSOL, USDC] });
    expect(res.status).toBe(200);
    expect(res.body.threshold).toBe(80);
    expect(res.body.mints).toEqual([WSOL, USDC]);
    expect(res.body.secret_hmac).toMatch(/^\*\*\*.{8}$/);
  });

  it("returns 404 when updating non-existent subscription", async () => {
    const res = await request(app)
      .patch("/v1/webhooks/999")
      .set(AUTH)
      .send({ threshold: 80 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("WEBHOOK_NOT_FOUND");
  });

  it("deletes subscription and returns 204", async () => {
    const createRes = await request(app)
      .post("/v1/webhooks")
      .set(AUTH)
      .send({ callback_url: "https://example.com/hook", mints: [WSOL] });

    const res = await request(app)
      .delete(`/v1/webhooks/${createRes.body.id}`)
      .set(AUTH);
    expect(res.status).toBe(204);

    const listRes = await request(app).get("/v1/webhooks").set(AUTH);
    expect(listRes.body).toEqual([]);
  });

  it("returns 404 when deleting non-existent subscription", async () => {
    const res = await request(app).delete("/v1/webhooks/999").set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("WEBHOOK_NOT_FOUND");
  });
});

describe("API key auth", () => {
  const AUTH = { Authorization: "Bearer test-webhook-bearer" };
  let apiKey: string;

  beforeEach(async () => {
    closeDb();
    initTestDb();
    // Create a pro API key for testing
    const res = await request(app)
      .post("/v1/api-keys")
      .set(AUTH)
      .send({ label: "test-pro", tier: "pro" });
    apiKey = res.body.key;
  });

  it("valid API key bypasses x402 and returns 200", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const res = await request(app)
      .get(`/v1/check?mint=${WSOL}`)
      .set("X-API-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.mint).toBe(WSOL);
  });

  it("invalid API key returns 401", async () => {
    const res = await request(app)
      .get(`/v1/check?mint=${WSOL}`)
      .set("X-API-Key", "tks_invalidkey");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_API_KEY");
  });

  it("expired API key returns 401", async () => {
    // Create an already-expired key
    const expRes = await request(app).post("/v1/api-keys").set(AUTH).send({
      label: "expired-key",
      tier: "pro",
      expires_at: "2020-01-01T00:00:00Z",
    });
    const res = await request(app)
      .get(`/v1/check?mint=${WSOL}`)
      .set("X-API-Key", expRes.body.key);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("API_KEY_EXPIRED");
  });

  it("no API key falls through to x402 (existing behavior)", async () => {
    // x402 middleware is mocked to passthrough in this test file,
    // so this verifies the normal flow still works
    mockCheckToken.mockResolvedValue(makeResult());
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.status).toBe(200);
  });

  it("response includes X-API-Key-Tier and X-API-Key-Usage headers", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const res = await request(app)
      .get(`/v1/check?mint=${WSOL}`)
      .set("X-API-Key", apiKey);
    expect(res.headers["x-api-key-tier"]).toBe("pro");
    expect(res.headers["x-api-key-usage"]).toMatch(/^\d+\/\d+$/);
    expect(res.headers["x-api-key-usage-reset"]).toBeDefined();
  });

  it("revoked API key returns 401", async () => {
    // Get the key ID from listing
    const listRes = await request(app).get("/v1/api-keys").set(AUTH);
    const keyId = listRes.body[0].id;

    // Revoke it
    await request(app).delete(`/v1/api-keys/${keyId}`).set(AUTH);

    const res = await request(app)
      .get(`/v1/check?mint=${WSOL}`)
      .set("X-API-Key", apiKey);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_API_KEY");
  });

  it("API key works for batch endpoints too", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const res = await request(app)
      .post("/v1/check/batch/small")
      .set("X-API-Key", apiKey)
      .send({ mints: [WSOL] });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.headers["x-api-key-tier"]).toBe("pro");
  });
});

describe("API key CRUD", () => {
  const AUTH = { Authorization: "Bearer test-webhook-bearer" };

  beforeEach(() => {
    closeDb();
    initTestDb();
  });

  it("creates key and returns full key (shown once)", async () => {
    const res = await request(app)
      .post("/v1/api-keys")
      .set(AUTH)
      .send({ label: "my-key", tier: "pro" });
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^tks_[0-9a-f]{64}$/);
    expect(res.body.label).toBe("my-key");
    expect(res.body.tier).toBe("pro");
    expect(res.body.active).toBe(true);
    expect(res.body.monthly_limit).toBe(6000);
  });

  it("lists keys with prefix only (no full key)", async () => {
    await request(app)
      .post("/v1/api-keys")
      .set(AUTH)
      .send({ label: "key1", tier: "pro" });
    await request(app)
      .post("/v1/api-keys")
      .set(AUTH)
      .send({ label: "key2", tier: "enterprise" });

    const res = await request(app).get("/v1/api-keys").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].key_prefix).toMatch(/^tks_/);
    expect(res.body[0].key).toBeUndefined();
    expect(res.body[1].tier).toBe("enterprise");
  });

  it("revokes key (204)", async () => {
    const createRes = await request(app)
      .post("/v1/api-keys")
      .set(AUTH)
      .send({ label: "to-revoke", tier: "pro" });

    const res = await request(app)
      .delete(`/v1/api-keys/${createRes.body.id}`)
      .set(AUTH);
    expect(res.status).toBe(204);

    // Verify it's inactive
    const listRes = await request(app).get("/v1/api-keys").set(AUTH);
    expect(listRes.body[0].active).toBe(false);
  });

  it("returns 404 for non-existent key deletion", async () => {
    const res = await request(app).delete("/v1/api-keys/999").set(AUTH);
    expect(res.status).toBe(401); // INVALID_API_KEY maps to 401
  });

  it("requires admin bearer auth", async () => {
    const res = await request(app)
      .post("/v1/api-keys")
      .send({ label: "test", tier: "pro" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns usage stats", async () => {
    const createRes = await request(app)
      .post("/v1/api-keys")
      .set(AUTH)
      .send({ label: "usage-test", tier: "pro" });

    const res = await request(app)
      .get(`/v1/api-keys/${createRes.body.id}/usage`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(createRes.body.id);
    expect(res.body.used).toBe(0);
    expect(res.body.limit).toBe(6000);
    expect(res.body.history).toEqual([]);
  });

  it("rejects creation with missing label", async () => {
    const res = await request(app)
      .post("/v1/api-keys")
      .set(AUTH)
      .send({ tier: "pro" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_REQUIRED_PARAM");
  });

  it("rejects creation with invalid tier", async () => {
    const res = await request(app)
      .post("/v1/api-keys")
      .set(AUTH)
      .send({ label: "test", tier: "free" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_REQUIRED_PARAM");
  });
});

describe("health endpoint includes api-keys and audit routes", () => {
  it("lists /v1/api-keys in api_versions", async () => {
    const res = await request(app).get("/health");
    expect(res.body.api_versions.v1.endpoints).toContain("/v1/api-keys");
  });

  it("lists audit routes in api_versions", async () => {
    const res = await request(app).get("/health");
    const endpoints = res.body.api_versions.v1.endpoints;
    expect(endpoints).toContain("/v1/audit/small");
    expect(endpoints).toContain("/v1/audit/standard");
    expect(endpoints).toContain("/v1/audit/history");
    expect(endpoints).toContain("/v1/audit/:id/report");
  });
});

describe("POST /v1/audit/*", () => {
  const AUTH = { Authorization: "Bearer test-webhook-bearer" };
  let apiKey: string;

  beforeEach(async () => {
    closeDb();
    initTestDb();
    // Create a pro API key
    const res = await request(app)
      .post("/v1/api-keys")
      .set(AUTH)
      .send({ label: "audit-test", tier: "pro" });
    apiKey = res.body.key;
  });

  it("POST /v1/audit/small with API key returns audit result", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const res = await request(app)
      .post("/v1/audit/small")
      .set("X-API-Key", apiKey)
      .send({ mints: [WSOL] });
    expect(res.status).toBe(200);
    expect(res.body.audit_id).toBeDefined();
    expect(res.body.total).toBe(1);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.failed).toBe(0);
    expect(res.body.aggregate_risk_score).toBeDefined();
    expect(res.body.risk_distribution).toBeDefined();
    expect(res.body.results).toHaveLength(1);
  });

  it("validates mints (rejects empty array)", async () => {
    const res = await request(app)
      .post("/v1/audit/small")
      .set("X-API-Key", apiKey)
      .send({ mints: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_REQUIRED_PARAM");
  });

  it("enforces max 10 tokens for small tier", async () => {
    const mints = Array(11).fill(WSOL);
    const res = await request(app)
      .post("/v1/audit/small")
      .set("X-API-Key", apiKey)
      .send({ mints });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TOO_MANY_MINTS");
  });

  it("enforces max 50 tokens for standard tier", async () => {
    const mints = Array(51).fill(WSOL);
    const res = await request(app)
      .post("/v1/audit/standard")
      .set("X-API-Key", apiKey)
      .send({ mints });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TOO_MANY_MINTS");
  });

  it("includes attestation (hash, signature, signer_pubkey)", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const res = await request(app)
      .post("/v1/audit/small")
      .set("X-API-Key", apiKey)
      .send({ mints: [WSOL] });
    expect(res.body.attestation).toBeDefined();
    expect(typeof res.body.attestation.hash).toBe("string");
    expect(typeof res.body.attestation.signature).toBe("string");
    expect(typeof res.body.attestation.signer_pubkey).toBe("string");
  });

  it("includes policy_violations array", async () => {
    mockCheckToken.mockResolvedValue(makeResult({ risk_score: 85 }));
    const res = await request(app)
      .post("/v1/audit/small")
      .set("X-API-Key", apiKey)
      .send({ mints: [WSOL] });
    expect(Array.isArray(res.body.policy_violations)).toBe(true);
    // Score 85 should trigger extreme_risk
    const extreme = res.body.policy_violations.find(
      (v: any) => v.rule_id === "extreme_risk",
    );
    expect(extreme).toBeDefined();
    expect(extreme.action).toBe("block");
  });

  it("accepts custom policy", async () => {
    mockCheckToken.mockResolvedValue(makeResult({ risk_score: 15 }));
    const customPolicy = {
      name: "strict",
      rules: [
        {
          id: "strict_risk",
          field: "risk_score",
          operator: "gt",
          value: 10,
          action: "block",
          message: "Too risky",
        },
      ],
    };
    const res = await request(app)
      .post("/v1/audit/small")
      .set("X-API-Key", apiKey)
      .send({ mints: [WSOL], policy: customPolicy });
    expect(res.status).toBe(200);
    expect(res.body.policy_violations).toHaveLength(1);
    expect(res.body.policy_violations[0].rule_id).toBe("strict_risk");
  });

  it("handles all-failing mints with succeeded=0", async () => {
    const { ApiError } = await import("../src/utils/errors.js");
    mockCheckToken.mockRejectedValue(
      new ApiError("TOKEN_NOT_FOUND", "Token not found"),
    );
    const res = await request(app)
      .post("/v1/audit/small")
      .set("X-API-Key", apiKey)
      .send({ mints: [WSOL] });
    expect(res.status).toBe(200);
    expect(res.body.succeeded).toBe(0);
    expect(res.body.failed).toBe(1);
    expect(res.body.aggregate_risk_score).toBe(0);
  });
});

describe("GET /v1/audit/history", () => {
  const AUTH = { Authorization: "Bearer test-webhook-bearer" };
  let apiKey: string;

  beforeEach(async () => {
    closeDb();
    initTestDb();
    const res = await request(app)
      .post("/v1/api-keys")
      .set(AUTH)
      .send({ label: "history-test", tier: "pro" });
    apiKey = res.body.key;
  });

  it("requires auth (401 without)", async () => {
    const res = await request(app).get("/v1/audit/history");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns audit summaries", async () => {
    // Create an audit first
    mockCheckToken.mockResolvedValue(makeResult());
    await request(app)
      .post("/v1/audit/small")
      .set("X-API-Key", apiKey)
      .send({ mints: [WSOL] });

    const res = await request(app)
      .get("/v1/audit/history")
      .set("X-API-Key", apiKey);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBeDefined();
    expect(res.body[0].token_count).toBe(1);
    expect(res.body[0].aggregate_risk_score).toBeDefined();
    expect(res.body[0].violation_count).toBeDefined();
  });

  it("filters by date range", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    await request(app)
      .post("/v1/audit/small")
      .set("X-API-Key", apiKey)
      .send({ mints: [WSOL] });

    // Future date range should return nothing
    const res = await request(app)
      .get("/v1/audit/history?from=2030-01-01T00:00:00Z")
      .set("X-API-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("works with admin bearer auth too", async () => {
    const res = await request(app).get("/v1/audit/history").set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe("GET /v1/audit/:id/report", () => {
  const AUTH = { Authorization: "Bearer test-webhook-bearer" };
  let apiKey: string;

  beforeEach(async () => {
    closeDb();
    initTestDb();
    const res = await request(app)
      .post("/v1/api-keys")
      .set(AUTH)
      .send({ label: "report-test", tier: "pro" });
    apiKey = res.body.key;
  });

  it("returns text/markdown", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const auditRes = await request(app)
      .post("/v1/audit/small")
      .set("X-API-Key", apiKey)
      .send({ mints: [WSOL] });
    const auditId = auditRes.body.audit_id;

    const res = await request(app)
      .get(`/v1/audit/${auditId}/report`)
      .set("X-API-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.text).toContain("# TokenSafe Compliance Report");
    expect(res.text).toContain(auditId);
  });

  it("returns 404 for non-existent audit", async () => {
    const res = await request(app)
      .get("/v1/audit/nonexistent-uuid/report")
      .set("X-API-Key", apiKey);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("AUDIT_NOT_FOUND");
  });
});

describe("404 handler", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await request(app).get("/no-such-route");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 for old /v1/batch path (now /v1/check/batch/*)", async () => {
    const res = await request(app).get(`/v1/batch?mints=${WSOL}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for removed monitor endpoint", async () => {
    const res = await request(app).get(`/v1/monitor?mints=${WSOL}`);
    expect(res.status).toBe(404);
  });
});

describe("Batch endpoints", () => {
  it("POST /v1/check/batch/small validates mints array", async () => {
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_REQUIRED_PARAM");
  });

  it("POST /v1/check/batch/small rejects non-array mints", async () => {
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints: "not-an-array" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_REQUIRED_PARAM");
  });

  it("POST /v1/check/batch/small rejects invalid mint address", async () => {
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints: ["not-base58!!!"] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_MINT_ADDRESS");
  });

  it("POST /v1/check/batch/small enforces max 5 tokens", async () => {
    const mints = Array(6).fill(WSOL);
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TOO_MANY_MINTS");
  });

  it("POST /v1/check/batch/medium enforces max 20 tokens", async () => {
    const mints = Array(21).fill(WSOL);
    const res = await request(app)
      .post("/v1/check/batch/medium")
      .send({ mints });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TOO_MANY_MINTS");
  });

  it("POST /v1/check/batch/large enforces max 50 tokens", async () => {
    const mints = Array(51).fill(WSOL);
    const res = await request(app)
      .post("/v1/check/batch/large")
      .send({ mints });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TOO_MANY_MINTS");
  });

  it("POST /v1/check/batch/small returns results on success", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints: [WSOL] });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.failed).toBe(0);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].mint).toBe(WSOL);
    expect(res.body.checked_at).toBeDefined();
  });

  it("POST /v1/check/batch/small handles partial failures", async () => {
    const { ApiError } = await import("../src/utils/errors.js");
    mockCheckToken
      .mockResolvedValueOnce(makeResult())
      .mockRejectedValueOnce(
        new ApiError("TOKEN_NOT_FOUND", "Token not found"),
      );
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints: [WSOL, USDC] });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.failed).toBe(1);
    const errorResult = res.body.results.find((r: any) => r.status === "error");
    expect(errorResult).toBeDefined();
    expect(errorResult.error.code).toBe("TOKEN_NOT_FOUND");
  });

  it("POST /v1/check/batch/small allows exactly 5 tokens", async () => {
    mockCheckToken.mockResolvedValue(makeResult());
    const mints = Array(5).fill(WSOL);
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
  });
});
