import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../../solana/rpc.js";
import { logger } from "../../utils/logger.js";
import type { JupiterQuote } from "./jupiter.js";

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
  risk: "SAFE" | "WARNING" | "HIGH" | "CRITICAL";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const SOL_MINT = "So11111111111111111111111111111111111111112";

const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAYDIUM_AMM_V4_ACCOUNT_LEN = 752;
// lpMint offset in Raydium AMM v4 account layout (32 u64s + 5 u128s + 3 u64s + 4 pubkeys = 432 bytes)
const LP_MINT_OFFSET = 432;

/** Known LP locker program addresses → human-readable name */
export const KNOWN_LOCKERS = new Map<string, string>([
  // Streamflow
  ["strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m", "Streamflow"],
  // UNCX AMM V4
  ["UNCX77nZrA3TdAxMEggqG18xxpgiNGT6iqyynPwpoxN", "UNCX"],
  ["GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo", "UNCX"],
  ["DAtFFs2mhQFvrgNLA29vEDeTLLN8vHknAaAhdLEc4SQH", "UNCX"],
  // UNCX CPMM
  ["UNCXdvMRxvz91g3HqFmpZ5NgmL77UH4QRM4NfeL4mQB", "UNCX"],
  ["FEmGEWdxCBSJ1QFKeX5B6k7VTDPwNU3ZLdfgJkvGYrH5", "UNCX"],
  // UNCX CLMM
  ["UNCXrB8cZXnmtYM1aSo1Wx3pQaeSZYuF2jCTesXvECs", "UNCX"],
  ["GAYWATob4bqCj3fhVm8ZxoMSqUW2fb6e6SBQ7kk5qyps", "UNCX"],
  // UNCX general
  ["BzKincxjgFQjj4FmhaWrwHES1ekBGN73YesA7JwJJo7X", "UNCX"],
]);

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
  locked_in: string | null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function checkLiquidity(
  mintAddress: string,
  prefetchedQuote?: JupiterQuote | null,
): Promise<LiquidityResult> {
  try {
    // Step 1: Jupiter quote — existence + depth (Level 1)
    // Use pre-fetched quote from shared round-trip when available
    const jupiter: JupiterData | null =
      prefetchedQuote !== undefined
        ? prefetchedQuote
          ? {
              primaryPool: prefetchedQuote.primaryPool,
              poolAddress: prefetchedQuote.poolAddress,
              priceImpactPct: prefetchedQuote.priceImpactPct,
            }
          : null
        : await fetchJupiterQuote(mintAddress);
    if (!jupiter) return noLiquidity();

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
      risk,
    };
  } catch (err) {
    logger.warn({ err, mintAddress }, "Jupiter liquidity check failed");
    return noLiquidity();
  }
}

// ---------------------------------------------------------------------------
// Jupiter quote
// ---------------------------------------------------------------------------

async function fetchJupiterQuote(
  mintAddress: string,
): Promise<JupiterData | null> {
  const url = `${JUPITER_QUOTE_URL}?inputMint=${mintAddress}&outputMint=${SOL_MINT}&amount=1000000&slippageBps=500`;
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });

  if (!response.ok) return null;

  const data = await response.json();
  const routes = data.routePlan as
    | Array<{ swapInfo?: { label?: string; ammKey?: string } }>
    | undefined;

  if (!routes || routes.length === 0) return null;

  return {
    primaryPool: routes[0]?.swapInfo?.label ?? null,
    poolAddress: routes[0]?.swapInfo?.ammKey ?? null,
    priceImpactPct:
      data.priceImpactPct != null ? parseFloat(data.priceImpactPct) : null,
  };
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
async function detectLpLock(
  poolAddress: string,
): Promise<LpLockResult | null> {
  const connection = getConnection();
  const poolPubkey = new PublicKey(poolAddress);

  // 1. Read pool account to extract LP mint
  const poolInfo = await connection.getAccountInfo(poolPubkey);
  if (!poolInfo) return null;
  if (poolInfo.owner.toBase58() !== RAYDIUM_AMM_V4) return null;
  if (poolInfo.data.length !== RAYDIUM_AMM_V4_ACCOUNT_LEN) return null;

  const lpMintBytes = poolInfo.data.subarray(
    LP_MINT_OFFSET,
    LP_MINT_OFFSET + 32,
  );
  const lpMint = new PublicKey(lpMintBytes);

  // 2. Get top LP holders
  const largestAccounts = await connection.getTokenLargestAccounts(lpMint);
  const accounts = largestAccounts.value;
  if (accounts.length === 0) return null;

  const totalVisible = accounts.reduce(
    (sum, a) => sum + BigInt(a.amount),
    0n,
  );
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
    locked_in: lockedIn,
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
    risk: "CRITICAL",
  };
}
