import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../../solana/rpc.js";
import { logger } from "../../utils/logger.js";

export interface TokenAgeResult {
  token_age_hours: number | null;
  created_at: string | null;
}

export async function checkTokenAge(
  mintAddress: string,
): Promise<TokenAgeResult> {
  const connection = getConnection();
  const mintPubkey = new PublicKey(mintAddress);

  try {
    // Fetch up to 1000 signatures (returned newest-first).
    // The last entry is the oldest we can see in one call.
    // For young tokens (<1000 txs) this gives exact creation time.
    // For older tokens the lower bound is sufficient — if the oldest
    // signature in the batch is >24h old, age risk = 0 regardless.
    const sigs = await connection.getSignaturesForAddress(mintPubkey, {
      limit: 1000,
    });

    if (sigs.length === 0) {
      return { token_age_hours: null, created_at: null };
    }

    const oldest = sigs[sigs.length - 1];
    if (!oldest.blockTime) {
      return { token_age_hours: null, created_at: null };
    }

    const createdMs = oldest.blockTime * 1000;
    const ageMs = Date.now() - createdMs;
    const ageHours = Math.round((ageMs / (1000 * 60 * 60)) * 100) / 100;

    return {
      token_age_hours: Math.max(0, ageHours),
      created_at: new Date(createdMs).toISOString(),
    };
  } catch (err) {
    logger.warn({ err, mintAddress }, "Token age check failed");
    return { token_age_hours: null, created_at: null };
  }
}
