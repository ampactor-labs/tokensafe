import type { MintAccountResult } from "./checks/mint-authority.js";
import type { TopHoldersResult } from "./checks/top-holders.js";

export type RiskLevel = "LOW" | "MODERATE" | "HIGH" | "CRITICAL" | "EXTREME";

export interface RiskScoreResult {
  risk_score: number;
  risk_level: RiskLevel;
}

export function computeRiskScore(
  mint: MintAccountResult,
  holders: TopHoldersResult,
): RiskScoreResult {
  let score = 0;

  if (mint.mintAuthority !== null) score += 30;
  if (mint.freezeAuthority !== null) score += 20;
  if (holders.top_10_percentage > 50) score += 15;
  if (holders.top_1_percentage > 20) score += 10;

  // Phase 1 max = 75
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
