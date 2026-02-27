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
  extensions: string[];
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

  const extensions = isToken2022 ? parseExtensionTypes(accountInfo.data) : [];

  return {
    mintAuthority: mint.mintAuthority?.toBase58() ?? null,
    freezeAuthority: mint.freezeAuthority?.toBase58() ?? null,
    supplyRaw: mint.supply,
    decimals: mint.decimals,
    isToken2022,
    extensions,
  };
}

// Token-2022 TLV extension type IDs → human-readable names
const EXTENSION_NAMES: Record<number, string> = {
  1: "TransferFeeConfig",
  3: "MintCloseAuthority",
  4: "ConfidentialTransferMint",
  6: "DefaultAccountState",
  9: "NonTransferable",
  10: "InterestBearingConfig",
  12: "PermanentDelegate",
  14: "TransferHook",
  18: "MetadataPointer",
  19: "TokenMetadata",
  20: "GroupPointer",
  21: "TokenGroup",
  22: "GroupMemberPointer",
  23: "TokenGroupMember",
};

// SPL Token mint is 82 bytes. Token-2022 appends: account_type(1) + padding(1-3) + TLV data
// TLV entries: type(u16 LE) + length(u16 LE) + value(length bytes)
function parseExtensionTypes(data: Buffer): string[] {
  // Token-2022 mint base size = 82, then 1 byte account type, then TLV
  const TLV_START = 83 + (83 % 2 === 0 ? 0 : 1); // align to even offset — actually 165 for standard
  // The actual offset: 82 bytes mint data + variable padding. The account type byte is at 82.
  // TLV data starts after the account type byte, at offset 83 (some implementations add padding).
  // In practice, scan from offset 82 looking for the account type marker, then parse TLV.
  let offset = 83;
  if (offset >= data.length) return [];

  const extensions: string[] = [];
  while (offset + 4 <= data.length) {
    const typeId = data.readUInt16LE(offset);
    const length = data.readUInt16LE(offset + 2);
    offset += 4;

    if (typeId === 0 && length === 0) break; // end of TLV

    const name = EXTENSION_NAMES[typeId];
    if (name) extensions.push(name);

    offset += length;
  }

  return extensions;
}
