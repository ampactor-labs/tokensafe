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
    // Fetch up to 10 signatures (returned newest-first). If 10th-oldest sig is >24h, age risk = 0.
    // For <10 sigs, exact creation time.
    const sigPromise = connection.getSignaturesForAddress(mintPubkey, {
      limit: 10,
    });
    const sigs = await Promise.race([
      sigPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Token age RPC timeout")), 5000),
      ),
    ]);

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
