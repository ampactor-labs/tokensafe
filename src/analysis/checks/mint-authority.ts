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
  token_name?: string;
  token_symbol?: string;
  token_uri?: string;
  update_authority?: string;
}

export interface MintAccountResult {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supplyRaw: bigint;
  decimals: number;
  isToken2022: boolean;
  tokenProgram: string;
  rpcSlot: number;
  extensions: ExtensionInfo[];
}

export async function checkMintAccount(
  mintAddress: string,
): Promise<MintAccountResult> {
  const connection = getConnection();
  const mintPubkey = new PublicKey(mintAddress);

  // Detect which token program owns this mint (with slot for auditability)
  const { value: accountInfo, context } =
    await connection.getAccountInfoAndContext(mintPubkey);
  if (!accountInfo) {
    throw new ApiError(
      "TOKEN_NOT_FOUND",
      `Token mint ${mintAddress} not found on chain`,
    );
  }
  const rpcSlot = context.slot;

  const ownerStr = accountInfo.owner.toBase58();
  const isToken2022 = ownerStr === TOKEN_2022_PROGRAM.toBase58();
  const isSplToken = ownerStr === SPL_TOKEN_PROGRAM.toBase58();
  if (!isToken2022 && !isSplToken) {
    throw new ApiError(
      "TOKEN_NOT_FOUND",
      `Account ${mintAddress} exists but is not a token mint (owner: ${ownerStr})`,
    );
  }
  const programId = isToken2022 ? TOKEN_2022_PROGRAM : SPL_TOKEN_PROGRAM;

  const mint = await getMint(connection, mintPubkey, "confirmed", programId);

  const extensions = isToken2022 ? parseExtensions(accountInfo.data) : [];

  return {
    mintAuthority: mint.mintAuthority?.toBase58() ?? null,
    freezeAuthority: mint.freezeAuthority?.toBase58() ?? null,
    supplyRaw: mint.supply,
    decimals: mint.decimals,
    isToken2022,
    tokenProgram: ownerStr,
    rpcSlot,
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
    if (typeId === 0) {
      offset += 2;
      continue;
    }
    const length = data.readUInt16LE(offset + 2);
    const valueStart = offset + 4;
    const paddingLen = length % 4 === 0 ? 0 : 4 - (length % 4);
    offset = valueStart + length + paddingLen;

    const name = EXTENSION_NAMES[typeId];
    if (!name) {
      extensions.push({ name: `Unknown(${typeId})` });
      continue;
    }

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
    } else if (typeId === 19) {
      // TokenMetadata: update_authority(32) + mint(32) + name(borsh) + symbol(borsh) + uri(borsh)
      try {
        const ua = new PublicKey(
          data.subarray(valueStart, valueStart + 32),
        ).toBase58();
        ext.update_authority = ua;
        let pos = valueStart + 64; // skip update_authority + mint
        const readStr = (p: number): [string, number] => {
          if (p + 4 > valueStart + length) return ["", p];
          const len = data.readUInt32LE(p);
          if (p + 4 + len > valueStart + length || len > 10_000)
            return ["", p + 4];
          const s = data
            .subarray(p + 4, p + 4 + len)
            .toString("utf8")
            .replace(/\0/g, "")
            .trim();
          return [s, p + 4 + len];
        };
        const [tName, p1] = readStr(pos);
        const [tSymbol, p2] = readStr(p1);
        const [tUri] = readStr(p2);
        if (tName) ext.token_name = tName;
        if (tSymbol) ext.token_symbol = tSymbol;
        if (tUri) ext.token_uri = tUri;
      } catch {
        /* corrupt TokenMetadata — still report extension exists */
      }
    }

    extensions.push(ext);
  }

  return extensions;
}
