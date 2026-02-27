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

export interface ExtensionInfo {
  name: string;
  transfer_fee_bps?: number;
  permanent_delegate?: string | null;
  transfer_hook_program?: string | null;
}

export interface MintAccountResult {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supplyRaw: bigint;
  decimals: number;
  isToken2022: boolean;
  extensions: ExtensionInfo[];
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

  const extensions = isToken2022 ? parseExtensions(accountInfo.data) : [];

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
function parseExtensions(data: Buffer): ExtensionInfo[] {
  // Mint base: 82 bytes + account_type: 1 byte = TLV at 83
  const MINT_TLV_START = 83;
  let offset = MINT_TLV_START;
  if (offset >= data.length) return [];

  const extensions: ExtensionInfo[] = [];
  while (offset + 4 <= data.length) {
    const typeId = data.readUInt16LE(offset);
    const length = data.readUInt16LE(offset + 2);
    const valueStart = offset + 4;
    offset = valueStart + length;

    if (typeId === 0 && length === 0) break; // end of TLV

    const name = EXTENSION_NAMES[typeId];
    if (!name) continue;

    const ext: ExtensionInfo = { name };

    if (typeId === 1 && length >= 108) {
      // TransferFeeConfig: read newer_transfer_fee.transfer_fee_basis_points
      // Layout: authority(COption<Pubkey>=36) + withdraw_authority(36) + older_transfer_fee(TransferFee=18)
      //       + newer.epoch(u64=8) + newer.maximum_fee(u64=8) + newer.basis_points(u16=2) = offset 106
      ext.transfer_fee_bps = data.readUInt16LE(valueStart + 106);
    } else if (typeId === 12 && length >= 36) {
      // PermanentDelegate: COption<Pubkey>
      const tag = data.readUInt32LE(valueStart);
      ext.permanent_delegate =
        tag === 1
          ? new PublicKey(
              data.subarray(valueStart + 4, valueStart + 36),
            ).toBase58()
          : null;
    } else if (typeId === 14 && length >= 68) {
      // TransferHook: authority(COption<Pubkey>=36) + program_id(Pubkey=32)
      const programBytes = data.subarray(valueStart + 36, valueStart + 68);
      const programId = new PublicKey(programBytes);
      const isZero = programId.equals(PublicKey.default);
      ext.transfer_hook_program = isZero ? null : programId.toBase58();
    }

    extensions.push(ext);
  }

  return extensions;
}
