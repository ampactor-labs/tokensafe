import { PublicKey } from "@solana/web3.js";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { withRetry } from "../../solana/rpc.js";
import { isKnownDefiProgram } from "./known-programs.js";

export interface HolderDetail {
  address: string;
  percentage: number;
  owner: string | null;
  owner_program: string | null;
  is_protocol_account: boolean;
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
  return withRetry(async () => {
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
  }, "getTokenLargestAccounts");
}

interface OwnerInfo {
  owner: string;
  isOnCurve: boolean;
  /** The program that owns the PDA (null for wallets or if resolution failed) */
  ownerProgram: string | null;
}

/**
 * Resolves token account owners via getMultipleAccounts (2-phase).
 *
 * Phase 1: Read token accounts → extract owner pubkeys (bytes 32-63).
 * Phase 2: For off-curve (PDA) owners, read those accounts to find their
 *          owning program. This determines if the PDA belongs to a known
 *          DeFi protocol vs an unknown/attacker program.
 *
 * Returns map of tokenAccountAddress → { owner, isOnCurve, ownerProgram }.
 */
async function resolveOwners(
  tokenAccountAddresses: string[],
  resolvePrograms = true,
): Promise<Map<string, OwnerInfo>> {
  const result = new Map<string, OwnerInfo>();
  if (tokenAccountAddresses.length === 0) return result;

  // Phase 1: Resolve token account → owner pubkey
  const res = await fetch(config.heliusRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "getMultipleAccounts",
      params: [tokenAccountAddresses, { encoding: "base64" }],
    }),
    signal: AbortSignal.timeout(TOP_HOLDERS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as {
    error?: { message: string };
    result?: { value: Array<{ data: [string, string] } | null> };
  };
  if (json.error) throw new Error(json.error.message);

  const accounts = json.result?.value ?? [];
  const pdaOwners: string[] = []; // PDA owner addresses for Phase 2
  const pdaOwnerToTokenAccts = new Map<string, string[]>(); // PDA owner → token account addresses

  for (let i = 0; i < tokenAccountAddresses.length; i++) {
    const account = accounts[i];
    if (!account?.data?.[0]) continue;

    try {
      const buf = Buffer.from(account.data[0], "base64");
      if (buf.length < 64) continue;
      const ownerBytes = buf.subarray(32, 64);
      const ownerPubkey = new PublicKey(ownerBytes);
      const ownerStr = ownerPubkey.toBase58();
      const onCurve = PublicKey.isOnCurve(ownerBytes);

      result.set(tokenAccountAddresses[i], {
        owner: ownerStr,
        isOnCurve: onCurve,
        ownerProgram: null,
      });

      // Collect off-curve (PDA) owners for Phase 2
      if (!onCurve && !pdaOwnerToTokenAccts.has(ownerStr)) {
        pdaOwners.push(ownerStr);
        pdaOwnerToTokenAccts.set(ownerStr, []);
      }
      if (!onCurve) {
        pdaOwnerToTokenAccts.get(ownerStr)!.push(tokenAccountAddresses[i]);
      }
    } catch {
      // Malformed account data — skip
    }
  }

  // Phase 2: Resolve PDA owner addresses → their owning program
  // Skipped when resolvePrograms=false (low-concentration tokens where PDA
  // exclusion doesn't affect scoring)
  if (resolvePrograms && pdaOwners.length > 0) {
    try {
      const res2 = await fetch(config.heliusRpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "getMultipleAccounts",
          params: [
            pdaOwners,
            { encoding: "base64", dataSlice: { offset: 0, length: 0 } },
          ],
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res2.ok) throw new Error(`RPC HTTP ${res2.status}`);
      const json2 = (await res2.json()) as {
        error?: { message: string };
        result?: { value: Array<{ owner: string } | null> };
      };
      if (json2.error) throw new Error(json2.error.message);

      const pdaAccounts = json2.result?.value ?? [];
      for (let i = 0; i < pdaOwners.length; i++) {
        const pdaAccount = pdaAccounts[i];
        if (!pdaAccount?.owner) continue;

        const programId = pdaAccount.owner;
        const tokenAccts = pdaOwnerToTokenAccts.get(pdaOwners[i]) ?? [];
        for (const tokenAcct of tokenAccts) {
          const info = result.get(tokenAcct);
          if (info) {
            info.ownerProgram = programId;
          }
        }
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "PDA owner program resolution failed — treating unknown PDAs as wallets",
      );
      // Phase 2 failure: ownerProgram stays null → conservative (counted as wallets)
    }
  }

  return result;
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

  // Quick concentration check to decide if Phase 2 PDA resolution is needed.
  // Phase 2 costs 0-1 extra RPC — skip for low-concentration tokens where
  // PDA exclusion wouldn't affect scoring (top10 <30% AND top1 <10%).
  const SCALE_QUICK = 10000n;
  const quickTop10 = accounts
    .slice(0, 10)
    .reduce((s, a) => s + BigInt(a.amount), 0n);
  const quickTop1 = BigInt(accounts[0].amount);
  const needsPhase2 =
    totalSupplyRaw > 0n &&
    (Number((quickTop10 * SCALE_QUICK) / totalSupplyRaw) / 100 > 30 ||
      Number((quickTop1 * SCALE_QUICK) / totalSupplyRaw) / 100 > 10);

  // Resolve owners to classify PDA (protocol) vs wallet accounts
  let ownerMap: Map<string, OwnerInfo> | null = null;
  try {
    const addresses = accounts.slice(0, 10).map((a) => a.address);
    ownerMap = await resolveOwners(addresses, needsPhase2);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), mintAddress },
      "resolveOwners failed — falling back to raw concentration",
    );
  }

  return computeConcentration(accounts, totalSupplyRaw, ownerMap);
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
  ownerMap: Map<string, OwnerInfo> | null,
): TopHoldersResult {
  // Scaled BigInt arithmetic: scale by 1M for 0.01% precision, then convert to percentage
  const SCALE = 1_000_000n;
  const top10 = accounts.slice(0, 10);

  // If fewer than 20 accounts returned, that's the actual holder count
  const holderCountEstimate = accounts.length < 20 ? accounts.length : null;

  // Build enriched holder details with owner + PDA classification
  // is_protocol_account = true only when off-curve AND owned by a known DeFi program
  const top_holders_detail: HolderDetail[] = top10.map((a) => {
    const addr =
      typeof a.address === "string" ? a.address : a.address.toBase58();
    const info = ownerMap?.get(addr) ?? null;
    const isOffCurve = info?.isOnCurve === false;
    const isKnownProgram =
      isOffCurve &&
      info?.ownerProgram != null &&
      isKnownDefiProgram(info.ownerProgram);
    return {
      address: addr,
      percentage:
        Math.round(Number((BigInt(a.amount) * SCALE) / totalSupplyRaw)) /
        10_000,
      owner: info?.owner ?? null,
      owner_program: info?.ownerProgram ?? null,
      is_protocol_account: isKnownProgram,
    };
  });

  // Compute raw concentration (all accounts)
  const top10Scaled = top10.reduce(
    (sum, a) => sum + (BigInt(a.amount) * SCALE) / totalSupplyRaw,
    0n,
  );
  const top1Scaled = (BigInt(accounts[0].amount) * SCALE) / totalSupplyRaw;
  const rawTop10Pct = Math.round(Number(top10Scaled)) / 10_000;
  const rawTop1Pct = Math.round(Number(top1Scaled)) / 10_000;

  // Compute adjusted concentration excluding PDA-owned accounts (for scoring)
  let top10Pct = rawTop10Pct;
  let top1Pct = rawTop1Pct;
  let note: string | null = null;

  if (ownerMap && ownerMap.size > 0) {
    const walletHolders = top_holders_detail.filter(
      (h) => !h.is_protocol_account,
    );
    const pdaCount = top_holders_detail.filter(
      (h) => h.is_protocol_account,
    ).length;

    if (pdaCount > 0 && walletHolders.length > 0) {
      // Recompute from wallet-only holders
      const adjTop10 = walletHolders.slice(0, 10);
      top10Pct =
        Math.round(adjTop10.reduce((sum, h) => sum + h.percentage, 0) * 100) /
        100;
      top1Pct = Math.round(adjTop10[0].percentage * 100) / 100;
      note = `Adjusted for protocol account exclusion (${pdaCount} PDA-owned account${pdaCount > 1 ? "s" : ""} excluded from scoring)`;
    }
    // If ALL holders are PDAs → use raw concentration (prevent false 0%)
    // If no PDAs → no adjustment, no note
  }

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
