import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../../solana/rpc.js";
import { logger } from "../../utils/logger.js";
import type { JupiterQuote } from "./jupiter.js";
import { fetchDexScreenerLiquidity } from "./dexscreener.js";
// Note: Jupiter quoting is centralized in jupiter.ts (fetchRoundTrip).
// checkLiquidity() always receives a pre-fetched quote from the orchestrator.

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface LiquidityResult {
  has_liquidity: boolean;
  primary_pool: string | null;
  pool_address: string | null;
  price_impact_pct: number | null;
  liquidity_rating: "DEEP" | "MODERATE" | "SHALLOW" | "NONE" | null;
  lp_locked: boolean | null;
  lp_lock_percentage: number | null;
  lp_lock_expiry: string | null;
  lp_mint: string | null;
  lp_locker: string | null;
  pool_vault_addresses: string[] | null;
  risk: "SAFE" | "WARNING" | "HIGH" | "CRITICAL";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAYDIUM_AMM_V4_ACCOUNT_LEN = 752;
// Raydium AMM v4 account layout offsets (pubkeys region):
// Verified empirically against SOL/USDC pool 58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2
// offset 336 = baseVault (token account holding base token)
// offset 368 = quoteVault (token account holding quote token)
// offset 400 = baseMint, offset 432 = quoteMint
// offset 464 = lpMint
const BASE_VAULT_OFFSET = 336;
const QUOTE_VAULT_OFFSET = 368;
const LP_MINT_OFFSET = 464;

import { KNOWN_LOCKERS } from "./known-programs.js";
// Re-export for backwards compatibility (tests import from liquidity.ts)
export { KNOWN_LOCKERS };

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface JupiterData {
  primaryPool: string | null;
  poolAddress: string | null;
  priceImpactPct: number | null;
}

interface LpLockResult {
  lp_locked: boolean;
  lp_lock_percentage: number;
  lp_mint: string;
  locked_in: string | null;
  pool_vault_addresses: string[];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function checkLiquidity(
  mintAddress: string,
  prefetchedQuote?: JupiterQuote | null,
): Promise<LiquidityResult | null> {
  try {
    // Step 1: Jupiter quote — existence + depth (Level 1)
    const jupiter: JupiterData | null = prefetchedQuote
      ? {
          primaryPool: prefetchedQuote.primaryPool,
          poolAddress: prefetchedQuote.poolAddress,
          priceImpactPct: prefetchedQuote.priceImpactPct,
        }
      : null;
    if (!jupiter) {
      // Fallback: DexScreener (catches CLMM-only pools, Jupiter timeouts/429s)
      const dex = await fetchDexScreenerLiquidity(mintAddress);
      if (dex && dex.has_liquidity) {
        return {
          has_liquidity: true,
          primary_pool: dex.primary_pool,
          pool_address: dex.pool_address,
          price_impact_pct: null,
          liquidity_rating: dex.liquidity_rating,
          lp_locked: null,
          lp_lock_percentage: null,
          lp_lock_expiry: null,
          lp_mint: null,
          lp_locker: null,
          pool_vault_addresses: null,
          risk: dex.liquidity_rating === "SHALLOW" || dex.liquidity_rating === "NONE" ? "WARNING" : "SAFE",
        };
      }
      // DexScreener confirmed no pairs exist → genuine no-liquidity
      if (dex && !dex.has_liquidity) {
        return noLiquidity();
      }
      // Both sources failed → unknown, not confirmed absent
      return null;
    }

    const rating = deriveRating(jupiter.priceImpactPct);

    // Step 2: LP lock detection (Level 2) — only for Raydium AMM v4
    let lpLock: LpLockResult | null = null;
    if (
      jupiter.poolAddress &&
      jupiter.primaryPool?.toLowerCase().includes("raydium")
    ) {
      try {
        lpLock = await detectLpLock(jupiter.poolAddress);
      } catch (err) {
        logger.warn(
          { err, mintAddress, pool: jupiter.poolAddress },
          "LP lock detection failed",
        );
      }
    }

    // Step 3: Determine risk
    const risk = determineRisk(rating, lpLock);

    return {
      has_liquidity: true,
      primary_pool: jupiter.primaryPool,
      pool_address: jupiter.poolAddress,
      price_impact_pct: jupiter.priceImpactPct,
      liquidity_rating: rating,
      lp_locked: lpLock?.lp_locked ?? null,
      lp_lock_percentage: lpLock?.lp_lock_percentage ?? null,
      lp_lock_expiry: null,
      lp_mint: lpLock?.lp_mint ?? null,
      lp_locker: lpLock?.locked_in ?? null,
      pool_vault_addresses: lpLock?.pool_vault_addresses ?? null,
      risk,
    };
  } catch (err) {
    logger.warn({ err, mintAddress }, "Liquidity check failed completely");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Liquidity rating from price impact
// ---------------------------------------------------------------------------

function deriveRating(
  priceImpactPct: number | null,
): LiquidityResult["liquidity_rating"] {
  if (priceImpactPct == null) return null;
  if (priceImpactPct < 1) return "DEEP";
  if (priceImpactPct < 5) return "MODERATE";
  if (priceImpactPct < 20) return "SHALLOW";
  return "NONE";
}

// ---------------------------------------------------------------------------
// LP lock detection (Level 2)
// ---------------------------------------------------------------------------

/**
 * Reads the Raydium AMM v4 pool account to find the LP mint, then checks
 * top LP holders against known locker programs.
 *
 * Returns null if the pool type is unsupported or data can't be read.
 */
async function detectLpLock(poolAddress: string): Promise<LpLockResult | null> {
  const connection = getConnection();
  const poolPubkey = new PublicKey(poolAddress);

  // 1. Read pool account to extract LP mint
  const poolInfo = await connection.getAccountInfo(poolPubkey);
  if (!poolInfo) return null;
  if (poolInfo.owner.toBase58() !== RAYDIUM_AMM_V4) return null;
  if (poolInfo.data.length !== RAYDIUM_AMM_V4_ACCOUNT_LEN) return null;

  const baseVault = new PublicKey(poolInfo.data.subarray(BASE_VAULT_OFFSET, BASE_VAULT_OFFSET + 32)).toBase58();
  const quoteVault = new PublicKey(poolInfo.data.subarray(QUOTE_VAULT_OFFSET, QUOTE_VAULT_OFFSET + 32)).toBase58();

  const lpMintBytes = poolInfo.data.subarray(
    LP_MINT_OFFSET,
    LP_MINT_OFFSET + 32,
  );
  const lpMint = new PublicKey(lpMintBytes);

  // 2. Get top LP holders
  const largestAccounts = await connection.getTokenLargestAccounts(lpMint);
  const accounts = largestAccounts.value;
  if (accounts.length === 0) return null;

  const totalVisible = accounts.reduce((sum, a) => sum + BigInt(a.amount), 0n);
  if (totalVisible === 0n) return null;

  // 3. Batch-read top 5 token accounts to find their owners
  const top5 = accounts.slice(0, 5);
  const accountInfos = await connection.getMultipleAccountsInfo(
    top5.map((a) => a.address),
  );

  let lockedAmount = 0n;
  let lockedIn: string | null = null;

  for (let i = 0; i < top5.length; i++) {
    const info = accountInfos[i];
    if (!info || info.data.length < 64) continue;

    // SPL Token account layout: mint(32) + owner(32) + ...
    const ownerPubkey = new PublicKey(info.data.subarray(32, 64));
    const ownerStr = ownerPubkey.toBase58();

    const lockerName = KNOWN_LOCKERS.get(ownerStr);
    if (lockerName) {
      lockedAmount += BigInt(top5[i].amount);
      if (!lockedIn) lockedIn = lockerName;
    }
  }

  const lockedPct =
    totalVisible > 0n
      ? Number((lockedAmount * 10000n) / totalVisible) / 100
      : 0;

  return {
    lp_locked: lockedPct > 0,
    lp_lock_percentage: Math.round(lockedPct * 10) / 10,
    lp_mint: lpMint.toBase58(),
    locked_in: lockedIn,
    pool_vault_addresses: [baseVault, quoteVault],
  };
}

// ---------------------------------------------------------------------------
// Risk determination
// ---------------------------------------------------------------------------

function determineRisk(
  rating: LiquidityResult["liquidity_rating"],
  lpLock: LpLockResult | null,
): LiquidityResult["risk"] {
  const isShallow = rating === "SHALLOW" || rating === "NONE";
  const isUnlocked = lpLock !== null && !lpLock.lp_locked;

  if (isShallow && isUnlocked) return "HIGH";
  if (isShallow || isUnlocked) return "WARNING";
  return "SAFE";
}

// ---------------------------------------------------------------------------
// No-liquidity fallback
// ---------------------------------------------------------------------------

function noLiquidity(): LiquidityResult {
  return {
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
    risk: "CRITICAL",
  };
}
