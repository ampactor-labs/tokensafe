import type { MintAccountResult } from "./checks/mint-authority.js";
import type { TopHoldersResult } from "./checks/top-holders.js";
import type { LiquidityResult } from "./checks/liquidity.js";
import type { MetadataResult } from "./checks/metadata.js";
import type { TokenAgeResult } from "./checks/token-age.js";
import type { HoneypotResult } from "./checks/honeypot.js";

export type RiskLevel = "LOW" | "MODERATE" | "HIGH" | "CRITICAL" | "EXTREME";

export interface RiskScoreInput {
  mint: MintAccountResult;
  holders: TopHoldersResult;
  liquidity: LiquidityResult | null;
  metadata: MetadataResult | null;
  tokenAge: TokenAgeResult | null;
  honeypot: HoneypotResult | null;
}

export interface RiskScoreResult {
  risk_score: number;
  risk_level: RiskLevel;
}

export function computeRiskScore(input: RiskScoreInput): RiskScoreResult {
  let score = 0;

  // Mint/freeze authority
  if (input.mint.mintAuthority !== null) score += 30;
  if (input.mint.freezeAuthority !== null) score += 25;

  // Top holder concentration
  if (input.holders.top_10_percentage > 50) score += 15;
  if (input.holders.top_1_percentage > 20) score += 10;

  // Liquidity
  if (input.liquidity) {
    if (!input.liquidity.has_liquidity) score += 30;
  }

  // Metadata mutability
  if (input.metadata?.mutable) score += 10;

  // Token age
  if (input.tokenAge?.token_age_hours !== null && input.tokenAge) {
    const ageHours = input.tokenAge.token_age_hours!;
    if (ageHours < 1) score += 10;
    else if (ageHours < 24) score += 5;
  }

  // Token-2022 extension risks
  for (const ext of input.mint.extensions) {
    if (ext.name === "PermanentDelegate" && ext.permanent_delegate) {
      score += 30;
    }
    if (ext.name === "TransferFeeConfig" && ext.transfer_fee_bps != null) {
      if (ext.transfer_fee_bps > 5000) score += 20;
      else if (ext.transfer_fee_bps >= 1000) score += 10;
      else if (ext.transfer_fee_bps > 0) score += 5;
    }
  }

  // Honeypot
  if (input.honeypot) {
    if (!input.honeypot.can_sell) score += 30;
    if (
      input.honeypot.sell_tax_bps != null &&
      input.honeypot.sell_tax_bps > 1000
    ) {
      score += 15;
    }
  }

  score = Math.min(score, 100);
  const risk_level = scoreToLevel(score);
  return { risk_score: score, risk_level };
}

export function generateRiskSummary(input: RiskScoreInput): string {
  const flags: string[] = [];

  if (input.mint.mintAuthority !== null) flags.push("active mint authority");
  if (input.mint.freezeAuthority !== null) flags.push("active freeze authority");
  if (input.holders.top_10_percentage > 50)
    flags.push(`top 10 holders own ${input.holders.top_10_percentage.toFixed(1)}% of supply`);
  if (input.holders.top_1_percentage > 20)
    flags.push(`top holder owns ${input.holders.top_1_percentage.toFixed(1)}%`);
  if (input.liquidity && !input.liquidity.has_liquidity)
    flags.push("no liquidity detected");
  if (input.metadata?.mutable) flags.push("mutable metadata");
  if (input.tokenAge?.token_age_hours != null && input.tokenAge.token_age_hours < 1)
    flags.push("token < 1 hour old");
  else if (input.tokenAge?.token_age_hours != null && input.tokenAge.token_age_hours < 24)
    flags.push("token < 24 hours old");
  for (const ext of input.mint.extensions) {
    if (ext.name === "PermanentDelegate" && ext.permanent_delegate)
      flags.push("permanent delegate set");
    if (ext.name === "TransferFeeConfig" && ext.transfer_fee_bps != null && ext.transfer_fee_bps > 0)
      flags.push(`${(ext.transfer_fee_bps / 100).toFixed(1)}% transfer fee`);
  }
  if (input.honeypot && !input.honeypot.can_sell) flags.push("cannot sell (honeypot)");

  if (flags.length === 0) return "No risk factors detected";
  return flags.join(", ");
}

function scoreToLevel(score: number): RiskLevel {
  if (score <= 20) return "LOW";
  if (score <= 40) return "MODERATE";
  if (score <= 60) return "HIGH";
  if (score <= 80) return "CRITICAL";
  return "EXTREME";
}
