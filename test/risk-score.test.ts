import { describe, it, expect } from "vitest";
import {
  computeRiskScore,
  getRiskFactors,
  generateRiskSummary,
  getMaturitySignals,
  type RiskScoreInput,
} from "../src/analysis/risk-score.js";
import type { MintAccountResult } from "../src/analysis/checks/mint-authority.js";
import type { TopHoldersResult } from "../src/analysis/checks/top-holders.js";
import type { LiquidityResult } from "../src/analysis/checks/liquidity.js";
import type { MetadataResult } from "../src/analysis/checks/metadata.js";
import type { TokenAgeResult } from "../src/analysis/checks/token-age.js";
import type { HoneypotResult } from "../src/analysis/checks/honeypot.js";

function makeMint(
  overrides: Partial<MintAccountResult> = {},
): MintAccountResult {
  return {
    mintAuthority: null,
    freezeAuthority: null,
    supplyRaw: 1000000000n,
    decimals: 9,
    isToken2022: false,
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    rpcSlot: 300000000,
    extensions: [],
    ...overrides,
  };
}

function makeHolders(
  overrides: Partial<TopHoldersResult> = {},
): TopHoldersResult {
  return {
    top_10_percentage: 10,
    top_1_percentage: 2,
    holder_count_estimate: null,
    top_holders_detail: null,
    note: null,
    risk: "SAFE",
    ...overrides,
  };
}

function makeLiquidity(
  overrides: Partial<LiquidityResult> = {},
): LiquidityResult {
  return {
    has_liquidity: true,
    primary_pool: "Raydium",
    pool_address: null,
    price_impact_pct: null,
    liquidity_rating: null,
    lp_locked: null,
    lp_lock_percentage: null,
    lp_lock_expiry: null,
    lp_mint: null,
    lp_locker: null,
    pool_vault_addresses: null,
    risk: "SAFE",
    ...overrides,
  };
}

function makeMetadata(overrides: Partial<MetadataResult> = {}): MetadataResult {
  return {
    name: "Test Token",
    symbol: "TEST",
    update_authority: null,
    mutable: false,
    has_uri: true,
    uri: "https://example.com/meta.json",
    risk: "SAFE",
    ...overrides,
  };
}

function makeAge(overrides: Partial<TokenAgeResult> = {}): TokenAgeResult {
  return {
    token_age_hours: 720,
    token_age_minutes: 43200,
    created_at: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeHoneypot(overrides: Partial<HoneypotResult> = {}): HoneypotResult {
  return {
    can_sell: true,
    sell_tax_bps: null,
    note: null,
    risk: "SAFE",
    ...overrides,
  };
}

function makeInput(overrides: Partial<RiskScoreInput> = {}): RiskScoreInput {
  return {
    mint: makeMint(),
    holders: makeHolders(),
    liquidity: makeLiquidity(),
    metadata: makeMetadata(),
    tokenAge: makeAge(),
    honeypot: null,
    ...overrides,
  };
}

describe("computeRiskScore", () => {
  it("returns 0/LOW when all checks are safe", () => {
    const result = computeRiskScore(makeInput());
    expect(result.risk_score).toBe(0);
    expect(result.risk_level).toBe("LOW");
  });

  // --- Authority checks ---
  it("adds 30 for active mint authority (no maturity signals)", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({ mintAuthority: "SomeAuthority111" }),
        holders: makeHolders({ top_10_percentage: 0 }),
      }),
    );
    expect(result.risk_score).toBe(30);
    expect(result.risk_level).toBe("MODERATE");
  });

  it("adds 25 for active freeze authority (no maturity signals)", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({ freezeAuthority: "SomeAuthority111" }),
        holders: makeHolders({ top_10_percentage: 0 }),
      }),
    );
    expect(result.risk_score).toBe(25);
    expect(result.risk_level).toBe("MODERATE");
  });

  // --- Holder concentration (graduated) ---
  it("adds 25 for top 10 holders > 80%", () => {
    const result = computeRiskScore(
      makeInput({ holders: makeHolders({ top_10_percentage: 85 }) }),
    );
    expect(result.breakdown.top_holders_10).toBe(25);
  });

  it("adds 20 for top 10 holders > 50% and <= 80%", () => {
    const result = computeRiskScore(
      makeInput({ holders: makeHolders({ top_10_percentage: 55 }) }),
    );
    expect(result.breakdown.top_holders_10).toBe(20);
  });

  it("adds 10 for top 10 holders > 30% and <= 50%", () => {
    const result = computeRiskScore(
      makeInput({ holders: makeHolders({ top_10_percentage: 35 }) }),
    );
    expect(result.breakdown.top_holders_10).toBe(10);
  });

  it("adds 0 for top 10 holders <= 30%", () => {
    const result = computeRiskScore(
      makeInput({ holders: makeHolders({ top_10_percentage: 25 }) }),
    );
    expect(result.breakdown.top_holders_10).toBeUndefined();
  });

  it("adds 25 for top 1 holder > 50%", () => {
    const result = computeRiskScore(
      makeInput({ holders: makeHolders({ top_1_percentage: 55 }) }),
    );
    expect(result.breakdown.top_holders_1).toBe(25);
  });

  it("adds 15 for top 1 holder > 30% and <= 50%", () => {
    const result = computeRiskScore(
      makeInput({ holders: makeHolders({ top_1_percentage: 35 }) }),
    );
    expect(result.breakdown.top_holders_1).toBe(15);
  });

  it("adds 10 for top 1 holder > 20% and <= 30%", () => {
    const result = computeRiskScore(
      makeInput({ holders: makeHolders({ top_1_percentage: 25 }) }),
    );
    expect(result.breakdown.top_holders_1).toBe(10);
  });

  it("adds 5 for top 1 holder > 10% and <= 20%", () => {
    const result = computeRiskScore(
      makeInput({ holders: makeHolders({ top_1_percentage: 15 }) }),
    );
    expect(result.breakdown.top_holders_1).toBe(5);
  });

  it("adds 0 for top 1 holder <= 10%", () => {
    const result = computeRiskScore(
      makeInput({ holders: makeHolders({ top_1_percentage: 8 }) }),
    );
    expect(result.breakdown.top_holders_1).toBeUndefined();
  });

  it("applies top 1 penalty even with active liquidity (no AMM vault exemption)", () => {
    const result = computeRiskScore(
      makeInput({
        holders: makeHolders({ top_1_percentage: 25 }),
        liquidity: makeLiquidity({ has_liquidity: true }),
      }),
    );
    expect(result.breakdown.top_holders_1).toBe(10);
    expect(result.risk_score).toBe(10);
  });

  // --- Liquidity ---
  it("adds 30 for no liquidity", () => {
    const result = computeRiskScore(
      makeInput({ liquidity: makeLiquidity({ has_liquidity: false }) }),
    );
    expect(result.risk_score).toBe(30);
    expect(result.risk_level).toBe("MODERATE");
  });

  it("adds 15 for unlocked LP", () => {
    const result = computeRiskScore(
      makeInput({ liquidity: makeLiquidity({ lp_locked: false }) }),
    );
    expect(result.risk_score).toBe(15);
  });

  it("adds 0 for locked LP", () => {
    const result = computeRiskScore(
      makeInput({
        liquidity: makeLiquidity({ lp_locked: true, lp_lock_percentage: 95 }),
      }),
    );
    expect(result.risk_score).toBe(0);
  });

  it("adds 0 for unknown LP lock (null)", () => {
    const result = computeRiskScore(
      makeInput({ liquidity: makeLiquidity({ lp_locked: null }) }),
    );
    expect(result.risk_score).toBe(0);
  });

  it("skips liquidity scoring when check returned null", () => {
    const result = computeRiskScore(makeInput({ liquidity: null }));
    expect(result.risk_score).toBe(0);
  });

  // --- Metadata ---
  it("adds 10 for mutable metadata (< 2 maturity signals)", () => {
    const result = computeRiskScore(
      makeInput({ metadata: makeMetadata({ mutable: true }) }),
    );
    // Default input: 1 signal (distributed only) → full +10 penalty
    expect(result.risk_score).toBe(10);
  });

  it("reduces mutable metadata penalty to 5 for established tokens (2+ signals)", () => {
    const result = computeRiskScore(
      makeInput({
        metadata: makeMetadata({ mutable: true }),
        holders: makeHolders({ top_10_percentage: 15 }),
        liquidity: makeLiquidity({ liquidity_rating: "DEEP" }),
        tokenAge: makeAge({
          token_age_hours: 720,
          created_at: "2025-01-01T00:00:00.000Z",
          established: true,
        }),
      }),
    );
    // 3 signals (deep + established + distributed) → +5 for metadata
    expect(result.risk_score).toBe(5);
  });

  it("skips metadata scoring when check returned null", () => {
    const result = computeRiskScore(makeInput({ metadata: null }));
    expect(result.risk_score).toBe(0);
  });

  // --- Token age ---
  it("adds 10 for token age < 1 hour", () => {
    const result = computeRiskScore(
      makeInput({ tokenAge: makeAge({ token_age_hours: 0.5 }) }),
    );
    expect(result.risk_score).toBe(10);
  });

  it("adds 5 for token age < 24 hours but >= 1 hour", () => {
    const result = computeRiskScore(
      makeInput({ tokenAge: makeAge({ token_age_hours: 12 }) }),
    );
    expect(result.risk_score).toBe(5);
  });

  it("adds 0 for token age >= 24 hours", () => {
    const result = computeRiskScore(
      makeInput({ tokenAge: makeAge({ token_age_hours: 48 }) }),
    );
    expect(result.risk_score).toBe(0);
  });

  it("skips age scoring when check returned null", () => {
    const result = computeRiskScore(makeInput({ tokenAge: null }));
    expect(result.risk_score).toBe(0);
  });

  it("timeout in age check does not count as established (no maturity credit)", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({ mintAuthority: "UnknownAuth" }),
        tokenAge: null, // timeout/failure case
        holders: makeHolders({ top_10_percentage: 15 }),
        liquidity: makeLiquidity({ liquidity_rating: "DEEP" }),
      }),
    );
    // 2 signals (deep liq + distributed), NOT 3 (timeout ≠ established)
    // mint authority with 2 signals → +5
    expect(result.risk_score).toBe(5);
  });

  // --- Token-2022 extensions ---
  it("adds 30 for PermanentDelegate with delegate set", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          extensions: [
            { name: "PermanentDelegate", permanent_delegate: "SomePubkey" },
          ],
        }),
      }),
    );
    expect(result.risk_score).toBe(30);
  });

  it("adds 20 for TransferFee > 50%", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          extensions: [{ name: "TransferFeeConfig", transfer_fee_bps: 6000 }],
        }),
      }),
    );
    expect(result.risk_score).toBe(20);
  });

  it("adds 10 for TransferFee 10-50%", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          extensions: [{ name: "TransferFeeConfig", transfer_fee_bps: 2000 }],
        }),
      }),
    );
    expect(result.risk_score).toBe(10);
  });

  it("adds 5 for TransferFee > 0%", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          extensions: [{ name: "TransferFeeConfig", transfer_fee_bps: 100 }],
        }),
      }),
    );
    expect(result.risk_score).toBe(5);
  });

  it("adds 0 for TransferFee = 0", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          extensions: [{ name: "TransferFeeConfig", transfer_fee_bps: 0 }],
        }),
      }),
    );
    expect(result.risk_score).toBe(0);
  });

  it("adds 15 for TransferHook with program set", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          extensions: [
            { name: "TransferHook", transfer_hook_program: "SomeProgram111" },
          ],
        }),
      }),
    );
    expect(result.risk_score).toBe(15);
  });

  it("adds 0 for TransferHook without program (null)", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          extensions: [{ name: "TransferHook", transfer_hook_program: null }],
        }),
      }),
    );
    expect(result.risk_score).toBe(0);
  });

  // --- Honeypot ---
  it("adds 30 for honeypot can't sell (confirmed: buy route exists, sell route doesn't)", () => {
    const result = computeRiskScore(
      makeInput({
        honeypot: makeHoneypot({ can_sell: false, risk: "DANGEROUS" }),
      }),
    );
    expect(result.risk_score).toBe(30);
  });

  it("adds 10 for honeypot can_sell null (no Jupiter route — unknown, not confirmed)", () => {
    const result = computeRiskScore(
      makeInput({
        honeypot: makeHoneypot({
          can_sell: null,
          risk: "UNKNOWN",
          note: "No Jupiter route available — token may be too new for sell-side verification",
        }),
      }),
    );
    expect(result.risk_score).toBe(10);
  });

  it("adds 15 for sell tax > 10%", () => {
    const result = computeRiskScore(
      makeInput({
        honeypot: makeHoneypot({ sell_tax_bps: 2000 }),
      }),
    );
    expect(result.risk_score).toBe(15);
  });

  it("adds 5 for sell tax > 0% and <= 10% (200 bps)", () => {
    const result = computeRiskScore(
      makeInput({ honeypot: makeHoneypot({ sell_tax_bps: 200 }) }),
    );
    expect(result.risk_score).toBe(5);
  });

  it("adds 5 for sell tax = 500 bps", () => {
    const result = computeRiskScore(
      makeInput({ honeypot: makeHoneypot({ sell_tax_bps: 500 }) }),
    );
    expect(result.risk_score).toBe(5);
  });

  it("adds 15 for sell tax = 1001 bps (boundary)", () => {
    const result = computeRiskScore(
      makeInput({ honeypot: makeHoneypot({ sell_tax_bps: 1001 }) }),
    );
    expect(result.risk_score).toBe(15);
  });

  it("adds 0 for sell tax = 0 bps (noise floor)", () => {
    const result = computeRiskScore(
      makeInput({ honeypot: makeHoneypot({ sell_tax_bps: 0 }) }),
    );
    expect(result.risk_score).toBe(0);
  });

  it("skips honeypot scoring when null", () => {
    const result = computeRiskScore(makeInput({ honeypot: null }));
    expect(result.risk_score).toBe(0);
  });

  // --- Combined ---
  it("sums all flags to max when everything is bad", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          mintAuthority: "A",
          freezeAuthority: "B",
        }),
        holders: makeHolders({ top_10_percentage: 85, top_1_percentage: 55 }),
        liquidity: makeLiquidity({ has_liquidity: false }),
        metadata: makeMetadata({ mutable: true }),
        tokenAge: makeAge({ token_age_hours: 0.1 }),
      }),
    );
    // 30 + 25 + 25 + 25 + 30 + 10 + 10 = 155 → capped at 100
    expect(result.risk_score).toBe(100);
    expect(result.risk_level).toBe("EXTREME");
  });

  // --- Level boundaries ---
  it("boundary: score 20 is LOW", () => {
    const result = computeRiskScore(
      makeInput({
        holders: makeHolders({ top_10_percentage: 35 }),
        tokenAge: makeAge({ token_age_hours: 0.5 }),
      }),
    );
    // 10 (top10>30%) + 10 (age<1h) = 20
    expect(result.risk_score).toBe(20);
    expect(result.risk_level).toBe("LOW");
  });

  it("boundary: score 21+ is MODERATE", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({ freezeAuthority: "A" }),
        holders: makeHolders({ top_10_percentage: 0 }),
      }),
    );
    // 25 (freeze authority, 0 maturity signals)
    expect(result.risk_score).toBe(25);
    expect(result.risk_level).toBe("MODERATE");
  });

  // --- Authority allowlists ---
  it("skips freeze authority penalty for trusted authorities (e.g. Circle/USDC)", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          freezeAuthority: "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar",
        }),
      }),
    );
    expect(result.risk_score).toBe(0);
  });

  it("skips mint authority penalty for trusted authorities (USDC)", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          mintAuthority: "BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG",
        }),
      }),
    );
    expect(result.risk_score).toBe(0);
  });

  it("skips mint authority penalty for USDT", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          mintAuthority: "Q6XprfkF8RQQKoQVG33xT88H7wi8Uk1B1CC7YAs69Gi",
        }),
      }),
    );
    expect(result.risk_score).toBe(0);
  });

  it("skips freeze authority penalty for USDT", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          freezeAuthority: "Q6XprfkF8RQQKoQVG33xT88H7wi8Uk1B1CC7YAs69Gi",
        }),
      }),
    );
    expect(result.risk_score).toBe(0);
  });

  it("skips mint authority penalty for mSOL stake pool", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          mintAuthority: "3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM",
        }),
      }),
    );
    expect(result.risk_score).toBe(0);
  });

  it("skips mint authority penalty for jitoSOL stake pool", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          mintAuthority: "6iQKfEyhr3bZMotVkW6beNZz5CPAkiwvgV2CTje9pVSS",
        }),
      }),
    );
    expect(result.risk_score).toBe(0);
  });

  // --- Context-aware penalty reduction ---
  it("reduces mint authority penalty for mature token (2+ signals)", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({ mintAuthority: "UnknownAuthority" }),
        holders: makeHolders({ top_10_percentage: 15 }),
        liquidity: makeLiquidity({ liquidity_rating: "DEEP" }),
        tokenAge: makeAge({
          token_age_hours: 720,
          created_at: "2025-01-01T00:00:00.000Z",
          established: true,
        }),
      }),
    );
    // 3 maturity signals (deep liquidity, established, distributed) → +5
    expect(result.risk_score).toBe(5);
  });

  it("reduces freeze authority penalty for mature token (2+ signals)", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({ freezeAuthority: "UnknownAuthority" }),
        holders: makeHolders({ top_10_percentage: 15 }),
        tokenAge: makeAge({
          token_age_hours: 720,
          created_at: "2025-01-01T00:00:00.000Z",
          established: true,
        }),
      }),
    );
    // 2 maturity signals (established, distributed) → +3
    expect(result.risk_score).toBe(3);
  });

  it("USDC-like token scores LOW despite active authorities", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          mintAuthority: "BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG",
          freezeAuthority: "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar",
        }),
        holders: makeHolders({ top_10_percentage: 12 }),
        liquidity: makeLiquidity({ liquidity_rating: "DEEP" }),
        metadata: makeMetadata({ mutable: true }),
        tokenAge: makeAge({
          token_age_hours: 8760,
          created_at: "2024-01-01T00:00:00.000Z",
          established: true,
        }),
      }),
    );
    // Both authorities trusted → +0, mutable metadata → +5 (3 maturity signals), age null → +0
    expect(result.risk_score).toBe(5);
    expect(result.risk_level).toBe("LOW");
  });

  // --- Score breakdown ---
  it("returns empty breakdown for clean token (score 0)", () => {
    const result = computeRiskScore(makeInput());
    expect(result.breakdown).toEqual({});
    expect(result.risk_score).toBe(0);
  });

  it("breakdown keys match contributing checks", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({ mintAuthority: "A", freezeAuthority: "B" }),
        holders: makeHolders({ top_10_percentage: 0 }),
      }),
    );
    expect(result.breakdown).toHaveProperty("mint_authority");
    expect(result.breakdown).toHaveProperty("freeze_authority");
    expect(Object.keys(result.breakdown)).toHaveLength(2);
  });

  it("breakdown values sum to risk_score (before cap)", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({ mintAuthority: "A" }),
        holders: makeHolders({
          top_10_percentage: 55,
          top_1_percentage: 25,
        }),
        metadata: makeMetadata({ mutable: true }),
        tokenAge: makeAge({ token_age_hours: 0.5 }),
      }),
    );
    const sum = Object.values(result.breakdown).reduce((a, b) => a + b, 0);
    // Score may be capped at 100, but breakdown sum reflects actual penalties
    expect(sum).toBeGreaterThanOrEqual(result.risk_score);
    // Verify separate keys exist for top 10 and top 1
    expect(result.breakdown).toHaveProperty("top_holders_10");
    expect(result.breakdown).toHaveProperty("top_holders_1");
  });

  it("breakdown tracks honeypot and sell_tax as separate keys", () => {
    const result = computeRiskScore(
      makeInput({
        honeypot: makeHoneypot({
          can_sell: false,
          sell_tax_bps: 2000,
          risk: "DANGEROUS",
        }),
      }),
    );
    expect(result.breakdown.honeypot).toBe(30);
    expect(result.breakdown.sell_tax).toBe(15);
  });

  it("breakdown tracks Token-2022 extension keys", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          extensions: [
            { name: "PermanentDelegate", permanent_delegate: "X" },
            { name: "TransferFeeConfig", transfer_fee_bps: 100 },
            { name: "TransferHook", transfer_hook_program: "Y" },
          ],
        }),
      }),
    );
    expect(result.breakdown.permanent_delegate).toBe(30);
    expect(result.breakdown.transfer_fee).toBe(5);
    expect(result.breakdown.transfer_hook).toBe(15);
  });

  it("breakdown includes separate top_holders_10 and top_holders_1 keys", () => {
    const result = computeRiskScore(
      makeInput({
        holders: makeHolders({ top_10_percentage: 85, top_1_percentage: 55 }),
      }),
    );
    expect(result.breakdown.top_holders_10).toBe(25); // >80%
    expect(result.breakdown.top_holders_1).toBe(25);  // >50%
  });

  it("skips mint authority penalty for PYUSD (Paxos)", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          mintAuthority: "8Jornc27vtAYPkwDzsZVgLQchAYyC8nD7aCNPCDV8Qk2",
        }),
      }),
    );
    expect(result.risk_score).toBe(0);
  });

  it("skips freeze authority penalty for PYUSD (Paxos)", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          freezeAuthority: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
        }),
      }),
    );
    expect(result.risk_score).toBe(0);
  });

  // --- Uncertainty penalties ---
  it("adds +10 uncertainty for degraded top_holders", () => {
    const result = computeRiskScore(
      makeInput({ degradedChecks: ["top_holders"] }),
    );
    expect(result.risk_score).toBe(10);
    expect(result.breakdown.uncertainty_top_holders).toBe(10);
  });

  it("adds +10 uncertainty for degraded liquidity", () => {
    const result = computeRiskScore(
      makeInput({ degradedChecks: ["liquidity"] }),
    );
    expect(result.risk_score).toBe(10);
    expect(result.breakdown.uncertainty_liquidity).toBe(10);
  });

  it("adds +10 uncertainty for degraded honeypot", () => {
    const result = computeRiskScore(
      makeInput({ degradedChecks: ["honeypot"] }),
    );
    expect(result.risk_score).toBe(10);
    expect(result.breakdown.uncertainty_honeypot).toBe(10);
  });

  it("adds +5 uncertainty for degraded token_age", () => {
    const result = computeRiskScore(
      makeInput({ degradedChecks: ["token_age"] }),
    );
    expect(result.risk_score).toBe(5);
    expect(result.breakdown.uncertainty_token_age).toBe(5);
  });

  it("adds +3 uncertainty for degraded metadata", () => {
    const result = computeRiskScore(
      makeInput({ degradedChecks: ["metadata"] }),
    );
    expect(result.risk_score).toBe(3);
    expect(result.breakdown.uncertainty_metadata).toBe(3);
  });

  it("sums multiple uncertainty penalties", () => {
    const result = computeRiskScore(
      makeInput({
        degradedChecks: ["top_holders", "liquidity", "honeypot", "token_age", "metadata"],
      }),
    );
    // 10 + 10 + 10 + 5 + 3 = 38
    expect(result.risk_score).toBe(38);
    expect(result.risk_level).toBe("MODERATE");
  });

  it("no uncertainty penalty when degradedChecks is empty", () => {
    const result = computeRiskScore(makeInput({ degradedChecks: [] }));
    expect(result.risk_score).toBe(0);
  });

  it("no uncertainty penalty when degradedChecks is undefined", () => {
    const result = computeRiskScore(makeInput());
    expect(result.risk_score).toBe(0);
  });
});

describe("generateRiskSummary", () => {
  it("returns 'No risk factors detected' when everything is safe", () => {
    const summary = generateRiskSummary(makeInput());
    expect(summary).toBe("No risk factors detected");
  });

  it("lists active mint authority", () => {
    const summary = generateRiskSummary(
      makeInput({ mint: makeMint({ mintAuthority: "A" }) }),
    );
    expect(summary).toContain("active mint authority");
  });

  it("lists multiple flags comma-separated", () => {
    const summary = generateRiskSummary(
      makeInput({
        mint: makeMint({ mintAuthority: "A", freezeAuthority: "B" }),
        liquidity: makeLiquidity({ has_liquidity: false }),
      }),
    );
    expect(summary).toContain("active mint authority");
    expect(summary).toContain("active freeze authority");
    expect(summary).toContain("no liquidity detected");
    expect(summary.split(", ").length).toBe(3);
  });

  it("includes holder percentages when above thresholds", () => {
    const summary = generateRiskSummary(
      makeInput({
        holders: makeHolders({
          top_10_percentage: 75.3,
          top_1_percentage: 25.1,
        }),
      }),
    );
    expect(summary).toContain("top 10 holders own 75.3% of supply");
    expect(summary).toContain("top holder owns 25.1%");
  });

  it("includes top 1 holder at >10% threshold", () => {
    const summary = generateRiskSummary(
      makeInput({
        holders: makeHolders({
          top_10_percentage: 25,
          top_1_percentage: 15,
        }),
      }),
    );
    expect(summary).not.toContain("top 10 holders");
    expect(summary).toContain("top holder owns 15.0%");
  });

  it("includes transfer fee percentage", () => {
    const summary = generateRiskSummary(
      makeInput({
        mint: makeMint({
          extensions: [{ name: "TransferFeeConfig", transfer_fee_bps: 500 }],
        }),
      }),
    );
    expect(summary).toContain("5.0% transfer fee");
  });

  it("includes 'LP not locked' when LP is unlocked", () => {
    const summary = generateRiskSummary(
      makeInput({ liquidity: makeLiquidity({ lp_locked: false }) }),
    );
    expect(summary).toContain("LP not locked");
  });

  it("does not include 'LP not locked' when LP is locked", () => {
    const summary = generateRiskSummary(
      makeInput({ liquidity: makeLiquidity({ lp_locked: true }) }),
    );
    expect(summary).not.toContain("LP not locked");
  });

  it("flags honeypot when can_sell is false", () => {
    const summary = generateRiskSummary(
      makeInput({
        honeypot: makeHoneypot({ can_sell: false, risk: "DANGEROUS" }),
      }),
    );
    expect(summary).toContain("cannot sell (honeypot)");
  });

  it("flags sell-side unverifiable when can_sell is null", () => {
    const summary = generateRiskSummary(
      makeInput({
        honeypot: makeHoneypot({
          can_sell: null,
          risk: "UNKNOWN",
          note: "No Jupiter route available — token may be too new for sell-side verification",
        }),
      }),
    );
    expect(summary).toContain("sell-side unverifiable");
  });

  it("includes sell tax percentage", () => {
    const summary = generateRiskSummary(
      makeInput({
        honeypot: makeHoneypot({ sell_tax_bps: 1500 }),
      }),
    );
    expect(summary).toContain("15.0% sell tax");
  });

  it("includes transfer hook warning", () => {
    const summary = generateRiskSummary(
      makeInput({
        mint: makeMint({
          extensions: [
            { name: "TransferHook", transfer_hook_program: "SomeProgram111" },
          ],
        }),
      }),
    );
    expect(summary).toContain("transfer hook set");
  });

  it("skips freeze authority flag for trusted authorities", () => {
    const summary = generateRiskSummary(
      makeInput({
        mint: makeMint({
          freezeAuthority: "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar",
        }),
      }),
    );
    expect(summary).toBe("No risk factors detected");
  });

  it("skips mint authority flag for trusted authorities", () => {
    const summary = generateRiskSummary(
      makeInput({
        mint: makeMint({
          mintAuthority: "BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG",
        }),
      }),
    );
    expect(summary).toBe("No risk factors detected");
  });

  it("omits 'mutable metadata' from summary for mature tokens", () => {
    const summary = generateRiskSummary(
      makeInput({
        metadata: makeMetadata({ mutable: true }),
        holders: makeHolders({ top_10_percentage: 15 }),
        liquidity: makeLiquidity({ liquidity_rating: "DEEP" }),
        tokenAge: makeAge({
          token_age_hours: 720,
          created_at: "2025-01-01T00:00:00.000Z",
          established: true,
        }),
      }),
    );
    expect(summary).not.toContain("mutable metadata");
    expect(summary).toBe("No risk factors detected");
  });
});

describe("getRiskFactors", () => {
  it("returns empty array when everything is safe", () => {
    const factors = getRiskFactors(makeInput());
    expect(factors).toEqual([]);
  });

  it("returns array of risk factor strings", () => {
    const factors = getRiskFactors(
      makeInput({
        mint: makeMint({ mintAuthority: "A", freezeAuthority: "B" }),
        liquidity: makeLiquidity({ has_liquidity: false }),
      }),
    );
    expect(factors).toContain("active mint authority");
    expect(factors).toContain("active freeze authority");
    expect(factors).toContain("no liquidity detected");
    expect(factors).toHaveLength(3);
  });

  it("generateRiskSummary joins factors from getRiskFactors", () => {
    const input = makeInput({
      mint: makeMint({ mintAuthority: "A" }),
    });
    const factors = getRiskFactors(input);
    const summary = generateRiskSummary(input);
    expect(summary).toBe(factors.join(", "));
  });

  it("suppresses 'mutable metadata' when maturitySignals >= 2", () => {
    const factors = getRiskFactors(
      makeInput({
        metadata: makeMetadata({ mutable: true }),
        holders: makeHolders({ top_10_percentage: 15 }),
        liquidity: makeLiquidity({ liquidity_rating: "DEEP" }),
        tokenAge: makeAge({
          token_age_hours: 720,
          created_at: "2025-01-01T00:00:00.000Z",
          established: true,
        }),
      }),
    );
    expect(factors).not.toContain("mutable metadata");
  });

  it("includes 'mutable metadata' when maturitySignals < 2", () => {
    const factors = getRiskFactors(
      makeInput({
        metadata: makeMetadata({ mutable: true }),
        holders: makeHolders({ top_10_percentage: 0 }),
        liquidity: null,
        tokenAge: null,
      }),
    );
    expect(factors).toContain("mutable metadata");
  });

  it("includes uncertainty flags for degraded checks", () => {
    const factors = getRiskFactors(
      makeInput({ degradedChecks: ["honeypot", "liquidity"] }),
    );
    expect(factors).toContain("honeypot data unavailable — score reflects uncertainty");
    expect(factors).toContain("liquidity data unavailable — score reflects uncertainty");
  });
});

describe("generateRiskSummary with degraded checks", () => {
  it("returns uncertainty note when all checks degraded and no risk factors", () => {
    const summary = generateRiskSummary(
      makeInput({ degradedChecks: ["honeypot", "liquidity"] }),
    );
    expect(summary).toContain("2 check(s) unavailable");
    expect(summary).toContain("honeypot, liquidity");
    expect(summary).toContain("uncertainty penalties");
  });

  it("combines real risk factors with uncertainty note", () => {
    const summary = generateRiskSummary(
      makeInput({
        mint: makeMint({ mintAuthority: "A" }),
        degradedChecks: ["honeypot"],
      }),
    );
    expect(summary).toContain("active mint authority");
    expect(summary).toContain("1 check(s) unavailable");
    expect(summary).toContain("honeypot");
  });

  it("returns 'No risk factors detected' when no degraded and no risk", () => {
    const summary = generateRiskSummary(makeInput({ degradedChecks: [] }));
    expect(summary).toBe("No risk factors detected");
  });
});
