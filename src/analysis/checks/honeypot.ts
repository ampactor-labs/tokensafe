import type { JupiterQuote } from "./jupiter.js";

export interface HoneypotResult {
  can_sell: boolean;
  sell_tax_bps: number | null;
  risk: "SAFE" | "WARNING" | "DANGEROUS";
}

/** Must match BUY_AMOUNT_LAMPORTS in jupiter.ts */
const BUY_AMOUNT_LAMPORTS = 100_000_000n;

/**
 * Below this threshold, measured sell tax is likely estimation noise
 * from DEX fee variance, rounding, and price impact modelling error.
 */
const NOISE_FLOOR_BPS = 100;

/**
 * Analyze honeypot risk from pre-fetched Jupiter round-trip quotes.
 * Pure computation — no HTTP calls.
 *
 * 1. If buy quote is null → no liquidity (handled by liquidity check)
 * 2. If sell quote is null → true honeypot (can buy but not sell)
 * 3. Otherwise → compute sell tax from round-trip loss minus expected losses
 */
export function analyzeHoneypot(
  buyQuote: JupiterQuote | null,
  sellQuote: JupiterQuote | null,
): HoneypotResult {
  if (!buyQuote || !buyQuote.outAmount || buyQuote.outAmount === "0") {
    return { can_sell: false, sell_tax_bps: null, risk: "DANGEROUS" };
  }

  if (!sellQuote) {
    return { can_sell: false, sell_tax_bps: null, risk: "DANGEROUS" };
  }

  const solSpent = BUY_AMOUNT_LAMPORTS;
  const solReturned = BigInt(sellQuote.outAmount);

  let sell_tax_bps: number | null = null;

  if (solSpent > 0n && solReturned <= solSpent) {
    const lossRatio = Number(solSpent - solReturned) / Number(solSpent);

    // Expected losses that aren't sell tax:
    // - Price impact on buy side
    // - Price impact on sell side
    // - DEX swap fees (~0.25% each way = 0.5% round-trip)
    const buyImpact = buyQuote.priceImpactPct
      ? Math.abs(buyQuote.priceImpactPct) / 100
      : 0;
    const sellImpact = sellQuote.priceImpactPct
      ? Math.abs(sellQuote.priceImpactPct) / 100
      : 0;
    const expectedLoss = buyImpact + sellImpact + 0.005;

    const taxRatio = Math.max(0, lossRatio - expectedLoss);
    const rawBps = Math.round(taxRatio * 10000);

    sell_tax_bps = rawBps >= NOISE_FLOOR_BPS ? rawBps : 0;
  } else if (solReturned > solSpent) {
    // Gained SOL on round-trip (possible with rebasing tokens) — no sell tax
    sell_tax_bps = 0;
  }

  let risk: HoneypotResult["risk"] = "SAFE";
  if (sell_tax_bps !== null && sell_tax_bps >= 1000) {
    risk = "DANGEROUS"; // 10%+ sell tax
  } else if (sell_tax_bps !== null && sell_tax_bps >= 500) {
    risk = "WARNING"; // 5-10% sell tax
  }

  return { can_sell: true, sell_tax_bps, risk };
}
