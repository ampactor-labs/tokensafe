import type { MintAccountResult } from "./checks/mint-authority.js";
import type { TopHoldersResult } from "./checks/top-holders.js";
import type { LiquidityResult } from "./checks/liquidity.js";
import type { MetadataResult } from "./checks/metadata.js";
import type { TokenAgeResult } from "./checks/token-age.js";

export type RiskLevel = "LOW" | "MODERATE" | "HIGH" | "CRITICAL" | "EXTREME";

export interface RiskScoreInput {
  mint: MintAccountResult;
  holders: TopHoldersResult;
  liquidity: LiquidityResult | null;
  metadata: MetadataResult | null;
  tokenAge: TokenAgeResult | null;
}

export interface RiskScoreResult {
  risk_score: number;
  risk_level: RiskLevel;
}

export function computeRiskScore(input: RiskScoreInput): RiskScoreResult {
  let score = 0;

  // Mint/freeze authority (Phase 1)
  if (input.mint.mintAuthority !== null) score += 30;
  if (input.mint.freezeAuthority !== null) score += 20;

  // Top holder concentration (Phase 1)
  if (input.holders.top_10_percentage > 50) score += 15;
  if (input.holders.top_1_percentage > 20) score += 10;

  // Liquidity (Phase 2) — only score if check returned data
  if (input.liquidity) {
    if (!input.liquidity.has_liquidity) score += 25;
    // LP lock: +15 when detectable and not locked (v2)
  }

  // Metadata mutability (Phase 2)
  if (input.metadata?.mutable) score += 5;

  // Token age (Phase 2)
  if (input.tokenAge?.token_age_hours !== null && input.tokenAge) {
    const ageHours = input.tokenAge.token_age_hours!;
    if (ageHours < 1) score += 10;
    else if (ageHours < 24) score += 5;
  }

  score = Math.min(score, 100);

  const risk_level = scoreToLevel(score);
  return { risk_score: score, risk_level };
}

function scoreToLevel(score: number): RiskLevel {
  if (score <= 20) return "LOW";
  if (score <= 40) return "MODERATE";
  if (score <= 60) return "HIGH";
  if (score <= 80) return "CRITICAL";
  return "EXTREME";
}
