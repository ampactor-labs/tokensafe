import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../../solana/rpc.js";
import { logger } from "../../utils/logger.js";

const METAPLEX_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

export interface MetadataResult {
  name: string | null;
  symbol: string | null;
  mutable: boolean;
  has_uri: boolean;
  uri: string | null;
  risk: "SAFE" | "WARNING";
}

export async function checkMetadata(
  mintAddress: string,
): Promise<MetadataResult | null> {
  const connection = getConnection();
  const mintPubkey = new PublicKey(mintAddress);

  const [metadataPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METAPLEX_PROGRAM_ID.toBuffer(),
      mintPubkey.toBuffer(),
    ],
    METAPLEX_PROGRAM_ID,
  );

  const accountInfo = await Promise.race([
    connection.getAccountInfo(metadataPDA),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Metadata RPC timeout")), 5000),
    ),
  ]);
  if (!accountInfo) {
    return null; // No Metaplex metadata — common for devnet tokens
  }

  try {
    const parsed = parseMetadataAccount(accountInfo.data);
    return {
      name: parsed.name,
      symbol: parsed.symbol,
      mutable: parsed.isMutable,
      has_uri: parsed.uri !== null && parsed.uri.length > 0,
      uri: parsed.uri,
      risk: parsed.isMutable ? "WARNING" : "SAFE",
    };
  } catch (err) {
    logger.warn({ err, mintAddress }, "Failed to parse Metaplex metadata");
    return null;
  }
}

interface ParsedMetadata {
  name: string | null;
  symbol: string | null;
  uri: string | null;
  isMutable: boolean;
}

// Metaplex metadata account Borsh layout:
// key(1) + update_authority(32) + mint(32) + name(borsh_str) + symbol(borsh_str) + uri(borsh_str)
// + seller_fee_basis_points(2) + creators(option<vec<creator>>) + primary_sale_happened(1) + is_mutable(1)
function parseMetadataAccount(data: Buffer): ParsedMetadata {
  let offset = 1 + 32 + 32; // skip key + update_authority + mint

  const [name, o1] = readBorshString(data, offset);
  const [symbol, o2] = readBorshString(data, o1);
  const [uri, o3] = readBorshString(data, o2);

  // seller_fee_basis_points: 2 bytes
  offset = o3 + 2;

  // creators: Option<Vec<Creator>>
  const hasCreators = data[offset] === 1;
  offset += 1;
  if (hasCreators) {
    const numCreators = data.readUInt32LE(offset);
    offset += 4;
    offset += numCreators * 34; // each creator: pubkey(32) + verified(1) + share(1)
  }

  // primary_sale_happened: 1 byte
  offset += 1;

  // is_mutable: 1 byte
  const isMutable = data[offset] === 1;

  return {
    name: clean(name),
    symbol: clean(symbol),
    uri: clean(uri),
    isMutable,
  };
}

function readBorshString(data: Buffer, offset: number): [string, number] {
  const len = data.readUInt32LE(offset);
  if (offset + 4 + len > data.length || len > 10_000) {
    throw new Error("Metadata string length out of bounds");
  }
  const str = data.subarray(offset + 4, offset + 4 + len).toString("utf8");
  return [str, offset + 4 + len];
}

function clean(s: string): string | null {
  const trimmed = s.replace(/\0/g, "").trim();
  return trimmed.length > 0 ? trimmed : null;
}
