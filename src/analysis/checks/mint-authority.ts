import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { getConnection } from "../../solana/rpc.js";
import { ApiError } from "../../utils/errors.js";

const SPL_TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const TOKEN_2022_PROGRAM = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

export interface MintAccountResult {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supplyRaw: bigint;
  decimals: number;
  isToken2022: boolean;
}

export async function checkMintAccount(
  mintAddress: string,
): Promise<MintAccountResult> {
  const connection = getConnection();
  const mintPubkey = new PublicKey(mintAddress);

  // Detect which token program owns this mint
  const accountInfo = await connection.getAccountInfo(mintPubkey);
  if (!accountInfo) {
    throw new ApiError(
      "TOKEN_NOT_FOUND",
      `Token mint ${mintAddress} not found on chain`,
    );
  }

  const ownerStr = accountInfo.owner.toBase58();
  const isToken2022 = ownerStr === TOKEN_2022_PROGRAM.toBase58();
  const programId = isToken2022 ? TOKEN_2022_PROGRAM : SPL_TOKEN_PROGRAM;

  const mint = await getMint(connection, mintPubkey, "confirmed", programId);

  return {
    mintAuthority: mint.mintAuthority?.toBase58() ?? null,
    freezeAuthority: mint.freezeAuthority?.toBase58() ?? null,
    supplyRaw: mint.supply,
    decimals: mint.decimals,
    isToken2022,
  };
}
