import { describe, it, expect } from "vitest";
import {
  computeRiskScore,
  generateRiskSummary,
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
    risk: "SAFE",
    ...overrides,
  };
}

function makeMetadata(overrides: Partial<MetadataResult> = {}): MetadataResult {
  return {
    name: "Test Token",
    symbol: "TEST",
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
    created_at: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeHoneypot(overrides: Partial<HoneypotResult> = {}): HoneypotResult {
  return {
    can_sell: true,
    sell_tax_bps: null,
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
  it("adds 30 for active mint authority", () => {
    const result = computeRiskScore(
      makeInput({ mint: makeMint({ mintAuthority: "SomeAuthority111" }) }),
    );
    expect(result.risk_score).toBe(30);
    expect(result.risk_level).toBe("MODERATE");
  });

  it("adds 25 for active freeze authority", () => {
    const result = computeRiskScore(
      makeInput({ mint: makeMint({ freezeAuthority: "SomeAuthority111" }) }),
    );
    expect(result.risk_score).toBe(25);
    expect(result.risk_level).toBe("MODERATE");
  });

  // --- Holder concentration ---
  it("adds 15 for top 10 holders > 50%", () => {
    const result = computeRiskScore(
      makeInput({ holders: makeHolders({ top_10_percentage: 55 }) }),
    );
    expect(result.risk_score).toBe(15);
  });

  it("adds 10 for top 1 holder > 20% when no active liquidity", () => {
    const result = computeRiskScore(
      makeInput({
        holders: makeHolders({ top_1_percentage: 25 }),
        liquidity: null,
      }),
    );
    expect(result.risk_score).toBe(10);
  });

  it("skips top 1 whale penalty when token has active liquidity (AMM vault)", () => {
    const result = computeRiskScore(
      makeInput({
        holders: makeHolders({ top_1_percentage: 25 }),
        liquidity: makeLiquidity({ has_liquidity: true }),
      }),
    );
    expect(result.risk_score).toBe(0);
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
      makeInput({ liquidity: makeLiquidity({ lp_locked: true, lp_lock_percentage: 95 }) }),
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
  it("adds 10 for mutable metadata", () => {
    const result = computeRiskScore(
      makeInput({ metadata: makeMetadata({ mutable: true }) }),
    );
    expect(result.risk_score).toBe(10);
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
          extensions: [
            { name: "TransferHook", transfer_hook_program: null },
          ],
        }),
      }),
    );
    expect(result.risk_score).toBe(0);
  });

  // --- Honeypot ---
  it("adds 30 for honeypot can't sell", () => {
    const result = computeRiskScore(
      makeInput({
        honeypot: makeHoneypot({ can_sell: false, risk: "DANGEROUS" }),
      }),
    );
    expect(result.risk_score).toBe(30);
  });

  it("adds 15 for sell tax > 10%", () => {
    const result = computeRiskScore(
      makeInput({
        honeypot: makeHoneypot({ sell_tax_bps: 2000 }),
      }),
    );
    expect(result.risk_score).toBe(15);
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
        holders: makeHolders({ top_10_percentage: 80, top_1_percentage: 40 }),
        liquidity: makeLiquidity({ has_liquidity: false }),
        metadata: makeMetadata({ mutable: true }),
        tokenAge: makeAge({ token_age_hours: 0.1 }),
      }),
    );
    // 30 + 25 + 15 + 10 + 30 + 10 + 10 = 130 → capped at 100
    expect(result.risk_score).toBe(100);
    expect(result.risk_level).toBe("EXTREME");
  });

  // --- Level boundaries ---
  it("boundary: score 20 is LOW", () => {
    const result = computeRiskScore(
      makeInput({
        holders: makeHolders({ top_10_percentage: 55 }),
        tokenAge: makeAge({ token_age_hours: 12 }),
      }),
    );
    // 15 (top10>50%) + 5 (age<24h) = 20
    expect(result.risk_score).toBe(20);
    expect(result.risk_level).toBe("LOW");
  });

  it("boundary: score 21+ is MODERATE", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({ freezeAuthority: "A" }),
      }),
    );
    // 25 (freeze authority)
    expect(result.risk_score).toBe(25);
    expect(result.risk_level).toBe("MODERATE");
  });

  // --- Freeze authority allowlist ---
  it("skips freeze authority penalty for trusted authorities (e.g. Circle/USDC)", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({
          freezeAuthority: "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688JtsGMsNeDDw",
        }),
      }),
    );
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

  it("includes holder percentages", () => {
    const summary = generateRiskSummary(
      makeInput({
        holders: makeHolders({ top_10_percentage: 75.3, top_1_percentage: 25.1 }),
      }),
    );
    expect(summary).toContain("top 10 holders own 75.3% of supply");
    expect(summary).toContain("top holder owns 25.1%");
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

  it("flags honeypot", () => {
    const summary = generateRiskSummary(
      makeInput({
        honeypot: makeHoneypot({ can_sell: false, risk: "DANGEROUS" }),
      }),
    );
    expect(summary).toContain("cannot sell (honeypot)");
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
          freezeAuthority: "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688JtsGMsNeDDw",
        }),
      }),
    );
    expect(summary).toBe("No risk factors detected");
  });
});
