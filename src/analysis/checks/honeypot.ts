import { logger } from "../../utils/logger.js";

export interface HoneypotResult {
  can_sell: boolean;
  sell_tax_bps: number | null;
  risk: "SAFE" | "WARNING" | "DANGEROUS";
}

const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Test buy amount: 0.1 SOL (100M lamports).
 * Small enough to minimize price impact, large enough for meaningful quote.
 */
const BUY_AMOUNT = "100000000";

/**
 * Below this threshold, the measured sell tax is likely estimation noise
 * from DEX fee variance, rounding, and price impact modelling error.
 */
const NOISE_FLOOR_BPS = 100;

interface JupiterQuoteData {
  outAmount: string;
  priceImpactPct?: string;
  routePlan?: unknown[];
}

async function jupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
): Promise<JupiterQuoteData | null> {
  const url = `${JUPITER_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=500`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.routePlan || data.routePlan.length === 0) return null;
  return data as JupiterQuoteData;
}

/**
 * Honeypot detection via Jupiter round-trip.
 *
 * 1. Buy: SOL → TOKEN (0.1 SOL in)
 * 2. Sell: TOKEN → SOL (all tokens received from buy)
 * 3. Compare SOL out vs SOL in. The difference beyond expected losses
 *    (price impact + DEX fees) is the sell tax.
 *
 * If the buy quote fails → token has no liquidity (handled elsewhere).
 * If the sell quote fails → true honeypot (can buy but not sell).
 */
export async function checkHoneypot(
  mintAddress: string,
  _decimals: number,
): Promise<HoneypotResult> {
  try {
    // Step 1: Buy — SOL → TOKEN
    const buyQuote = await jupiterQuote(SOL_MINT, mintAddress, BUY_AMOUNT);
    if (!buyQuote || !buyQuote.outAmount || buyQuote.outAmount === "0") {
      // No buy route = no liquidity (not a honeypot per se, but can't trade)
      return { can_sell: false, sell_tax_bps: null, risk: "DANGEROUS" };
    }

    // Step 2: Sell — TOKEN → SOL (exact amount received from buy)
    const sellQuote = await jupiterQuote(
      mintAddress,
      SOL_MINT,
      buyQuote.outAmount,
    );
    if (!sellQuote) {
      // Can buy but can't sell = classic honeypot
      return { can_sell: false, sell_tax_bps: null, risk: "DANGEROUS" };
    }

    // Step 3: Compute sell tax from round-trip loss
    const solSpent = BigInt(BUY_AMOUNT);
    const solReturned = BigInt(sellQuote.outAmount);

    let sell_tax_bps: number | null = null;

    if (solSpent > 0n && solReturned <= solSpent) {
      const lossRatio = Number(solSpent - solReturned) / Number(solSpent);

      // Expected losses that aren't sell tax:
      // - Price impact on buy side (Jupiter reports as % of input)
      // - Price impact on sell side
      // - DEX swap fees (~0.25% each way = 0.5% round-trip)
      const buyImpact = buyQuote.priceImpactPct
        ? Math.abs(parseFloat(buyQuote.priceImpactPct)) / 100
        : 0;
      const sellImpact = sellQuote.priceImpactPct
        ? Math.abs(parseFloat(sellQuote.priceImpactPct)) / 100
        : 0;
      const expectedLoss = buyImpact + sellImpact + 0.005;

      const taxRatio = Math.max(0, lossRatio - expectedLoss);
      const rawBps = Math.round(taxRatio * 10000);

      // Below noise floor, treat as zero
      sell_tax_bps = rawBps >= NOISE_FLOOR_BPS ? rawBps : 0;
    } else if (solReturned > solSpent) {
      // Gained SOL on round-trip (possible with rebasing tokens) — no sell tax
      sell_tax_bps = 0;
    }

    // Determine risk level from sell tax magnitude
    let risk: HoneypotResult["risk"] = "SAFE";
    if (sell_tax_bps !== null && sell_tax_bps >= 1000) {
      risk = "DANGEROUS"; // 10%+ sell tax
    } else if (sell_tax_bps !== null && sell_tax_bps >= 500) {
      risk = "WARNING"; // 5-10% sell tax
    }

    return { can_sell: true, sell_tax_bps, risk };
  } catch (err) {
    logger.warn({ err, mintAddress }, "Honeypot check failed");
    return { can_sell: false, sell_tax_bps: null, risk: "DANGEROUS" };
  }
}
