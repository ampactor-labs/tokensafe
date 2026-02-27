import { describe, it, expect } from "vitest";
import {
  computeRiskScore,
  type RiskScoreInput,
} from "../src/analysis/risk-score.js";
import type { MintAccountResult } from "../src/analysis/checks/mint-authority.js";
import type { TopHoldersResult } from "../src/analysis/checks/top-holders.js";
import type { LiquidityResult } from "../src/analysis/checks/liquidity.js";
import type { MetadataResult } from "../src/analysis/checks/metadata.js";
import type { TokenAgeResult } from "../src/analysis/checks/token-age.js";

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

function makeInput(overrides: Partial<RiskScoreInput> = {}): RiskScoreInput {
  return {
    mint: makeMint(),
    holders: makeHolders(),
    liquidity: makeLiquidity(),
    metadata: makeMetadata(),
    tokenAge: makeAge(),
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

  it("adds 20 for active freeze authority", () => {
    const result = computeRiskScore(
      makeInput({ mint: makeMint({ freezeAuthority: "SomeAuthority111" }) }),
    );
    expect(result.risk_score).toBe(20);
    expect(result.risk_level).toBe("LOW");
  });

  // --- Holder concentration ---
  it("adds 15 for top 10 holders > 50%", () => {
    const result = computeRiskScore(
      makeInput({ holders: makeHolders({ top_10_percentage: 55 }) }),
    );
    expect(result.risk_score).toBe(15);
  });

  it("adds 10 for top 1 holder > 20%", () => {
    const result = computeRiskScore(
      makeInput({ holders: makeHolders({ top_1_percentage: 25 }) }),
    );
    expect(result.risk_score).toBe(10);
  });

  // --- Liquidity ---
  it("adds 25 for no liquidity", () => {
    const result = computeRiskScore(
      makeInput({ liquidity: makeLiquidity({ has_liquidity: false }) }),
    );
    expect(result.risk_score).toBe(25);
    expect(result.risk_level).toBe("MODERATE");
  });

  it("skips liquidity scoring when check returned null", () => {
    const result = computeRiskScore(makeInput({ liquidity: null }));
    expect(result.risk_score).toBe(0);
  });

  // --- Metadata ---
  it("adds 5 for mutable metadata", () => {
    const result = computeRiskScore(
      makeInput({ metadata: makeMetadata({ mutable: true }) }),
    );
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
    // 30 + 20 + 15 + 10 + 25 + 5 + 10 = 115 → capped at 100
    expect(result.risk_score).toBe(100);
    expect(result.risk_level).toBe("EXTREME");
  });

  // --- Level boundaries ---
  it("boundary: score 20 is LOW", () => {
    const result = computeRiskScore(
      makeInput({ mint: makeMint({ freezeAuthority: "A" }) }),
    );
    expect(result.risk_score).toBe(20);
    expect(result.risk_level).toBe("LOW");
  });

  it("boundary: score 21+ is MODERATE", () => {
    const result = computeRiskScore(
      makeInput({
        mint: makeMint({ freezeAuthority: "A" }),
        metadata: makeMetadata({ mutable: true }),
      }),
    );
    expect(result.risk_score).toBe(25);
    expect(result.risk_level).toBe("MODERATE");
  });
});
