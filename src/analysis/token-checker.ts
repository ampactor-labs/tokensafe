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
      risk: "SAFE" | "HIGH" | "CRITICAL";
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
    token_program: string;
    is_token_2022: boolean;
    token_2022_extensions: ExtensionInfo[] | null;
  };
  rpc_slot: number;
  methodology_version: string;
  risk_factors: string[];
  summary: string;
  degraded: boolean;
  response_signature: string;
  signer_pubkey: string;
}

export interface TokenCheckLiteResult {
  mint: string;
  risk_score: number;
  risk_level: string;
  summary: string;
  full_report: string;
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
    setCached(mintAddress, result);
    return { result, fromCache: false };
  } catch (err) {
    if (err instanceof ApiError) {
      setNegativeCached(mintAddress, err);
    }
    throw err;
  }
}

export async function checkTokenLite(
  mintAddress: string,
): Promise<CheckTokenLiteResponse> {
  const { result, fromCache } = await checkToken(mintAddress);
  return {
    result: {
      mint: result.mint,
      risk_score: result.risk_score,
      risk_level: result.risk_level,
      summary: result.summary,
      full_report:
        "Pay $0.005 via x402 at GET /v1/check?mint=" +
        mintAddress +
        " for the full detailed analysis",
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
  const fallbackHolders: TopHoldersResult & { status: "OK" | "UNAVAILABLE" } = {
    status: "UNAVAILABLE",
    top_10_percentage: 0,
    top_1_percentage: 0,
    holder_count_estimate: null,
    top_holders_detail: null,
    note: null,
    risk: "SAFE",
  };

  const emptyTrip: JupiterRoundTrip = {
    buyQuote: null,
    sellQuote: null,
    buyInputAmount: 0n,
  };

  const [holders, jupiterTrip, metadata, tokenAge] = await Promise.all([
    checkTopHolders(mintAddress, mintData.supplyRaw)
      .then((r): TopHoldersResult & { status: "OK" | "UNAVAILABLE" } => ({
        ...r,
        status: "OK",
      }))
      .catch((err): TopHoldersResult & { status: "OK" | "UNAVAILABLE" } => {
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

  // Post-processing: holder note for AMM vault ambiguity
  const holderNote =
    liquidity?.has_liquidity && holders.top_1_percentage > 20
      ? "Top holder may be an AMM vault (token has active liquidity)"
      : null;

  const riskInput = {
    mint: mintData,
    holders,
    liquidity,
    metadata,
    tokenAge,
    honeypot,
  };
  const { risk_score, risk_level } = computeRiskScore(riskInput);
  const risk_factors = getRiskFactors(riskInput);
  const summary = generateRiskSummary(riskInput);
  const degraded =
    holders.status === "UNAVAILABLE" ||
    liquidity === null ||
    metadata === null ||
    honeypot === null;

  const checked_at = new Date().toISOString();

  return {
    mint: mintAddress,
    name: metadata?.name ?? null,
    symbol: metadata?.symbol ?? null,
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
      top_holders: { ...holders, note: holderNote },
      liquidity,
      metadata: metadata
        ? {
            status: metadata.status,
            update_authority: metadata.update_authority,
            mutable: metadata.mutable,
            has_uri: metadata.has_uri,
            uri: metadata.uri,
            risk: metadata.risk,
          }
        : null,
      honeypot,
      token_age_hours: tokenAge?.token_age_hours ?? null,
      token_age_minutes: tokenAge?.token_age_minutes ?? null,
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
    response_signature: signResponse({
      mint: mintAddress,
      checked_at,
      rpc_slot: mintData.rpcSlot,
      risk_score,
    }),
    signer_pubkey: getSignerPubkey(),
  };
}
