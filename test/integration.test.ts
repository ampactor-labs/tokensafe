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

// Mock monitorTokens — boundary between HTTP layer and monitor orchestrator
vi.mock("../src/analysis/monitor.js", () => ({
  monitorTokens: vi.fn(),
}));

import { app } from "../src/app.js";
import { checkToken, checkTokenLite } from "../src/analysis/token-checker.js";
import { monitorTokens } from "../src/analysis/monitor.js";
import { clearCache } from "../src/utils/cache.js";
import { clearRateLimitBuckets } from "../src/utils/rate-limit.js";
import { clearMonitorCache } from "../src/utils/monitor-cache.js";
import type { MonitorResponse } from "../src/analysis/monitor.js";

const mockCheckToken = vi.mocked(checkToken);
const mockCheckTokenLite = vi.mocked(checkTokenLite);
const mockMonitorTokens = vi.mocked(monitorTokens);

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
        risk: "SAFE",
      },
      metadata: null,
      honeypot: null,
      token_age_hours: 8760,
      is_token_2022: false,
      token_2022_extensions: null,
    },
    ...overrides,
  };
  return { result, fromCache: false };
}

function makeLiteResult(overrides?: Partial<TokenCheckLiteResult>): CheckTokenLiteResponse {
  const result: TokenCheckLiteResult = {
    mint: WSOL,
    risk_score: 15,
    risk_level: "LOW",
    summary: "No risk factors detected",
    full_report: "Pay $0.015 via x402 at GET /v1/check?mint=" + WSOL + " for the full detailed analysis",
    ...overrides,
  };
  return { result, fromCache: false };
}

beforeEach(() => {
  mockCheckToken.mockReset();
  mockCheckTokenLite.mockReset();
  mockMonitorTokens.mockReset();
  clearCache();
  clearMonitorCache();
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
      monitorCache: {
        size: expect.any(Number),
        maxSize: 5000,
        hits: expect.any(Number),
        misses: expect.any(Number),
        hitRate: expect.any(String),
      },
    });
    expect(res.body).toHaveProperty("network");
    expect(res.body).toHaveProperty("uptime");
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
    expect(res.body.error.code).toBe("INVALID_MINT_ADDRESS");
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
    expect(res.body.full_report).toContain("/v1/check");
  });

  it("does not include detailed checks in lite response", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLiteResult());
    const res = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    expect(res.body.checks).toBeUndefined();
    expect(res.body.name).toBeUndefined();
    expect(res.body.symbol).toBeUndefined();
  });

  it("returns 400 for missing mint param", async () => {
    const res = await request(app).get("/v1/check/lite");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_MINT_ADDRESS");
  });

  it("returns 400 for invalid base58 mint without calling analysis", async () => {
    const res = await request(app).get("/v1/check/lite?mint=not-a-real-mint!!!");
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

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function makeMonitorResponse(
  overrides?: Partial<MonitorResponse>,
): MonitorResponse {
  return {
    monitored_at: "2026-02-27T00:00:00.000Z",
    token_count: 1,
    tokens: [
      {
        mint: WSOL,
        name: "Wrapped SOL",
        symbol: "SOL",
        checked_at: "2026-02-27T00:00:00.000Z",
        cached_at: null,
        risk_score: 15,
        risk_level: "LOW",
        checks: makeResult().result.checks,
        changes: null,
      },
    ],
    alerts: [],
    errors: [],
    ...overrides,
  };
}

describe("GET /v1/monitor", () => {
  it("returns 200 with monitor results for single mint", async () => {
    mockMonitorTokens.mockResolvedValue(makeMonitorResponse());
    const res = await request(app).get(`/v1/monitor?mints=${WSOL}`);
    expect(res.status).toBe(200);
    expect(res.body.token_count).toBe(1);
    expect(res.body.tokens).toHaveLength(1);
    expect(res.body.tokens[0].mint).toBe(WSOL);
    expect(res.body.alerts).toEqual([]);
    expect(res.body.errors).toEqual([]);
  });

  it("returns 200 for comma-separated mints", async () => {
    const multiResponse = makeMonitorResponse({
      token_count: 2,
      tokens: [
        {
          mint: WSOL,
          name: "Wrapped SOL",
          symbol: "SOL",
          checked_at: "2026-02-27T00:00:00.000Z",
          cached_at: null,
          risk_score: 15,
          risk_level: "LOW",
          checks: makeResult().result.checks,
          changes: null,
        },
        {
          mint: BONK,
          name: "Bonk",
          symbol: "BONK",
          checked_at: "2026-02-27T00:00:00.000Z",
          cached_at: null,
          risk_score: 20,
          risk_level: "LOW",
          checks: makeResult().result.checks,
          changes: null,
        },
      ],
    });
    mockMonitorTokens.mockResolvedValue(multiResponse);
    const res = await request(app).get(
      `/v1/monitor?mints=${WSOL},${BONK}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.token_count).toBe(2);
    expect(res.body.tokens).toHaveLength(2);
  });

  it("returns 400 for missing mints param", async () => {
    const res = await request(app).get("/v1/monitor");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_MINT_ADDRESS");
  });

  it("returns 400 for empty mints param", async () => {
    const res = await request(app).get("/v1/monitor?mints=");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_MINT_ADDRESS");
  });

  it("returns 400 for more than 10 mints", async () => {
    // Need 11 unique mints to survive deduplication
    const baseMints = [
      WSOL,
      BONK,
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
      "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj",
      "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
      "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
      "AFbX8oGjGpmVFywbVouvhQSRmiW2aR1mohfahi4Y2AdB",
      "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E",
    ];
    const res = await request(app).get(
      `/v1/monitor?mints=${baseMints.join(",")}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TOO_MANY_MINTS");
  });

  it("deduplicates repeated mints before sending to monitor", async () => {
    mockMonitorTokens.mockResolvedValue(makeMonitorResponse());
    await request(app).get(`/v1/monitor?mints=${WSOL},${WSOL},${WSOL}`);
    // monitorTokens should receive deduplicated array
    expect(mockMonitorTokens).toHaveBeenCalledWith([WSOL]);
  });

  it("response has correct shape", async () => {
    mockMonitorTokens.mockResolvedValue(makeMonitorResponse());
    const res = await request(app).get(`/v1/monitor?mints=${WSOL}`);
    expect(res.body).toHaveProperty("monitored_at");
    expect(res.body).toHaveProperty("token_count");
    expect(res.body).toHaveProperty("tokens");
    expect(res.body).toHaveProperty("alerts");
    expect(res.body).toHaveProperty("errors");
  });

  it("returns alerts when changes detected", async () => {
    const withAlerts = makeMonitorResponse({
      alerts: [
        {
          mint: WSOL,
          symbol: "SOL",
          severity: "CRITICAL",
          message: "Mint authority changed from RENOUNCED to ACTIVE",
        },
      ],
    });
    mockMonitorTokens.mockResolvedValue(withAlerts);
    const res = await request(app).get(`/v1/monitor?mints=${WSOL}`);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0].severity).toBe("CRITICAL");
  });

  it("includes partial results + errors when a token fails", async () => {
    const partial = makeMonitorResponse({
      errors: [
        {
          mint: BONK,
          error: { code: "RPC_ERROR", message: "Failed to fetch" },
        },
      ],
    });
    mockMonitorTokens.mockResolvedValue(partial);
    const res = await request(app).get(
      `/v1/monitor?mints=${WSOL},${BONK}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.tokens).toHaveLength(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].mint).toBe(BONK);
  });

  it("passes validation error from monitorTokens", async () => {
    const { ApiError } = await import("../src/utils/errors.js");
    mockMonitorTokens.mockRejectedValue(
      new ApiError("INVALID_MINT_ADDRESS", "Invalid Solana mint address: bad"),
    );
    const res = await request(app).get("/v1/monitor?mints=bad");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_MINT_ADDRESS");
  });
});

describe("404 handler", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await request(app).get("/no-such-route");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
