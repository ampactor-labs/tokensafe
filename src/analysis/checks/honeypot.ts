import { logger } from "../../utils/logger.js";

export interface HoneypotResult {
  can_sell: boolean;
  sell_tax_bps: number | null;
  risk: "SAFE" | "WARNING" | "DANGEROUS";
}

const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const SOL_MINT = "So11111111111111111111111111111111111111112";

export async function checkHoneypot(
  mintAddress: string,
  decimals: number,
): Promise<HoneypotResult> {
  const amount = Math.pow(10, decimals).toString();
  const url = `${JUPITER_QUOTE_URL}?inputMint=${mintAddress}&outputMint=${SOL_MINT}&amount=${amount}&slippageBps=5000`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return { can_sell: false, sell_tax_bps: null, risk: "DANGEROUS" };
    }

    const data = await res.json();
    const routes = data.routePlan;
    if (!routes || routes.length === 0) {
      return { can_sell: false, sell_tax_bps: null, risk: "DANGEROUS" };
    }

    return { can_sell: true, sell_tax_bps: null, risk: "SAFE" };
  } catch (err) {
    logger.warn({ err, mintAddress }, "Honeypot check failed");
    return { can_sell: false, sell_tax_bps: null, risk: "DANGEROUS" };
  }
}
