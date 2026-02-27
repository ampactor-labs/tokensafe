import { PublicKey } from "@solana/web3.js";
import { checkMintAccount } from "./checks/mint-authority.js";
import { checkTopHolders } from "./checks/top-holders.js";
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
    liquidity: null;
    metadata: null;
    token_age_hours: null;
    is_token_2022: boolean;
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

  const mintData = await checkMintAccount(mintAddress);
  const holders = await checkTopHolders(mintAddress, mintData.supplyRaw);
  const { risk_score, risk_level } = computeRiskScore(mintData, holders);

  return {
    mint: mintAddress,
    name: null,
    symbol: null,
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
      liquidity: null,
      metadata: null,
      token_age_hours: null,
      is_token_2022: mintData.isToken2022,
    },
  };
}
