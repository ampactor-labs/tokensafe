import { logger } from "../../utils/logger.js";

export interface LiquidityResult {
  has_liquidity: boolean;
  primary_pool: string | null;
  lp_locked: null; // v2: LP lock detection
  lp_lock_percentage: null;
  lp_lock_expiry: null;
  risk: "SAFE" | "HIGH" | "CRITICAL";
}

const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const SOL_MINT = "So11111111111111111111111111111111111111112";

export async function checkLiquidity(
  mintAddress: string,
): Promise<LiquidityResult> {
  try {
    const url = `${JUPITER_QUOTE_URL}?inputMint=${mintAddress}&outputMint=${SOL_MINT}&amount=1000000&slippageBps=500`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return noLiquidity();
    }

    const data = await response.json();
    const routes = data.routePlan as
      | Array<{ swapInfo?: { label?: string } }>
      | undefined;

    if (!routes || routes.length === 0) {
      return noLiquidity();
    }

    const primaryPool = routes[0]?.swapInfo?.label ?? null;

    return {
      has_liquidity: true,
      primary_pool: primaryPool,
      lp_locked: null,
      lp_lock_percentage: null,
      lp_lock_expiry: null,
      risk: "SAFE",
    };
  } catch (err) {
    logger.warn({ err, mintAddress }, "Jupiter liquidity check failed");
    return noLiquidity();
  }
}

function noLiquidity(): LiquidityResult {
  return {
    has_liquidity: false,
    primary_pool: null,
    lp_locked: null,
    lp_lock_percentage: null,
    lp_lock_expiry: null,
    risk: "CRITICAL",
  };
}
