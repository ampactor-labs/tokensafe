/**
 * DexScreener fallback for liquidity detection.
 * Used when Jupiter returns null (timeout, rate limit, CLMM-only pool).
 * Free API, no auth, 60 req/min.
 */

import { logger } from "../../utils/logger.js";

export interface DexScreenerLiquidity {
  has_liquidity: boolean;
  primary_pool: string | null;
  pool_address: string | null;
  liquidity_usd: number;
  liquidity_rating: "DEEP" | "MODERATE" | "SHALLOW" | "NONE";
}

interface DexScreenerPair {
  dexId?: string;
  pairAddress?: string;
  liquidity?: { usd?: number };
}

export async function fetchDexScreenerLiquidity(
  mintAddress: string,
): Promise<DexScreenerLiquidity | null> {
  try {
    const url = `https://api.dexscreener.com/token-pairs/v1/solana/${mintAddress}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (!res.ok) {
      logger.warn(
        { status: res.status, mintAddress },
        "DexScreener HTTP error",
      );
      return null;
    }

    const pairs = await res.json();
    if (!Array.isArray(pairs) || pairs.length === 0) return null;

    // Find best pair by liquidity
    let bestPair: DexScreenerPair | null = null;
    let bestLiquidity = 0;

    for (const pair of pairs as DexScreenerPair[]) {
      const liqUsd = pair.liquidity?.usd ?? 0;
      if (liqUsd > bestLiquidity) {
        bestLiquidity = liqUsd;
        bestPair = pair;
      }
    }

    if (!bestPair || bestLiquidity === 0) return null;

    return {
      has_liquidity: true,
      primary_pool: bestPair.dexId ?? null,
      pool_address: bestPair.pairAddress ?? null,
      liquidity_usd: bestLiquidity,
      liquidity_rating: deriveRatingFromUsd(bestLiquidity),
    };
  } catch (err) {
    logger.warn({ err, mintAddress }, "DexScreener liquidity check failed");
    return null;
  }
}

function deriveRatingFromUsd(
  usd: number,
): DexScreenerLiquidity["liquidity_rating"] {
  if (usd >= 100_000) return "DEEP";
  if (usd >= 10_000) return "MODERATE";
  if (usd >= 1_000) return "SHALLOW";
  return "NONE";
}
