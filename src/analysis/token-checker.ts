import { PublicKey } from "@solana/web3.js";
import { checkMintAccount } from "./checks/mint-authority.js";
import { checkTopHolders } from "./checks/top-holders.js";
import { checkLiquidity, type LiquidityResult } from "./checks/liquidity.js";
import { checkMetadata, type MetadataResult } from "./checks/metadata.js";
import { checkTokenAge, type TokenAgeResult } from "./checks/token-age.js";
import { computeRiskScore } from "./risk-score.js";
import { ApiError } from "../utils/errors.js";

export interface TokenCheckResult {
  mint: string;
  name: string | null;
  symbol: string | null;
  checked_at: string;
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
      top_10_percentage: number;
      top_1_percentage: number;
      holder_count_estimate: number | null;
      risk: "SAFE" | "HIGH" | "CRITICAL";
    };
    liquidity: LiquidityResult | null;
    metadata: {
      mutable: boolean;
      has_uri: boolean;
      uri_accessible: boolean;
      risk: "SAFE" | "WARNING";
    } | null;
    token_age_hours: number | null;
    is_token_2022: boolean;
    token_2022_extensions: string[] | null;
  };
}

export async function checkToken(
  mintAddress: string,
): Promise<TokenCheckResult> {
  // Validate base58
  try {
    new PublicKey(mintAddress);
  } catch {
    throw new ApiError(
      "INVALID_MINT_ADDRESS",
      `Invalid Solana mint address: ${mintAddress}`,
    );
  }

  // Step 1: mint account data (needed for supply → top holders)
  const mintData = await checkMintAccount(mintAddress);

  // Step 2: run remaining checks in parallel
  const [holders, liquidity, metadata, tokenAge] = await Promise.all([
    checkTopHolders(mintAddress, mintData.supplyRaw),
    checkLiquidity(mintAddress).catch((): LiquidityResult | null => null),
    checkMetadata(mintAddress).catch((): MetadataResult | null => null),
    checkTokenAge(mintAddress).catch((): TokenAgeResult | null => null),
  ]);

  const { risk_score, risk_level } = computeRiskScore({
    mint: mintData,
    holders,
    liquidity,
    metadata,
    tokenAge,
  });

  return {
    mint: mintAddress,
    name: metadata?.name ?? null,
    symbol: metadata?.symbol ?? null,
    checked_at: new Date().toISOString(),
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
      metadata: metadata
        ? {
            mutable: metadata.mutable,
            has_uri: metadata.has_uri,
            uri_accessible: metadata.has_uri, // v1: URI existence = accessibility
            risk: metadata.risk,
          }
        : null,
      token_age_hours: tokenAge?.token_age_hours ?? null,
      is_token_2022: mintData.isToken2022,
      token_2022_extensions:
        mintData.extensions.length > 0 ? mintData.extensions : null,
    },
  };
}
