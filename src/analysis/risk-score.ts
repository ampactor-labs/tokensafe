import type { MintAccountResult } from "./checks/mint-authority.js";
import type { TopHoldersResult } from "./checks/top-holders.js";
import type { LiquidityResult } from "./checks/liquidity.js";
import type { MetadataResult } from "./checks/metadata.js";
import type { TokenAgeResult } from "./checks/token-age.js";
import type { HoneypotResult } from "./checks/honeypot.js";

export const METHODOLOGY_VERSION = "1.0.0";

export type RiskLevel = "LOW" | "MODERATE" | "HIGH" | "CRITICAL" | "EXTREME";

export interface RiskScoreInput {
  mint: MintAccountResult;
  holders: TopHoldersResult;
  liquidity: LiquidityResult | null;
  metadata: MetadataResult | null;
  tokenAge: TokenAgeResult | null;
  honeypot: HoneypotResult | null;
  degradedChecks?: string[];
}

export interface RiskScoreResult {
  risk_score: number;
  risk_level: RiskLevel;
  breakdown: Record<string, number>;
}

/**
 * Known mint authorities that are NOT rug-risk indicators.
 * e.g. Circle maintains mint authority on USDC for CCTP minting.
 */
const TRUSTED_MINT_AUTHORITIES = new Set([
  // Circle USDC mint authority — verified from mainnet getAccountInfo
  "BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG",
  // Tether USDT mint authority — verified from mainnet getAccountInfo
  "Q6XprfkF8RQQKoQVG33xT88H7wi8Uk1B1CC7YAs69Gi",
  // Marinade mSOL stake pool — verified from mainnet getAccountInfo
  "3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM",
  // Jito jitoSOL stake pool — verified from mainnet getAccountInfo
  "6iQKfEyhr3bZMotVkW6beNZz5CPAkiwvgV2CTje9pVSS",
  // SolBlaze bSOL stake pool — verified from mainnet getAccountInfo
  "6WecYymEARvjG5ZyqkrVQ6YkhPfujNzWpSPwNKXHCbV2",
  // Paxos PYUSD mint authority — verified from mainnet getAccountInfo
  "8Jornc27vtAYPkwDzsZVgLQchAYyC8nD7aCNPCDV8Qk2",
]);

/**
 * Known freeze authorities that are NOT rug-risk indicators.
 * e.g. Circle uses freeze authority on USDC for regulatory compliance.
 */
const TRUSTED_FREEZE_AUTHORITIES = new Set([
  // Circle USDC freeze authority — verified from mainnet getAccountInfo
  "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar",
  // Tether USDT freeze authority — verified from mainnet getAccountInfo
  "Q6XprfkF8RQQKoQVG33xT88H7wi8Uk1B1CC7YAs69Gi",
  // Paxos PYUSD freeze authority — verified from mainnet getAccountInfo
  "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
]);

export function isTrustedMintAuthority(addr: string): boolean {
  return TRUSTED_MINT_AUTHORITIES.has(addr);
}

export function isTrustedFreezeAuthority(addr: string): boolean {
  return TRUSTED_FREEZE_AUTHORITIES.has(addr);
}

export function getMaturitySignals(input: RiskScoreInput): number {
  const hasDeepLiquidity =
    input.liquidity?.liquidity_rating === "DEEP" ||
    (input.liquidity?.price_impact_pct != null &&
      input.liquidity.price_impact_pct < 1.0);
  const isEstablished = input.tokenAge?.established === true;
  const isDistributed =
    input.holders.top_10_percentage > 0 && input.holders.top_10_percentage < 30;
  return (
    (hasDeepLiquidity ? 1 : 0) +
    (isEstablished ? 1 : 0) +
    (isDistributed ? 1 : 0)
  );
}

export function computeRiskScore(input: RiskScoreInput): RiskScoreResult {
  let score = 0;
  const breakdown: Record<string, number> = {};

  function add(key: string, pts: number) {
    score += pts;
    breakdown[key] = (breakdown[key] ?? 0) + pts;
  }

  // Maturity signals reduce authority penalties for institutional tokens
  // Established = token has 100+ transactions (set by token-age check).
  // RPC timeout (tokenAge === null) does NOT count as established.
  const maturitySignals = getMaturitySignals(input);

  // Mint authority — floor penalties ensure active untrusted authorities
  // always score meaningfully, even with maturity signals (anti-gaming)
  if (input.mint.mintAuthority !== null) {
    if (TRUSTED_MINT_AUTHORITIES.has(input.mint.mintAuthority)) {
      // No penalty for known trusted authorities
    } else if (maturitySignals >= 2) {
      add("mint_authority", 15);
    } else if (maturitySignals === 1) {
      add("mint_authority", 20);
    } else {
      add("mint_authority", 30);
    }
  }

  // Freeze authority — same floor logic as mint authority
  if (
    input.mint.freezeAuthority !== null &&
    !TRUSTED_FREEZE_AUTHORITIES.has(input.mint.freezeAuthority)
  ) {
    if (maturitySignals >= 2) {
      add("freeze_authority", 10);
    } else if (maturitySignals === 1) {
      add("freeze_authority", 15);
    } else {
      add("freeze_authority", 25);
    }
  }

  // Top 10 concentration (graduated, mutually exclusive)
  const t10 = input.holders.top_10_percentage;
  if (t10 > 80) add("top_holders_10", 25);
  else if (t10 > 50) add("top_holders_10", 20);
  else if (t10 > 30) add("top_holders_10", 10);

  // Top 1 concentration (graduated, always applied — no liquidity exemption)
  const t1 = input.holders.top_1_percentage;
  if (t1 > 50) add("top_holders_1", 25);
  else if (t1 > 30) add("top_holders_1", 15);
  else if (t1 > 20) add("top_holders_1", 10);
  else if (t1 > 10) add("top_holders_1", 5);

  // Liquidity
  if (input.liquidity) {
    if (!input.liquidity.has_liquidity) add("liquidity", 30);
    else if (input.liquidity.lp_locked === false) add("liquidity", 15);
  }

  // Metadata mutability (context-aware: established tokens need mutable metadata)
  if (input.metadata?.mutable) add("metadata", maturitySignals >= 2 ? 5 : 10);

  // Token age — skip established tokens (100+ txs = clearly not new)
  if (
    input.tokenAge?.token_age_hours !== null &&
    input.tokenAge &&
    !input.tokenAge.established
  ) {
    const ageHours = input.tokenAge.token_age_hours!;
    if (ageHours < 1) add("token_age", 10);
    else if (ageHours < 24) add("token_age", 5);
  }

  // Token-2022 extension risks
  for (const ext of input.mint.extensions) {
    if (ext.name === "PermanentDelegate" && ext.permanent_delegate) {
      add("permanent_delegate", 30);
    }
    if (ext.name === "TransferFeeConfig" && ext.transfer_fee_bps != null) {
      if (ext.transfer_fee_bps > 5000) add("transfer_fee", 20);
      else if (ext.transfer_fee_bps >= 1000) add("transfer_fee", 10);
      else if (ext.transfer_fee_bps > 0) add("transfer_fee", 5);
    }
    if (ext.name === "TransferHook" && ext.transfer_hook_program) {
      add("transfer_hook", 15);
    }
  }

  // Honeypot
  if (input.honeypot) {
    if (input.honeypot.can_sell === false) {
      add("honeypot", 30);
    } else if (input.honeypot.can_sell === null) {
      add("honeypot", 10);
    }
    if (input.honeypot.sell_tax_bps != null) {
      if (input.honeypot.sell_tax_bps > 1000) add("sell_tax", 15);
      else if (input.honeypot.sell_tax_bps > 0) add("sell_tax", 5);
    }
  }

  // Uncertainty penalties for degraded checks
  if (input.degradedChecks && input.degradedChecks.length > 0) {
    const penalties: Record<string, number> = {
      top_holders: 10,
      liquidity: 10,
      honeypot: 10,
      token_age: 5,
      metadata: 3,
    };
    for (const check of input.degradedChecks) {
      const pts = penalties[check];
      if (pts) add(`uncertainty_${check}`, pts);
    }
  }

  score = Math.min(score, 100);
  const risk_level = scoreToLevel(score);
  return { risk_score: score, risk_level, breakdown };
}

export function getRiskFactors(input: RiskScoreInput): string[] {
  const flags: string[] = [];

  if (
    input.mint.mintAuthority !== null &&
    !TRUSTED_MINT_AUTHORITIES.has(input.mint.mintAuthority)
  ) {
    flags.push("active mint authority");
  }
  if (
    input.mint.freezeAuthority !== null &&
    !TRUSTED_FREEZE_AUTHORITIES.has(input.mint.freezeAuthority)
  ) {
    flags.push("active freeze authority");
  }
  if (input.holders.top_10_percentage > 30)
    flags.push(
      `top 10 holders own ${input.holders.top_10_percentage.toFixed(1)}% of supply`,
    );
  if (input.holders.top_1_percentage > 10)
    flags.push(`top holder owns ${input.holders.top_1_percentage.toFixed(1)}%`);
  if (input.liquidity && !input.liquidity.has_liquidity)
    flags.push("no liquidity detected");
  else if (
    input.liquidity?.has_liquidity &&
    input.liquidity.lp_locked === false
  )
    flags.push("LP not locked");
  if (input.metadata?.mutable && getMaturitySignals(input) < 2)
    flags.push("mutable metadata");
  if (
    input.tokenAge?.token_age_hours != null &&
    !input.tokenAge.established &&
    input.tokenAge.token_age_hours < 1
  )
    flags.push("token < 1 hour old");
  else if (
    input.tokenAge?.token_age_hours != null &&
    !input.tokenAge.established &&
    input.tokenAge.token_age_hours < 24
  )
    flags.push("token < 24 hours old");
  for (const ext of input.mint.extensions) {
    if (ext.name === "PermanentDelegate" && ext.permanent_delegate)
      flags.push("permanent delegate set");
    if (
      ext.name === "TransferFeeConfig" &&
      ext.transfer_fee_bps != null &&
      ext.transfer_fee_bps > 0
    )
      flags.push(`${(ext.transfer_fee_bps / 100).toFixed(1)}% transfer fee`);
    if (ext.name === "TransferHook" && ext.transfer_hook_program)
      flags.push("transfer hook set — arbitrary code runs on every transfer");
  }
  if (input.honeypot && input.honeypot.can_sell === false)
    flags.push("cannot sell (honeypot)");
  if (input.honeypot && input.honeypot.can_sell === null)
    flags.push("sell-side unverifiable (no Jupiter route)");
  if (input.honeypot?.sell_tax_bps != null && input.honeypot.sell_tax_bps > 0) {
    flags.push(`${(input.honeypot.sell_tax_bps / 100).toFixed(1)}% sell tax`);
  }

  // Uncertainty flags for degraded checks
  if (input.degradedChecks) {
    for (const check of input.degradedChecks) {
      flags.push(`${check} data unavailable — score reflects uncertainty`);
    }
  }

  return flags;
}

export function generateRiskSummary(input: RiskScoreInput): string {
  const flags = getRiskFactors(input);

  // When degraded, separate real risk factors from uncertainty notes
  const degraded = input.degradedChecks ?? [];
  if (degraded.length > 0) {
    const realFlags = flags.filter((f) => !f.includes("data unavailable"));
    const uncertaintyNote = `Note: ${degraded.length} check(s) unavailable (${degraded.join(", ")}) — score includes uncertainty penalties.`;
    if (realFlags.length === 0) return uncertaintyNote;
    return `${realFlags.join(", ")}. ${uncertaintyNote}`;
  }

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
