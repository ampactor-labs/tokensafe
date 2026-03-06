import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../../solana/rpc.js";
import { logger } from "../../utils/logger.js";
import { withRetry } from "../../solana/rpc.js";

export interface TokenAgeResult {
  token_age_hours: number | null;
  token_age_minutes: number | null;
  created_at: string | null;
  established?: boolean;
}

export async function checkTokenAge(
  mintAddress: string,
): Promise<TokenAgeResult> {
  const connection = getConnection();
  const mintPubkey = new PublicKey(mintAddress);

  try {
    // Phase 1: Cheap probe — limit: 2 (1 RPC credit instead of 1000)
    const probe = await withRetry(
      () =>
        Promise.race([
          connection.getSignaturesForAddress(mintPubkey, { limit: 2 }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Token age RPC timeout")), 5000),
          ),
        ]),
      "token-age-probe",
    );

    if (probe.length === 0) {
      return {
        token_age_hours: null,
        token_age_minutes: null,
        created_at: null,
      };
    }

    // 1 sig = exact creation time, done (no Phase 2 needed)
    if (probe.length === 1) {
      return ageFromSig(probe[0]);
    }

    // 2 sigs returned = need more data to determine established vs exact age
    // Phase 2: limit: 100
    const sigs = await withRetry(
      () =>
        Promise.race([
          connection.getSignaturesForAddress(mintPubkey, { limit: 100 }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Token age RPC timeout")), 5000),
          ),
        ]),
      "token-age-full",
    );

    // 100 sigs returned = established token (>100 txs total)
    if (sigs.length === 100) {
      return {
        token_age_hours: null,
        token_age_minutes: null,
        created_at: null,
        established: true,
      };
    }

    // <100 sigs = complete history, oldest sig is creation time
    const oldest = sigs[sigs.length - 1];
    return ageFromSig(oldest);
  } catch (err) {
    logger.warn({ err, mintAddress }, "Token age check failed");
    return { token_age_hours: null, token_age_minutes: null, created_at: null };
  }
}

function ageFromSig(sig: { blockTime?: number | null }): TokenAgeResult {
  if (!sig.blockTime) {
    return {
      token_age_hours: null,
      token_age_minutes: null,
      created_at: null,
    };
  }

  const createdMs = sig.blockTime * 1000;
  const ageMs = Date.now() - createdMs;
  const ageHours = Math.round((ageMs / (1000 * 60 * 60)) * 100) / 100;

  return {
    token_age_hours: Math.max(0, ageHours),
    token_age_minutes: Math.max(0, Math.round(ageMs / 60_000)),
    created_at: new Date(createdMs).toISOString(),
  };
}
