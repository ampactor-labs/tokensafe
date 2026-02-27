import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../../solana/rpc.js";

export interface TopHoldersResult {
  top_10_percentage: number;
  top_1_percentage: number;
  holder_count_estimate: number | null;
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
      risk: "SAFE",
    };
  }

  // Use BigInt arithmetic for precision, convert to percentage at the end
  const totalSupply = Number(totalSupplyRaw);
  const top10 = accounts.slice(0, 10);
  const top10Sum = top10.reduce((sum, a) => sum + Number(BigInt(a.amount)), 0);
  const top1Amount = Number(BigInt(accounts[0].amount));

  const top10Pct = (top10Sum / totalSupply) * 100;
  const top1Pct = (top1Amount / totalSupply) * 100;

  // If fewer than 20 accounts returned, that's the actual holder count
  const holderCountEstimate = accounts.length < 20 ? accounts.length : null;

  let risk: TopHoldersResult["risk"] = "SAFE";
  if (top10Pct > 50 && top1Pct > 20) {
    risk = "CRITICAL";
  } else if (top10Pct > 50 || top1Pct > 20) {
    risk = "HIGH";
  }

  return {
    top_10_percentage: Math.round(top10Pct * 100) / 100,
    top_1_percentage: Math.round(top1Pct * 100) / 100,
    holder_count_estimate: holderCountEstimate,
    risk,
  };
}
