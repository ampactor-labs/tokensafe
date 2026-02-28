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
    // If 1000 return, the token has >1000 txs — established, no age penalty.
    // If <1000, we have the complete history and the last sig is creation time.
    const sigPromise = connection.getSignaturesForAddress(mintPubkey, {
      limit: 1000,
    });
    const sigs = await Promise.race([
      sigPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Token age RPC timeout")), 8000),
      ),
    ]);

    if (sigs.length === 0) {
      return { token_age_hours: null, created_at: null };
    }

    // Established token: >1000 txs means it's not new — skip age penalty
    if (sigs.length === 1000) {
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
