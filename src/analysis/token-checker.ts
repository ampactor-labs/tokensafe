import { PublicKey } from "@solana/web3.js";
import {
  checkMintAccount,
  type ExtensionInfo,
} from "./checks/mint-authority.js";
import {
  checkTopHolders,
  type TopHoldersResult,
} from "./checks/top-holders.js";
import { checkLiquidity, type LiquidityResult } from "./checks/liquidity.js";
import { checkMetadata, type MetadataResult } from "./checks/metadata.js";
import { checkTokenAge, type TokenAgeResult } from "./checks/token-age.js";
import { analyzeHoneypot, type HoneypotResult } from "./checks/honeypot.js";
import { fetchRoundTrip, type JupiterRoundTrip } from "./checks/jupiter.js";
import {
  computeRiskScore,
  getRiskFactors,
  generateRiskSummary,
  METHODOLOGY_VERSION,
} from "./risk-score.js";
import { ApiError } from "../utils/errors.js";
import { degradedChecksTotal } from "../utils/metrics.js";
import { logger } from "../utils/logger.js";
import { reportRpcFailure, reportRpcSuccess } from "../solana/rpc.js";
import {
  getCached,
  setCached,
  getInflight,
  setInflight,
  getNegativeCached,
  setNegativeCached,
} from "../utils/cache.js";
import { signResponse, getSignerPubkey } from "../utils/response-signer.js";
import {
  detectChanges,
  generateAlerts,
  type ChangeReport,
  type MonitorAlert,
} from "./delta.js";
import { getCheckHistory, setCheckHistory } from "../utils/monitor-cache.js";

export interface TokenCheckResult {
  mint: string;
  name: string | null;
  symbol: string | null;
  checked_at: string;
  cached_at: string | null;
  risk_score: number;
  risk_level: string;
  checks: {
    mint_authority: {
      status: "RENOUNCED" | "ACTIVE";
      authority: string | null;
      risk: "SAFE" | "DANGEROUS";
    };
    freeze_authority: {
      status: "RENOUNCED" | "ACTIVE";
      authority: string | null;
      risk: "SAFE" | "DANGEROUS";
    };
    supply: {
      total: string;
      decimals: number;
    };
    top_holders: {
      status: "OK" | "UNAVAILABLE";
      top_10_percentage: number;
      top_1_percentage: number;
      holder_count_estimate: number | null;
      note: string | null;
      risk: "SAFE" | "HIGH" | "CRITICAL" | "UNKNOWN";
    };
    liquidity: (LiquidityResult & { status: "OK" | "UNAVAILABLE" }) | null;
    metadata: {
      status: "OK" | "UNAVAILABLE";
      update_authority: string | null;
      mutable: boolean;
      has_uri: boolean;
      uri: string | null;
      risk: "SAFE" | "WARNING";
    } | null;
    honeypot: (HoneypotResult & { status: "OK" | "UNAVAILABLE" }) | null;
    token_age_hours: number | null;
    token_age_minutes: number | null;
    created_at: string | null;
    token_program: string;
    is_token_2022: boolean;
    token_2022_extensions: ExtensionInfo[] | null;
  };
  rpc_slot: number;
  methodology_version: string;
  risk_factors: string[];
  summary: string;
  degraded: boolean;
  degraded_checks: string[];
  response_signature: string;
  signer_pubkey: string;
  score_breakdown: Record<string, number>;
  changes: ChangeReport | null;
  alerts: MonitorAlert[];
}

export interface FullReportCTA {
  url: string;
  price_usd: string;
  payment_protocol: string;
  includes: string;
}

export interface TokenCheckLiteResult {
  mint: string;
  name: string | null;
  symbol: string | null;
  risk_score: number;
  risk_level: string;
  summary: string;
  degraded: boolean;
  degraded_checks: string[];
  checks_completed: number;
  checks_total: number;
  is_token_2022: boolean;
  has_risky_extensions: boolean;
  can_sell: boolean | null;
  authorities_renounced: boolean;
  has_liquidity: boolean;
  liquidity_rating: string | null;
  top_10_concentration: number | null;
  token_age_hours: number | null;
  risk_score_delta: number | null;
  previous_risk_score: number | null;
  previous_risk_level: string | null;
  full_report: FullReportCTA;
}

export interface CheckTokenLiteResponse {
  result: TokenCheckLiteResult;
  fromCache: boolean;
}

export interface CheckTokenResponse {
  result: TokenCheckResult;
  fromCache: boolean;
}

export async function checkToken(
  mintAddress: string,
): Promise<CheckTokenResponse> {
  // Validate base58
  try {
    new PublicKey(mintAddress);
  } catch {
    throw new ApiError(
      "INVALID_MINT_ADDRESS",
      `Invalid Solana mint address: ${mintAddress}`,
    );
  }

  // Cache lookup
  const cached = getCached(mintAddress);
  if (cached) {
    return {
      result: { ...cached, cached_at: cached.checked_at },
      fromCache: true,
    };
  }

  // Negative cache — recently-failed mints
  const negErr = getNegativeCached(mintAddress);
  if (negErr) throw negErr;

  // Singleflight — deduplicate concurrent requests for same mint
  const existing = getInflight(mintAddress);
  if (existing) {
    const result = await existing;
    return {
      result: { ...result, cached_at: result.checked_at },
      fromCache: true,
    };
  }

  // Wrap analysis in a promise for singleflight
  const analysisPromise = runAnalysis(mintAddress);
  setInflight(mintAddress, analysisPromise);

  try {
    const result = await analysisPromise;
    const previous = getCheckHistory(mintAddress);
    const changes = previous ? detectChanges(previous, result) : null;
    const alerts = changes
      ? generateAlerts(mintAddress, result.symbol, changes)
      : [];
    setCheckHistory(mintAddress, result);
    const enriched: TokenCheckResult = { ...result, changes, alerts };
    setCached(mintAddress, enriched);
    return { result: enriched, fromCache: false };
  } catch (err) {
    if (err instanceof ApiError) {
      setNegativeCached(mintAddress, err);
    }
    throw err;
  }
}

export async function checkTokenLite(
  mintAddress: string,
  baseUrl?: string,
): Promise<CheckTokenLiteResponse> {
  const { result, fromCache } = await checkToken(mintAddress);
  const extensions = result.checks.token_2022_extensions ?? [];
  const hasRisky = extensions.some(
    (e) =>
      !!e.permanent_delegate ||
      (e.transfer_fee_bps != null && e.transfer_fee_bps > 0) ||
      !!e.transfer_hook_program,
  );
  const TOTAL_CHECKS = 6; // mint_authority, top_holders, liquidity, metadata, token_age, honeypot
  return {
    result: {
      mint: result.mint,
      name: result.name,
      symbol: result.symbol,
      risk_score: result.risk_score,
      risk_level: result.risk_level,
      summary: result.summary,
      degraded: result.degraded,
      degraded_checks: result.degraded_checks,
      checks_completed: TOTAL_CHECKS - result.degraded_checks.length,
      checks_total: TOTAL_CHECKS,
      is_token_2022: result.checks.is_token_2022,
      has_risky_extensions: hasRisky,
      can_sell: result.checks.honeypot?.can_sell ?? null,
      authorities_renounced:
        result.checks.mint_authority.status === "RENOUNCED" &&
        result.checks.freeze_authority.status === "RENOUNCED",
      has_liquidity: result.checks.liquidity?.has_liquidity ?? false,
      liquidity_rating: result.checks.liquidity?.liquidity_rating ?? null,
      top_10_concentration:
        result.checks.top_holders.status === "OK"
          ? result.checks.top_holders.top_10_percentage
          : null,
      token_age_hours: result.checks.token_age_hours ?? null,
      risk_score_delta: result.changes?.risk_score_delta ?? null,
      previous_risk_score: result.changes?.previous_risk_score ?? null,
      previous_risk_level: result.changes?.previous_risk_level ?? null,
      full_report: {
        url: `${baseUrl || ""}/v1/check?mint=${mintAddress}`,
        price_usd: "$0.008",
        payment_protocol: "x402",
        includes:
          "authority addresses, holder breakdown, LP lock status, honeypot details, delta detection",
      },
    },
    fromCache,
  };
}

async function runAnalysis(mintAddress: string): Promise<TokenCheckResult> {
  // Step 1: mint account data (needed for supply → top holders, decimals → honeypot)
  let mintData;
  try {
    mintData = await checkMintAccount(mintAddress);
    reportRpcSuccess();
  } catch (err) {
    reportRpcFailure();
    if (err instanceof ApiError) throw err;
    throw new ApiError(
      "RPC_ERROR",
      "Failed to fetch mint account from RPC",
      (err as Error).message,
    );
  }

  // Step 2: run remaining checks in parallel (fault-isolated)
  // Jupiter round-trip (2 sequential calls) feeds both honeypot + liquidity,
  // saving one external HTTP call vs making them independently.
  const fallbackHolders: TopHoldersResult = {
    status: "UNAVAILABLE",
    top_10_percentage: 0,
    top_1_percentage: 0,
    holder_count_estimate: null,
    top_holders_detail: null,
    note: "Top holders check failed — concentration unknown",
    risk: "UNKNOWN",
  };

  const emptyTrip: JupiterRoundTrip = {
    buyQuote: null,
    sellQuote: null,
    buyInputAmount: 0n,
  };

  const [holders, jupiterTrip, metadata, tokenAge] = await Promise.all([
    checkTopHolders(mintAddress, mintData.supplyRaw)
      .catch((err): TopHoldersResult => {
        logger.warn({ err, mintAddress }, "Top holders check failed");
        return fallbackHolders;
      }),
    fetchRoundTrip(mintAddress).catch((): JupiterRoundTrip => emptyTrip),
    checkMetadata(mintAddress)
      .then((r): (MetadataResult & { status: "OK" | "UNAVAILABLE" }) | null =>
        r ? { ...r, status: "OK" } : null,
      )
      .catch(
        (): (MetadataResult & { status: "OK" | "UNAVAILABLE" }) | null => null,
      ),
    checkTokenAge(mintAddress).catch((): TokenAgeResult | null => null),
  ]);

  // Honeypot: pure computation from Jupiter quotes (no I/O)
  const honeypotRaw: HoneypotResult | null =
    jupiterTrip.buyQuote || jupiterTrip.sellQuote
      ? analyzeHoneypot(
          jupiterTrip.buyQuote,
          jupiterTrip.sellQuote,
          jupiterTrip.buyInputAmount,
        )
      : null;
  const honeypot: (HoneypotResult & { status: "OK" | "UNAVAILABLE" }) | null =
    honeypotRaw ? { ...honeypotRaw, status: "OK" } : null;

  // Liquidity: use buy quote for pool info + price impact, then LP lock detection (RPC)
  const liquidityRaw: LiquidityResult | null = await checkLiquidity(
    mintAddress,
    jupiterTrip.buyQuote,
  ).catch((): LiquidityResult | null => null);
  const liquidity: (LiquidityResult & { status: "OK" | "UNAVAILABLE" }) | null =
    liquidityRaw ? { ...liquidityRaw, status: "OK" } : null;

  // Token-2022 embedded metadata fallback (pump.fun tokens use this instead of Metaplex)
  const tokenMetadataExt = mintData.extensions.find(
    (e) => e.name === "TokenMetadata",
  );

  // Build effective metadata for risk scoring: prefer Metaplex, fall back to Token-2022
  const SYSTEM_PROGRAM = "11111111111111111111111111111111";
  let effectiveMetadata = metadata;
  if (!metadata && tokenMetadataExt) {
    const mutable =
      tokenMetadataExt.update_authority != null &&
      tokenMetadataExt.update_authority !== SYSTEM_PROGRAM;
    effectiveMetadata = {
      name: tokenMetadataExt.token_name ?? null,
      symbol: tokenMetadataExt.token_symbol ?? null,
      update_authority: tokenMetadataExt.update_authority ?? null,
      mutable,
      has_uri: !!tokenMetadataExt.token_uri,
      uri: tokenMetadataExt.token_uri ?? null,
      risk: mutable ? "WARNING" : "SAFE",
      status: "OK",
    };
  }

  // Degraded = which checks couldn't run. Token-2022 metadata counts as metadata.
  // Built BEFORE scoring so uncertainty penalties apply.
  const degradedChecks: string[] = [];
  if (holders.status === "UNAVAILABLE") degradedChecks.push("top_holders");
  if (liquidity === null) degradedChecks.push("liquidity");
  if (metadata === null && !tokenMetadataExt) degradedChecks.push("metadata");
  if (honeypot === null) degradedChecks.push("honeypot");
  if (tokenAge === null || (tokenAge.token_age_hours === null && !tokenAge.established))
    degradedChecks.push("token_age");
  const degraded = degradedChecks.length > 0;

  // Instrument degraded checks for observability
  for (const check of degradedChecks) {
    degradedChecksTotal.labels(check).inc();
  }

  const riskInput = {
    mint: mintData,
    holders,
    liquidity,
    metadata: effectiveMetadata,
    tokenAge,
    honeypot,
    degradedChecks,
  };
  const { risk_score, risk_level, breakdown } = computeRiskScore(riskInput);
  const risk_factors = getRiskFactors(riskInput);
  const summary = generateRiskSummary(riskInput);

  const checked_at = new Date().toISOString();

  return {
    mint: mintAddress,
    name: metadata?.name ?? tokenMetadataExt?.token_name ?? null,
    symbol: metadata?.symbol ?? tokenMetadataExt?.token_symbol ?? null,
    checked_at,
    cached_at: null,
    risk_score,
    risk_level,
    checks: {
      mint_authority: {
        status: mintData.mintAuthority === null ? "RENOUNCED" : "ACTIVE",
        authority: mintData.mintAuthority,
        risk: mintData.mintAuthority === null ? "SAFE" : "DANGEROUS",
      },
      freeze_authority: {
        status: mintData.freezeAuthority === null ? "RENOUNCED" : "ACTIVE",
        authority: mintData.freezeAuthority,
        risk: mintData.freezeAuthority === null ? "SAFE" : "DANGEROUS",
      },
      supply: {
        total: mintData.supplyRaw.toString(),
        decimals: mintData.decimals,
      },
      top_holders: holders,
      liquidity,
      metadata: effectiveMetadata
        ? {
            status: effectiveMetadata.status,
            update_authority: effectiveMetadata.update_authority,
            mutable: effectiveMetadata.mutable,
            has_uri: effectiveMetadata.has_uri,
            uri: effectiveMetadata.uri,
            risk: effectiveMetadata.risk,
          }
        : null,
      honeypot,
      token_age_hours: tokenAge?.token_age_hours ?? null,
      token_age_minutes: tokenAge?.token_age_minutes ?? null,
      created_at: tokenAge?.created_at ?? null,
      token_program: mintData.tokenProgram,
      is_token_2022: mintData.isToken2022,
      token_2022_extensions:
        mintData.extensions.length > 0 ? mintData.extensions : null,
    },
    rpc_slot: mintData.rpcSlot,
    methodology_version: METHODOLOGY_VERSION,
    risk_factors,
    summary,
    degraded,
    degraded_checks: degradedChecks,
    score_breakdown: breakdown,
    response_signature: signResponse({
      mint: mintAddress,
      checked_at,
      rpc_slot: mintData.rpcSlot,
      risk_score,
    }),
    signer_pubkey: getSignerPubkey(),
    changes: null,
    alerts: [],
  };
}
