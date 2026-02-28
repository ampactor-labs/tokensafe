import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../../solana/rpc.js";

export interface HolderDetail {
  address: string;
  percentage: number;
}

export interface TopHoldersResult {
  top_10_percentage: number;
  top_1_percentage: number;
  holder_count_estimate: number | null;
  top_holders_detail: HolderDetail[] | null;
  note: string | null;
  risk: "SAFE" | "HIGH" | "CRITICAL";
}

export async function checkTopHolders(
  mintAddress: string,
  totalSupplyRaw: bigint,
): Promise<TopHoldersResult> {
  const connection = getConnection();
  const largestAccounts = await connection.getTokenLargestAccounts(
    new PublicKey(mintAddress),
  );

  const accounts = largestAccounts.value;

  if (totalSupplyRaw === 0n || accounts.length === 0) {
    return {
      top_10_percentage: 0,
      top_1_percentage: 0,
      holder_count_estimate: 0,
      top_holders_detail: null,
      note: null,
      risk: "SAFE",
    };
  }

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
    address: a.address.toBase58(),
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
    top_10_percentage: top10Pct,
    top_1_percentage: top1Pct,
    holder_count_estimate: holderCountEstimate,
    top_holders_detail,
    note: null,
    risk,
  };
}
