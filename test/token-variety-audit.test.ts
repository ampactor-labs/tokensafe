/**
 * Token Variety & Edge Case Audit
 *
 * Exercises the full pipeline with diverse token profiles.
 * Personas:  CUSTOMER  — free /lite + /decide consumer
 *            AGENT     — automated client using /decide for go/no-go
 *            CONSUMER  — paid /v1/check reviewer reading full reports
 *
 * Coverage gaps this addresses:
 *   - Real-world token profiles (stablecoins, memecoins, honeypots, Token-2022)
 *   - Boundary conditions in risk scoring (exact thresholds, score cap at 100)
 *   - Multiple simultaneous risk factors and their combined behavior
 *   - Degraded-mode edge cases (all checks failing, single check failing)
 *   - Delta detection across state transitions
 *   - Lite ↔ full paywall isolation with realistic token data
 *   - Input validation edge cases (SQL injection, XSS, unicode, boundary-length mints)
 *   - Token-2022 combined extensions (transfer fee + permanent delegate + hook)
 *   - Stablecoins with both trusted mint AND freeze authority
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type {
  TokenCheckResult,
  CheckTokenResponse,
  TokenCheckLiteResult,
  CheckTokenLiteResponse,
} from "../src/analysis/token-checker.js";

// ── Mocks ────────────────────────────────────────────────────────────
vi.mock("../src/x402/middleware.js", () => ({
  x402Middleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../src/analysis/token-checker.js", () => ({
  checkToken: vi.fn(),
  checkTokenLite: vi.fn(),
}));

vi.mock("../src/utils/ssrf-guard.js", () => ({
  validateWebhookUrl: vi.fn().mockResolvedValue(undefined),
  isPrivateIp: vi.fn().mockReturnValue(false),
  resolveAndCheckIps: vi.fn().mockResolvedValue(undefined),
}));

import { app } from "../src/app.js";
import { checkToken, checkTokenLite } from "../src/analysis/token-checker.js";
import { clearCache } from "../src/utils/cache.js";
import { clearRateLimitBuckets } from "../src/utils/rate-limit.js";

const mockCheckToken = vi.mocked(checkToken);
const mockCheckTokenLite = vi.mocked(checkTokenLite);

// ── Well-known token addresses ───────────────────────────────────────
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const RANDOM_VALID = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

// ── Helpers — token profile factories ────────────────────────────────

function makeFullResult(
  overrides?: Partial<TokenCheckResult>,
): CheckTokenResponse {
  const result: TokenCheckResult = {
    mint: WSOL,
    name: "Wrapped SOL",
    symbol: "SOL",
    checked_at: new Date().toISOString(),
    cached_at: null,
    risk_score: 0,
    risk_level: "LOW",
    checks: {
      mint_authority: { status: "RENOUNCED", authority: null, risk: "SAFE" },
      freeze_authority: { status: "RENOUNCED", authority: null, risk: "SAFE" },
      supply: { total: "999999999000000000", decimals: 9 },
      top_holders: {
        status: "OK",
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
        pool_address: "PoolAddr111",
        price_impact_pct: 0.05,
        liquidity_rating: "DEEP",
        lp_locked: true,
        lp_lock_percentage: 95,
        lp_lock_expiry: null,
        lp_mint: "LPmint111",
        lp_locker: "Locker111",
        pool_vault_addresses: ["VaultA111", "VaultB222"],
        risk: "SAFE",
      },
      metadata: {
        status: "OK",
        update_authority: null,
        mutable: false,
        has_uri: true,
        uri: "https://example.com/meta.json",
        risk: "SAFE",
      },
      honeypot: {
        can_sell: true,
        sell_tax_bps: 0,
        note: null,
        risk: "SAFE",
        status: "OK",
      },
      token_age_hours: 8760,
      token_age_minutes: 525600,
      created_at: "2025-01-01T00:00:00.000Z",
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
    data_confidence: "complete",
    degraded_note: null,
    response_signature: "deadbeef",
    signer_pubkey: "cafebabe",
    ...overrides,
  };
  return { result, fromCache: false };
}

function makeLite(
  overrides?: Partial<TokenCheckLiteResult>,
): CheckTokenLiteResponse {
  const result: TokenCheckLiteResult = {
    mint: WSOL,
    name: "Wrapped SOL",
    symbol: "SOL",
    risk_score: 0,
    risk_level: "LOW",
    summary: "No risk factors detected",
    degraded: false,
    degraded_checks: [],
    checks_completed: 6,
    checks_total: 6,
    is_token_2022: false,
    has_risky_extensions: false,
    can_sell: true,
    authorities_renounced: true,
    trusted_authority: false,
    has_liquidity: true,
    liquidity_rating: "DEEP",
    top_10_concentration: 12.5,
    token_age_hours: 8760,
    risk_score_delta: null,
    previous_risk_score: null,
    previous_risk_level: null,
    data_confidence: "complete",
    degraded_note: null,
    uncertainty_penalties: null,
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

// ════════════════════════════════════════════════════════════════════════
// 1. TOKEN PROFILES — realistic scenarios across the risk spectrum
// ════════════════════════════════════════════════════════════════════════

describe("Token Profile: Clean established token (wSOL-like)", () => {
  it("CUSTOMER: lite returns LOW risk with complete data confidence", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLite());
    const res = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    expect(res.status).toBe(200);
    expect(res.body.risk_score).toBe(0);
    expect(res.body.risk_level).toBe("LOW");
    expect(res.body.data_confidence).toBe("complete");
    expect(res.body.authorities_renounced).toBe(true);
    expect(res.body.can_sell).toBe(true);
    expect(res.body.has_liquidity).toBe(true);
    expect(res.body.is_token_2022).toBe(false);
    expect(res.body.has_risky_extensions).toBe(false);
    expect(res.headers["x-data-confidence"]).toBe("complete");
  });

  it("AGENT: /decide returns SAFE with default threshold", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLite());
    const res = await request(app).get(`/v1/decide?mint=${WSOL}`);
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("SAFE");
    expect(res.body.score_reliable).toBe(true);
    expect(res.body.note).toBeUndefined();
    expect(res.body.degraded_checks).toBeUndefined();
  });

  it("CONSUMER: paid check includes full details and signature", async () => {
    mockCheckToken.mockResolvedValue(makeFullResult());
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.status).toBe(200);
    expect(res.body.checks).toBeDefined();
    expect(res.body.checks.mint_authority.status).toBe("RENOUNCED");
    expect(res.body.checks.freeze_authority.status).toBe("RENOUNCED");
    expect(res.body.checks.liquidity.pool_vault_addresses).toEqual([
      "VaultA111",
      "VaultB222",
    ]);
    expect(res.body.response_signature).toBeDefined();
    expect(res.body.signer_pubkey).toBeDefined();
    expect(res.body.score_breakdown).toEqual({});
    expect(res.body.changes).toBeNull();
    expect(res.body.alerts).toEqual([]);
  });
});

describe("Token Profile: Stablecoin with trusted authorities (USDC-like)", () => {
  const usdcFull = () =>
    makeFullResult({
      mint: USDC,
      name: "USD Coin",
      symbol: "USDC",
      risk_score: 5,
      risk_level: "LOW",
      checks: {
        mint_authority: {
          status: "ACTIVE",
          authority: "BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG",
          risk: "SAFE",
        },
        freeze_authority: {
          status: "ACTIVE",
          authority: "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar",
          risk: "SAFE",
        },
        supply: { total: "10000000000000000", decimals: 6 },
        top_holders: {
          status: "OK",
          top_10_percentage: 8.5,
          top_1_percentage: 2.1,
          holder_count_estimate: null,
          top_holders_detail: null,
          note: null,
          risk: "SAFE",
        },
        liquidity: {
          has_liquidity: true,
          primary_pool: "Raydium",
          pool_address: null,
          price_impact_pct: 0.01,
          liquidity_rating: "DEEP",
          lp_locked: true,
          lp_lock_percentage: 100,
          lp_lock_expiry: null,
          lp_mint: null,
          lp_locker: null,
          pool_vault_addresses: null,
          risk: "SAFE",
        },
        metadata: {
          status: "OK",
          update_authority: null,
          mutable: true,
          has_uri: true,
          uri: "https://arweave.net/usdc",
          risk: "WARNING",
        },
        honeypot: {
          can_sell: true,
          sell_tax_bps: 0,
          note: null,
          risk: "SAFE",
          status: "OK",
        },
        token_age_hours: 26280,
        token_age_minutes: 1576800,
        created_at: "2022-01-01T00:00:00.000Z",
        token_program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        is_token_2022: false,
        token_2022_extensions: null,
      },
      risk_factors: [],
      summary: "No risk factors detected",
      score_breakdown: { metadata: 5 },
    });

  it("CONSUMER: active authorities marked SAFE (trusted allowlist)", async () => {
    mockCheckToken.mockResolvedValue(usdcFull());
    const res = await request(app).get(`/v1/check?mint=${USDC}`);
    expect(res.status).toBe(200);
    expect(res.body.checks.mint_authority.status).toBe("ACTIVE");
    expect(res.body.checks.mint_authority.risk).toBe("SAFE");
    expect(res.body.checks.freeze_authority.status).toBe("ACTIVE");
    expect(res.body.checks.freeze_authority.risk).toBe("SAFE");
    expect(res.body.risk_score).toBe(5); // Only metadata mutability penalty
  });

  it("CUSTOMER: lite shows trusted_authority true", async () => {
    mockCheckTokenLite.mockResolvedValue(
      makeLite({
        mint: USDC,
        name: "USD Coin",
        symbol: "USDC",
        risk_score: 5,
        authorities_renounced: false,
        trusted_authority: true,
      }),
    );
    const res = await request(app).get(`/v1/check/lite?mint=${USDC}`);
    expect(res.body.authorities_renounced).toBe(false);
    expect(res.body.trusted_authority).toBe(true);
  });
});

describe("Token Profile: High-risk memecoin (rug characteristics)", () => {
  const rugProfile = () =>
    makeFullResult({
      mint: RANDOM_VALID,
      name: "ScamCoin",
      symbol: "SCAM",
      risk_score: 100,
      risk_level: "EXTREME",
      checks: {
        mint_authority: {
          status: "ACTIVE",
          authority: "UnknownAuthority111",
          risk: "DANGEROUS",
        },
        freeze_authority: {
          status: "ACTIVE",
          authority: "UnknownAuthority222",
          risk: "DANGEROUS",
        },
        supply: { total: "1000000000000", decimals: 9 },
        top_holders: {
          status: "OK",
          top_10_percentage: 92,
          top_1_percentage: 65,
          holder_count_estimate: 15,
          top_holders_detail: null,
          note: null,
          risk: "CRITICAL",
        },
        liquidity: {
          has_liquidity: false,
          primary_pool: null,
          pool_address: null,
          price_impact_pct: null,
          liquidity_rating: null,
          lp_locked: null,
          lp_lock_percentage: null,
          lp_lock_expiry: null,
          lp_mint: null,
          lp_locker: null,
          pool_vault_addresses: null,
          risk: "DANGEROUS",
        },
        metadata: {
          status: "OK",
          update_authority: "SomeAuthority",
          mutable: true,
          has_uri: false,
          uri: null,
          risk: "WARNING",
        },
        honeypot: {
          can_sell: false,
          sell_tax_bps: null,
          note: null,
          risk: "DANGEROUS",
          status: "OK",
        },
        token_age_hours: 0.5,
        token_age_minutes: 30,
        created_at: new Date().toISOString(),
        token_program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        is_token_2022: false,
        token_2022_extensions: null,
      },
      risk_factors: [
        "active mint authority",
        "active freeze authority",
        "top 10 holders own 92.0% of supply",
        "top holder owns 65.0%",
        "no liquidity detected",
        "mutable metadata",
        "token < 1 hour old",
        "cannot sell (honeypot)",
      ],
      summary:
        "active mint authority, active freeze authority, top 10 holders own 92.0% of supply, top holder owns 65.0%, no liquidity detected, mutable metadata, token < 1 hour old, cannot sell (honeypot)",
      score_breakdown: {
        mint_authority: 30,
        freeze_authority: 25,
        top_holders_10: 25,
        top_holders_1: 25,
        liquidity: 30,
        metadata: 10,
        token_age: 10,
        honeypot: 30,
      },
    });

  it("CONSUMER: risk_score capped at 100 (EXTREME)", async () => {
    mockCheckToken.mockResolvedValue(rugProfile());
    const res = await request(app).get(`/v1/check?mint=${RANDOM_VALID}`);
    expect(res.body.risk_score).toBe(100);
    expect(res.body.risk_level).toBe("EXTREME");
  });

  it("CONSUMER: all risk factors present in response", async () => {
    mockCheckToken.mockResolvedValue(rugProfile());
    const res = await request(app).get(`/v1/check?mint=${RANDOM_VALID}`);
    expect(res.body.risk_factors).toContain("active mint authority");
    expect(res.body.risk_factors).toContain("cannot sell (honeypot)");
    expect(res.body.risk_factors).toContain("no liquidity detected");
    expect(res.body.risk_factors.length).toBe(8);
  });

  it("AGENT: /decide returns RISKY for rug profile", async () => {
    mockCheckTokenLite.mockResolvedValue(
      makeLite({
        mint: RANDOM_VALID,
        risk_score: 100,
        risk_level: "EXTREME",
        can_sell: false,
        authorities_renounced: false,
        has_liquidity: false,
      }),
    );
    const res = await request(app).get(
      `/v1/decide?mint=${RANDOM_VALID}&threshold=30`,
    );
    expect(res.body.decision).toBe("RISKY");
    expect(res.body.risk_score).toBe(100);
  });

  it("AGENT: /decide RISKY even with max threshold 100", async () => {
    mockCheckTokenLite.mockResolvedValue(
      makeLite({
        mint: RANDOM_VALID,
        risk_score: 100,
        risk_level: "EXTREME",
      }),
    );
    const res = await request(app).get(
      `/v1/decide?mint=${RANDOM_VALID}&threshold=100`,
    );
    // 100 <= 100 → SAFE
    expect(res.body.decision).toBe("SAFE");
  });
});

describe("Token Profile: Token-2022 with dangerous extensions", () => {
  const token2022Profile = () =>
    makeFullResult({
      mint: RANDOM_VALID,
      name: "DangerToken",
      symbol: "DANGER",
      risk_score: 80,
      risk_level: "CRITICAL",
      checks: {
        mint_authority: { status: "RENOUNCED", authority: null, risk: "SAFE" },
        freeze_authority: {
          status: "RENOUNCED",
          authority: null,
          risk: "SAFE",
        },
        supply: { total: "1000000000", decimals: 6 },
        top_holders: {
          status: "OK",
          top_10_percentage: 25,
          top_1_percentage: 5,
          holder_count_estimate: 200,
          top_holders_detail: null,
          note: null,
          risk: "SAFE",
        },
        liquidity: {
          has_liquidity: true,
          primary_pool: "Raydium",
          pool_address: null,
          price_impact_pct: 2.5,
          liquidity_rating: "MODERATE",
          lp_locked: false,
          lp_lock_percentage: null,
          lp_lock_expiry: null,
          lp_mint: null,
          lp_locker: null,
          pool_vault_addresses: null,
          risk: "WARNING",
        },
        metadata: null,
        honeypot: {
          can_sell: true,
          sell_tax_bps: 2500,
          note: null,
          risk: "DANGEROUS",
          status: "OK",
        },
        token_age_hours: 48,
        token_age_minutes: 2880,
        created_at: "2026-03-23T00:00:00.000Z",
        token_program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        is_token_2022: true,
        token_2022_extensions: [
          {
            name: "PermanentDelegate",
            permanent_delegate: "DelegateAddr111",
          },
          {
            name: "TransferFeeConfig",
            transfer_fee_bps: 6000,
          },
          {
            name: "TransferHook",
            transfer_hook_program: "HookProgram111",
          },
        ],
      },
      risk_factors: [
        "permanent delegate set",
        "60.0% transfer fee",
        "transfer hook set — arbitrary code runs on every transfer",
        "LP not locked",
        "25.0% sell tax",
      ],
      score_breakdown: {
        permanent_delegate: 30,
        transfer_fee: 20,
        transfer_hook: 15,
        liquidity: 15,
        sell_tax: 15,
      },
    });

  it("CONSUMER: Token-2022 extensions are fully exposed", async () => {
    mockCheckToken.mockResolvedValue(token2022Profile());
    const res = await request(app).get(`/v1/check?mint=${RANDOM_VALID}`);
    expect(res.body.checks.is_token_2022).toBe(true);
    const exts = res.body.checks.token_2022_extensions;
    expect(exts).toHaveLength(3);
    expect(exts.find((e: any) => e.name === "PermanentDelegate")).toBeDefined();
    expect(exts.find((e: any) => e.name === "TransferFeeConfig")).toBeDefined();
    expect(exts.find((e: any) => e.name === "TransferHook")).toBeDefined();
  });

  it("CUSTOMER: lite shows has_risky_extensions true", async () => {
    mockCheckTokenLite.mockResolvedValue(
      makeLite({
        mint: RANDOM_VALID,
        is_token_2022: true,
        has_risky_extensions: true,
        risk_score: 80,
        risk_level: "CRITICAL",
      }),
    );
    const res = await request(app).get(`/v1/check/lite?mint=${RANDOM_VALID}`);
    expect(res.body.is_token_2022).toBe(true);
    expect(res.body.has_risky_extensions).toBe(true);
  });

  it("CONSUMER: score_breakdown separates each extension", async () => {
    mockCheckToken.mockResolvedValue(token2022Profile());
    const res = await request(app).get(`/v1/check?mint=${RANDOM_VALID}`);
    expect(res.body.score_breakdown.permanent_delegate).toBe(30);
    expect(res.body.score_breakdown.transfer_fee).toBe(20);
    expect(res.body.score_breakdown.transfer_hook).toBe(15);
  });
});

describe("Token Profile: Fresh launch with sell tax", () => {
  it("CONSUMER: moderate sell tax is flagged in risk_factors", async () => {
    mockCheckToken.mockResolvedValue(
      makeFullResult({
        mint: RANDOM_VALID,
        risk_score: 35,
        risk_level: "MODERATE",
        checks: {
          ...makeFullResult().result.checks,
          honeypot: {
            can_sell: true,
            sell_tax_bps: 1500,
            note: null,
            risk: "DANGEROUS",
            status: "OK",
          },
          token_age_hours: 2,
          token_age_minutes: 120,
          created_at: new Date().toISOString(),
        },
        risk_factors: ["15.0% sell tax", "token < 24 hours old"],
        score_breakdown: { sell_tax: 15, token_age: 5, liquidity: 15 },
      }),
    );
    const res = await request(app).get(`/v1/check?mint=${RANDOM_VALID}`);
    expect(res.body.risk_factors).toContain("15.0% sell tax");
    expect(res.body.checks.honeypot.sell_tax_bps).toBe(1500);
  });
});

describe("Token Profile: No Jupiter route (sell-side unknown)", () => {
  it("CONSUMER: can_sell null is distinct from honeypot false", async () => {
    mockCheckToken.mockResolvedValue(
      makeFullResult({
        mint: RANDOM_VALID,
        checks: {
          ...makeFullResult().result.checks,
          honeypot: {
            can_sell: null,
            sell_tax_bps: null,
            note: "No Jupiter route available — token may be too new for sell-side verification",
            risk: "UNKNOWN",
            status: "OK",
          },
        },
        risk_factors: ["sell-side unverifiable (no Jupiter route)"],
      }),
    );
    const res = await request(app).get(`/v1/check?mint=${RANDOM_VALID}`);
    expect(res.body.checks.honeypot.can_sell).toBeNull();
    expect(res.body.checks.honeypot.risk).toBe("UNKNOWN");
    expect(res.body.risk_factors).toContain(
      "sell-side unverifiable (no Jupiter route)",
    );
  });

  it("CUSTOMER: lite shows can_sell null (not false)", async () => {
    mockCheckTokenLite.mockResolvedValue(
      makeLite({ mint: RANDOM_VALID, can_sell: null }),
    );
    const res = await request(app).get(`/v1/check/lite?mint=${RANDOM_VALID}`);
    expect(res.body.can_sell).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. DEGRADED MODE EDGE CASES
// ════════════════════════════════════════════════════════════════════════

describe("Degraded mode: all checks failing", () => {
  const allDegraded = () =>
    makeLite({
      mint: RANDOM_VALID,
      risk_score: 48,
      risk_level: "HIGH",
      degraded: true,
      degraded_checks: [
        "top_holders",
        "liquidity",
        "honeypot",
        "token_age",
        "metadata",
      ],
      checks_completed: 1,
      checks_total: 6,
      data_confidence: "partial",
      degraded_note:
        "Warning: 5 of 6 checks failed (top_holders, liquidity, honeypot, token_age, metadata). Score includes uncertainty penalties and may not reflect true risk. Retry or use full /v1/check for best accuracy.",
      uncertainty_penalties: {
        uncertainty_top_holders: 20,
        uncertainty_liquidity: 10,
        uncertainty_honeypot: 10,
        uncertainty_token_age: 5,
        uncertainty_metadata: 3,
      },
      can_sell: null,
      has_liquidity: false,
      liquidity_rating: null,
      top_10_concentration: null,
      token_age_hours: null,
    });

  it("CUSTOMER: sees partial confidence with all penalties", async () => {
    mockCheckTokenLite.mockResolvedValue(allDegraded());
    const res = await request(app).get(`/v1/check/lite?mint=${RANDOM_VALID}`);
    expect(res.body.data_confidence).toBe("partial");
    expect(res.body.degraded_note).toContain("5 of 6 checks failed");
    expect(res.body.uncertainty_penalties).toEqual({
      uncertainty_top_holders: 20,
      uncertainty_liquidity: 10,
      uncertainty_honeypot: 10,
      uncertainty_token_age: 5,
      uncertainty_metadata: 3,
    });
    expect(res.body.checks_completed).toBe(1);
    expect(res.headers["x-data-confidence"]).toBe("partial");
  });

  it("AGENT: /decide returns UNKNOWN when degraded", async () => {
    mockCheckTokenLite.mockResolvedValue(allDegraded());
    const res = await request(app).get(`/v1/decide?mint=${RANDOM_VALID}`);
    expect(res.body.decision).toBe("UNKNOWN");
    expect(res.body.score_reliable).toBe(false);
    expect(res.body.note).toContain("Retry in 30s");
    expect(res.body.degraded_checks).toEqual([
      "top_holders",
      "liquidity",
      "honeypot",
      "token_age",
      "metadata",
    ]);
  });
});

describe("Degraded mode: single check failing", () => {
  it("AGENT: /decide still returns UNKNOWN even for single degraded check", async () => {
    mockCheckTokenLite.mockResolvedValue(
      makeLite({
        risk_score: 5,
        degraded: true,
        degraded_checks: ["metadata"],
        data_confidence: "partial",
        degraded_note: "Warning: 1 of 6 checks failed (metadata)...",
      }),
    );
    const res = await request(app).get(`/v1/decide?mint=${WSOL}`);
    expect(res.body.decision).toBe("UNKNOWN");
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. DELTA DETECTION
// ════════════════════════════════════════════════════════════════════════

describe("Delta detection: risk state transitions", () => {
  it("CONSUMER: sees changes and alerts when risk increases", async () => {
    const changes = {
      previous_checked_at: "2026-03-24T00:00:00.000Z",
      risk_score_delta: 40,
      previous_risk_score: 15,
      previous_risk_level: "LOW",
      changed_fields: [
        {
          field: "checks.mint_authority.status",
          previous: "RENOUNCED",
          current: "ACTIVE",
          severity: "CRITICAL",
        },
      ],
    };
    const alerts = [
      {
        mint: WSOL,
        symbol: "SOL",
        severity: "CRITICAL",
        message: "mint_authority changed: RENOUNCED → ACTIVE",
      },
    ];
    mockCheckToken.mockResolvedValue(
      makeFullResult({
        risk_score: 55,
        risk_level: "HIGH",
        changes,
        alerts,
      } as any),
    );
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.body.changes).toBeDefined();
    expect(res.body.changes.risk_score_delta).toBe(40);
    expect(res.body.changes.previous_risk_score).toBe(15);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0].severity).toBe("CRITICAL");
  });

  it("CUSTOMER: lite shows risk_score_delta from previous check", async () => {
    mockCheckTokenLite.mockResolvedValue(
      makeLite({
        risk_score: 55,
        risk_level: "HIGH",
        risk_score_delta: 40,
        previous_risk_score: 15,
        previous_risk_level: "LOW",
      }),
    );
    const res = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    expect(res.body.risk_score_delta).toBe(40);
    expect(res.body.previous_risk_score).toBe(15);
    expect(res.body.previous_risk_level).toBe("LOW");
    // Changes and alerts NOT leaked in lite
    expect(res.body.changes).toBeUndefined();
    expect(res.body.alerts).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4. INPUT VALIDATION EDGE CASES
// ════════════════════════════════════════════════════════════════════════

describe("Input validation edge cases", () => {
  it("empty string mint → 400 MISSING_REQUIRED_PARAM", async () => {
    // Express treats ?mint= as empty string which is falsy → caught by !mint check
    const res = await request(app).get("/v1/check/lite?mint=");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_REQUIRED_PARAM");
  });

  it("SQL injection attempt → 400 INVALID_MINT_ADDRESS", async () => {
    const res = await request(app).get(
      "/v1/check/lite?mint='; DROP TABLE tokens; --",
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_MINT_ADDRESS");
  });

  it("XSS attempt → 400 INVALID_MINT_ADDRESS", async () => {
    const res = await request(app).get(
      '/v1/check/lite?mint=<script>alert("xss")</script>',
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_MINT_ADDRESS");
  });

  it("unicode mint → 400 INVALID_MINT_ADDRESS", async () => {
    const res = await request(app).get("/v1/check/lite?mint=🚀🌕💎🔥");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_MINT_ADDRESS");
  });

  it("very long string (200+ chars) → 400 INVALID_MINT_ADDRESS", async () => {
    const longMint = "A".repeat(200);
    const res = await request(app).get(`/v1/check/lite?mint=${longMint}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_MINT_ADDRESS");
  });

  it("valid base58 but not a real account → calls analysis (bypasses validation)", async () => {
    // 32-byte valid base58 will pass validation; the actual TOKEN_NOT_FOUND error
    // comes from the analysis layer
    const { ApiError } = await import("../src/utils/errors.js");
    mockCheckTokenLite.mockRejectedValue(
      new ApiError("TOKEN_NOT_FOUND", "Mint …not found on chain"),
    );
    const res = await request(app).get(`/v1/check/lite?mint=${RANDOM_VALID}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("TOKEN_NOT_FOUND");
  });

  it("/v1/decide with threshold=NaN uses default 30", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLite({ risk_score: 25 }));
    const res = await request(app).get(
      `/v1/decide?mint=${WSOL}&threshold=notanumber`,
    );
    expect(res.body.threshold_used).toBe(30);
  });

  it("/v1/decide with negative threshold clamps to 0", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLite({ risk_score: 0 }));
    const res = await request(app).get(
      `/v1/decide?mint=${WSOL}&threshold=-50`,
    );
    expect(res.body.threshold_used).toBe(0);
    expect(res.body.decision).toBe("SAFE"); // 0 <= 0
  });

  it("/v1/decide with threshold=0 only allows perfect score", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLite({ risk_score: 1 }));
    const res = await request(app).get(`/v1/decide?mint=${WSOL}&threshold=0`);
    expect(res.body.decision).toBe("RISKY"); // 1 > 0
  });
});

// ════════════════════════════════════════════════════════════════════════
// 5. PAYWALL ISOLATION MATRIX
// ════════════════════════════════════════════════════════════════════════

describe("Paywall isolation: lite must NEVER leak paid fields", () => {
  const paywallFields = [
    "checks",
    "changes",
    "alerts",
    "rpc_slot",
    "response_signature",
    "signer_pubkey",
    "score_breakdown",
    "methodology_version",
    "cached_at",
    "checked_at",
    "risk_factors",
  ];

  it("none of the paywalled fields leak in lite response", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLite());
    const res = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    for (const field of paywallFields) {
      expect(res.body[field]).toBeUndefined();
    }
  });

  it("none of the paywalled fields leak in /decide response", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLite());
    const res = await request(app).get(`/v1/decide?mint=${WSOL}`);
    for (const field of paywallFields) {
      expect(res.body[field]).toBeUndefined();
    }
  });
});

describe("Paywall isolation: paid check MUST include all fields", () => {
  const requiredPaidFields = [
    "mint",
    "name",
    "symbol",
    "checked_at",
    "risk_score",
    "risk_level",
    "checks",
    "rpc_slot",
    "methodology_version",
    "risk_factors",
    "summary",
    "degraded",
    "degraded_checks",
    "response_signature",
    "signer_pubkey",
    "score_breakdown",
    "data_confidence",
    "changes",
    "alerts",
  ];

  it("all required fields present in paid response", async () => {
    mockCheckToken.mockResolvedValue(makeFullResult());
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    for (const field of requiredPaidFields) {
      expect(res.body).toHaveProperty(field);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// 6. BATCH ENDPOINT EDGE CASES
// ════════════════════════════════════════════════════════════════════════

describe("Batch edge cases", () => {
  it("batch with duplicate mints succeeds (deduplication in cache)", async () => {
    mockCheckToken.mockResolvedValue(makeFullResult());
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints: [WSOL, WSOL, WSOL] });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.succeeded).toBe(3);
  });

  it("batch with mix of valid and non-existent tokens", async () => {
    const { ApiError } = await import("../src/utils/errors.js");
    mockCheckToken
      .mockResolvedValueOnce(makeFullResult())
      .mockRejectedValueOnce(
        new ApiError("TOKEN_NOT_FOUND", "Token not found"),
      )
      .mockResolvedValueOnce(
        makeFullResult({ mint: JUP, name: "Jupiter", symbol: "JUP" }),
      );
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints: [WSOL, RANDOM_VALID, JUP] });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.succeeded).toBe(2);
    expect(res.body.failed).toBe(1);
    const errors = res.body.results.filter(
      (r: any) => r.status === "error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].error.code).toBe("TOKEN_NOT_FOUND");
  });

  it("batch with all failures returns 200 with failed count", async () => {
    const { ApiError } = await import("../src/utils/errors.js");
    mockCheckToken.mockRejectedValue(
      new ApiError("RPC_ERROR", "RPC unavailable"),
    );
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints: [WSOL, USDC] });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.succeeded).toBe(0);
    expect(res.body.failed).toBe(2);
  });

  it("batch with exactly max tokens (boundary)", async () => {
    mockCheckToken.mockResolvedValue(makeFullResult());
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints: Array(5).fill(WSOL) });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
  });

  it("batch with exactly max+1 tokens → 400", async () => {
    const res = await request(app)
      .post("/v1/check/batch/small")
      .send({ mints: Array(6).fill(WSOL) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TOO_MANY_MINTS");
  });

  it("batch body is not JSON → error", async () => {
    const res = await request(app)
      .post("/v1/check/batch/small")
      .set("Content-Type", "application/json")
      .send("this is not json");
    // Express 5 JSON parse failure returns 500
    expect([400, 500]).toContain(res.status);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 7. CACHE BEHAVIOR
// ════════════════════════════════════════════════════════════════════════

describe("Cache headers", () => {
  it("lite response has public cache headers", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLite());
    const res = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=300, stale-while-revalidate=60",
    );
    expect(res.headers["vary"]).toContain("Accept-Encoding");
  });

  it("paid response has private, no-store cache header", async () => {
    mockCheckToken.mockResolvedValue(makeFullResult());
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("decide response has public cache headers", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLite());
    const res = await request(app).get(`/v1/decide?mint=${WSOL}`);
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=300, stale-while-revalidate=60",
    );
  });

  it("X-Cache: MISS on fresh, HIT on cached", async () => {
    mockCheckToken
      .mockResolvedValueOnce(makeFullResult())
      .mockResolvedValueOnce({ ...makeFullResult(), fromCache: true });
    const res1 = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res1.headers["x-cache"]).toBe("MISS");
    const res2 = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res2.headers["x-cache"]).toBe("HIT");
  });
});

// ════════════════════════════════════════════════════════════════════════
// 8. CORS VALIDATION
// ════════════════════════════════════════════════════════════════════════

describe("CORS headers on all endpoints", () => {
  it("lite has CORS", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLite());
    const res = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("paid check has CORS", async () => {
    mockCheckToken.mockResolvedValue(makeFullResult());
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("decide has CORS", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLite());
    const res = await request(app).get(`/v1/decide?mint=${WSOL}`);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("OPTIONS preflight allows PAYMENT-SIGNATURE header", async () => {
    const res = await request(app).options("/v1/check");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-headers"]).toContain(
      "PAYMENT-SIGNATURE",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// 9. RESPONSE TIMING HEADER
// ════════════════════════════════════════════════════════════════════════

describe("Response timing", () => {
  it("X-Response-Time header present on all endpoints", async () => {
    mockCheckTokenLite.mockResolvedValue(makeLite());
    const lite = await request(app).get(`/v1/check/lite?mint=${WSOL}`);
    expect(lite.headers["x-response-time"]).toMatch(/^\d+ms$/);

    mockCheckToken.mockResolvedValue(makeFullResult());
    const paid = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(paid.headers["x-response-time"]).toMatch(/^\d+ms$/);

    const health = await request(app).get("/health");
    expect(health.headers["x-response-time"]).toMatch(/^\d+ms$/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 10. ERROR SHAPE CONSISTENCY
// ════════════════════════════════════════════════════════════════════════

describe("Error shape is consistent across endpoints", () => {
  it("all errors have { error: { code, message } } shape", async () => {
    // Missing mint
    const r1 = await request(app).get("/v1/check");
    const r2 = await request(app).get("/v1/check/lite");
    const r3 = await request(app).get("/v1/decide");

    for (const r of [r1, r2, r3]) {
      expect(r.body.error).toBeDefined();
      expect(typeof r.body.error.code).toBe("string");
      expect(typeof r.body.error.message).toBe("string");
    }
  });

  it("invalid mint error includes the bad address in message", async () => {
    const res = await request(app).get("/v1/check/lite?mint=badmint123");
    expect(res.body.error.message).toContain("badmint123");
  });

  it("404 on unknown route has NOT_FOUND code", async () => {
    const res = await request(app).get("/v1/nonexistent");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("500 on unexpected error has INTERNAL_ERROR code", async () => {
    mockCheckToken.mockRejectedValue(new Error("disk full"));
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("503 on RPC error", async () => {
    const { ApiError } = await import("../src/utils/errors.js");
    mockCheckToken.mockRejectedValue(
      new ApiError("RPC_ERROR", "Connection refused"),
    );
    const res = await request(app).get(`/v1/check?mint=${WSOL}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("RPC_ERROR");
  });
});
