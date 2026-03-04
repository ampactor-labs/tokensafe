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

const TOP_HOLDERS_TIMEOUT_MS = 15_000;

async function getTokenLargestAccountsDirect(
  mintAddress: string,
): Promise<Array<{ address: string; amount: string }>> {
  const res = await fetch(config.heliusRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenLargestAccounts",
      params: [mintAddress],
    }),
    signal: AbortSignal.timeout(TOP_HOLDERS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as {
    error?: { message: string };
    result?: { value: Array<{ address: string; amount: string }> };
  };
  if (json.error) throw new Error(json.error.message);
  return json.result!.value;
}

export async function checkTopHolders(
  mintAddress: string,
  totalSupplyRaw: bigint,
): Promise<TopHoldersResult> {
  let accounts;
  try {
    accounts = await getTokenLargestAccountsDirect(mintAddress);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), mintAddress },
      "getTokenLargestAccounts failed",
    );
    return unavailableHolders(
      "Top holder data unavailable (RPC error) — concentration unknown",
    );
  }

  if (totalSupplyRaw === 0n) {
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

  if (accounts.length === 0) {
    return unavailableHolders(
      "Token has supply but no holder accounts found — concentration unknown",
    );
  }

  return computeConcentration(accounts, totalSupplyRaw, null);
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
