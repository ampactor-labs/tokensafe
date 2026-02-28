import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../../solana/rpc.js";
import { logger } from "../../utils/logger.js";

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
    // Fetch up to 100 signatures (returned newest-first).
    // If 100 return, the token has >100 txs — established, no age penalty.
    // If <100, we have the complete history and the last sig is creation time.
    const sigPromise = connection.getSignaturesForAddress(mintPubkey, {
      limit: 100,
    });
    const sigs = await Promise.race([
      sigPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Token age RPC timeout")), 5000),
      ),
    ]);

    if (sigs.length === 0) {
      return {
        token_age_hours: null,
        token_age_minutes: null,
        created_at: null,
      };
    }

    // Established token: 100 sigs returned means >100 txs total.
    // Use oldest of returned sigs as minimum age lower bound.
    if (sigs.length === 100) {
      const oldest = sigs[sigs.length - 1];
      if (oldest.blockTime) {
        const createdAt = new Date(oldest.blockTime * 1000);
        const ageMs = Date.now() - createdAt.getTime();
        return {
          token_age_hours: Math.max(
            0,
            Math.round((ageMs / 3_600_000) * 100) / 100,
          ),
          token_age_minutes: Math.max(0, Math.round(ageMs / 60_000)),
          created_at: createdAt.toISOString(),
          established: true,
        };
      }
      return {
        token_age_hours: null,
        token_age_minutes: null,
        created_at: null,
        established: true,
      };
    }

    const oldest = sigs[sigs.length - 1];
    if (!oldest.blockTime) {
      return {
        token_age_hours: null,
        token_age_minutes: null,
        created_at: null,
      };
    }

    const createdMs = oldest.blockTime * 1000;
    const ageMs = Date.now() - createdMs;
    const ageHours = Math.round((ageMs / (1000 * 60 * 60)) * 100) / 100;

    return {
      token_age_hours: Math.max(0, ageHours),
      token_age_minutes: Math.max(0, Math.round(ageMs / 60_000)),
      created_at: new Date(createdMs).toISOString(),
    };
  } catch (err) {
    logger.warn({ err, mintAddress }, "Token age check failed");
    return { token_age_hours: null, token_age_minutes: null, created_at: null };
  }
}
