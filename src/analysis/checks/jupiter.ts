/**
 * Shared Jupiter quoting — single source of truth for all Jupiter API calls.
 *
 * Both honeypot detection and liquidity analysis consume quotes from here.
 * fetchRoundTrip() makes exactly 2 calls (buy + sell) instead of the 3 that
 * separate modules were making independently.
 */

const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** 0.1 SOL — small enough for low price impact, large enough for meaningful quote */
const BUY_AMOUNT_LAMPORTS = "100000000";

export interface JupiterQuote {
  outAmount: string;
  priceImpactPct: number | null;
  primaryPool: string | null;
  poolAddress: string | null;
}

export interface JupiterRoundTrip {
  buyQuote: JupiterQuote | null;
  sellQuote: JupiterQuote | null;
}

export async function fetchQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
): Promise<JupiterQuote | null> {
  const url = `${JUPITER_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=500`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;

  const data = await res.json();
  const routes = data.routePlan as
    | Array<{ swapInfo?: { label?: string; ammKey?: string } }>
    | undefined;
  if (!routes || routes.length === 0) return null;

  return {
    outAmount: data.outAmount ?? "0",
    priceImpactPct:
      data.priceImpactPct != null ? parseFloat(data.priceImpactPct) : null,
    primaryPool: routes[0]?.swapInfo?.label ?? null,
    poolAddress: routes[0]?.swapInfo?.ammKey ?? null,
  };
}

/**
 * Buy + sell round-trip via Jupiter (2 sequential HTTP calls).
 * Provides all data needed by both honeypot and liquidity analysis.
 */
export async function fetchRoundTrip(
  mintAddress: string,
): Promise<JupiterRoundTrip> {
  // wSOL special case: can't quote SOL→SOL, use USDC as the pair instead
  const pairMint = mintAddress === SOL_MINT ? USDC_MINT : SOL_MINT;
  const buyAmount = mintAddress === SOL_MINT ? "5000000" : BUY_AMOUNT_LAMPORTS; // 5 USDC vs 0.1 SOL

  const buyQuote = await fetchQuote(pairMint, mintAddress, buyAmount);
  if (!buyQuote || !buyQuote.outAmount || buyQuote.outAmount === "0") {
    return { buyQuote: null, sellQuote: null };
  }

  const sellQuote = await fetchQuote(mintAddress, pairMint, buyQuote.outAmount);
  return { buyQuote, sellQuote };
}
