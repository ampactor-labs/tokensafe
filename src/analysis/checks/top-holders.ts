import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../../solana/rpc.js";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

export interface HolderDetail {
  address: string;
  percentage: number;
}

export interface TopHoldersResult {
  status: "OK" | "UNAVAILABLE";
  top_10_percentage: number;
  top_1_percentage: number;
  holder_count_estimate: number | null;
  top_holders_detail: HolderDetail[] | null;
  note: string | null;
  risk: "SAFE" | "HIGH" | "CRITICAL" | "UNKNOWN";
}

export async function checkTopHolders(
  mintAddress: string,
  totalSupplyRaw: bigint,
): Promise<TopHoldersResult> {
  const connection = getConnection();
  let largestAccounts;
  try {
    largestAccounts = await connection.getTokenLargestAccounts(
      new PublicKey(mintAddress),
    );
  } catch (err) {
    // Any RPC failure (timeout, rate limit, "Too many accounts", etc.)
    // → try Helius DAS before giving up
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), mintAddress },
      "getTokenLargestAccounts failed, trying DAS fallback",
    );
    return fetchTopHoldersDAS(mintAddress, totalSupplyRaw);
  }

  const accounts = largestAccounts.value;

  if (totalSupplyRaw === 0n || accounts.length === 0) {
    return {
      status: "OK",
      top_10_percentage: 0,
      top_1_percentage: 0,
      holder_count_estimate: 0,
      top_holders_detail: null,
      note: null,
      risk: "SAFE",
    };
  }

  return computeConcentration(accounts, totalSupplyRaw, null);
}

/**
 * Helius DAS `getTokenAccounts` fallback — fetches up to 3 pages (3000 accounts),
 * sorts client-side by amount, and computes top-10/top-1 concentration.
 */
async function fetchTopHoldersDAS(
  mintAddress: string,
  totalSupplyRaw: bigint,
): Promise<TopHoldersResult> {
  try {
    const rpcUrl = config.heliusRpcUrl;
    const allAccounts: Array<{ address: string; amount: string }> = [];

    for (let page = 1; page <= 3; page++) {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "tokensafe-das",
          method: "getTokenAccounts",
          params: {
            mint: mintAddress,
            page,
            limit: 1000,
            options: { showZeroBalance: false },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        logger.warn({ status: res.status, mintAddress }, "Helius DAS getTokenAccounts HTTP error");
        break;
      }

      const data = await res.json();
      const accounts = data?.result?.token_accounts;
      if (!Array.isArray(accounts) || accounts.length === 0) break;

      for (const acct of accounts) {
        if (acct.amount && acct.address) {
          allAccounts.push({ address: acct.address, amount: acct.amount });
        }
      }

      // Less than 1000 results means no more pages
      if (accounts.length < 1000) break;
    }

    if (allAccounts.length === 0 || totalSupplyRaw === 0n) {
      return unavailableHolders("Token has too many holders and DAS returned no accounts — concentration unknown");
    }

    // Sort by amount descending, take top 10
    allAccounts.sort((a, b) => {
      const diff = BigInt(b.amount) - BigInt(a.amount);
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    });

    const rpcStyleAccounts = allAccounts.slice(0, 20).map((a) => ({
      address: { toBase58: () => a.address },
      amount: a.amount,
    }));

    const result = computeConcentration(
      rpcStyleAccounts as any,
      totalSupplyRaw,
      `Approximated from top ${Math.min(allAccounts.length, 3000)} accounts (Helius DAS)`,
    );
    // DAS doesn't give total holder count
    result.holder_count_estimate = null;
    return result;
  } catch (err) {
    logger.warn({ err, mintAddress }, "Helius DAS top holders fallback failed");
    return unavailableHolders("Token has too many holders and DAS fallback failed — concentration unknown");
  }
}

function unavailableHolders(note: string): TopHoldersResult {
  return {
    status: "UNAVAILABLE",
    top_10_percentage: 0,
    top_1_percentage: 0,
    holder_count_estimate: null,
    top_holders_detail: null,
    note,
    risk: "UNKNOWN",
  };
}

function computeConcentration(
  accounts: Array<{ address: { toBase58(): string } | string; amount: string }>,
  totalSupplyRaw: bigint,
  note: string | null,
): TopHoldersResult {
  // Scaled BigInt arithmetic: scale by 1M for 0.01% precision, then convert to percentage
  const SCALE = 1_000_000n;
  const top10 = accounts.slice(0, 10);
  const top10Scaled = top10.reduce(
    (sum, a) => sum + (BigInt(a.amount) * SCALE) / totalSupplyRaw,
    0n,
  );
  const top1Scaled = (BigInt(accounts[0].amount) * SCALE) / totalSupplyRaw;

  const top10Pct = Math.round(Number(top10Scaled)) / 10_000;
  const top1Pct = Math.round(Number(top1Scaled)) / 10_000;

  // If fewer than 20 accounts returned, that's the actual holder count
  const holderCountEstimate = accounts.length < 20 ? accounts.length : null;

  // Top 10 holder addresses + percentages
  const top_holders_detail: HolderDetail[] = top10.map((a) => ({
    address: typeof a.address === "string" ? a.address : a.address.toBase58(),
    percentage:
      Math.round(Number((BigInt(a.amount) * SCALE) / totalSupplyRaw)) / 10_000,
  }));

  let risk: TopHoldersResult["risk"] = "SAFE";
  if (top10Pct > 50 && top1Pct > 20) {
    risk = "CRITICAL";
  } else if (top10Pct > 50 || top1Pct > 20) {
    risk = "HIGH";
  }

  return {
    status: "OK",
    top_10_percentage: top10Pct,
    top_1_percentage: top1Pct,
    holder_count_estimate: holderCountEstimate,
    top_holders_detail,
    note,
    risk,
  };
}
