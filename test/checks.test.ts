import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { PublicKey } from "@solana/web3.js";

// ── Mocks (declared before imports per vitest hoisting) ─────────────

vi.mock("../src/solana/rpc.js", () => ({
  getConnection: vi.fn(),
  reportRpcFailure: vi.fn(),
  reportRpcSuccess: vi.fn(),
}));

vi.mock("@solana/spl-token", () => ({
  getMint: vi.fn(),
}));

vi.mock("../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/utils/cache.js", () => ({
  getCached: vi.fn(),
  setCached: vi.fn(),
  getInflight: vi.fn(),
  setInflight: vi.fn(),
  getNegativeCached: vi.fn(),
  setNegativeCached: vi.fn(),
  cacheStats: vi.fn(() => ({
    size: 0,
    maxSize: 10000,
    hits: 0,
    misses: 0,
    hitRate: "0%",
  })),
  clearCache: vi.fn(),
}));

vi.mock("../src/utils/response-signer.js", () => ({
  signResponse: vi.fn(() => "mock-signature"),
  getSignerPubkey: vi.fn(() => "mock-pubkey"),
}));

// ── Imports (after mocks) ───────────────────────────────────────────

import { getConnection } from "../src/solana/rpc.js";
import { getMint } from "@solana/spl-token";
import { checkMintAccount } from "../src/analysis/checks/mint-authority.js";
import { checkTopHolders } from "../src/analysis/checks/top-holders.js";
import { checkLiquidity } from "../src/analysis/checks/liquidity.js";
import { checkMetadata } from "../src/analysis/checks/metadata.js";
import { checkTokenAge } from "../src/analysis/checks/token-age.js";
import { analyzeHoneypot } from "../src/analysis/checks/honeypot.js";
import {
  BUY_AMOUNT_LAMPORTS_BIGINT,
  fetchRoundTrip,
} from "../src/analysis/checks/jupiter.js";
import { checkTokenLite } from "../src/analysis/token-checker.js";
import { getCached } from "../src/utils/cache.js";
import type { TokenCheckResult } from "../src/analysis/token-checker.js";

// ── Test constants ──────────────────────────────────────────────────

const MINT = "So11111111111111111111111111111111111111112";
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SOME_PUBKEY = new PublicKey(
  "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
);

// ── Helpers ─────────────────────────────────────────────────────────

function fakeConnection() {
  return {
    getAccountInfo: vi.fn(),
    getAccountInfoAndContext: vi.fn(),
    getTokenLargestAccounts: vi.fn(),
    getSignaturesForAddress: vi.fn(),
  };
}

/** Build a minimal Metaplex metadata account buffer. */
function buildMetadataBuffer(
  name: string,
  symbol: string,
  uri: string,
  isMutable: boolean,
): Buffer {
  const parts: Buffer[] = [];

  // key (1 byte — MetadataV1 = 4)
  parts.push(Buffer.from([4]));
  // update_authority (32 bytes)
  parts.push(Buffer.alloc(32));
  // mint (32 bytes)
  parts.push(Buffer.alloc(32));

  // borsh string helper
  const borshStr = (s: string) => {
    const bytes = Buffer.from(s, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length);
    return Buffer.concat([len, bytes]);
  };

  parts.push(borshStr(name));
  parts.push(borshStr(symbol));
  parts.push(borshStr(uri));

  // seller_fee_basis_points (2 bytes)
  parts.push(Buffer.alloc(2));
  // creators: None (1 byte = 0)
  parts.push(Buffer.from([0]));
  // primary_sale_happened (1 byte)
  parts.push(Buffer.from([0]));
  // is_mutable (1 byte)
  parts.push(Buffer.from([isMutable ? 1 : 0]));

  return Buffer.concat(parts);
}

/** Build a Token-2022 account data buffer with TLV extensions. */
function buildToken2022Data(
  extensions: Array<{ typeId: number; value: Buffer }>,
): Buffer {
  // 82 bytes mint base + 1 byte account_type
  const base = Buffer.alloc(83);
  const tlvParts: Buffer[] = [];
  for (const ext of extensions) {
    const header = Buffer.alloc(4);
    header.writeUInt16LE(ext.typeId, 0);
    header.writeUInt16LE(ext.value.length, 2);
    tlvParts.push(header, ext.value);
    const paddingLen =
      ext.value.length % 4 === 0 ? 0 : 4 - (ext.value.length % 4);
    if (paddingLen > 0) tlvParts.push(Buffer.alloc(paddingLen));
  }
  return Buffer.concat([base, ...tlvParts]);
}

// ════════════════════════════════════════════════════════════════════
// 1. mint-authority
// ════════════════════════════════════════════════════════════════════

describe("checkMintAccount", () => {
  let conn: ReturnType<typeof fakeConnection>;

  beforeEach(() => {
    vi.restoreAllMocks();
    conn = fakeConnection();
    (getConnection as Mock).mockReturnValue(conn);
  });

  it("throws TOKEN_NOT_FOUND when account is null", async () => {
    conn.getAccountInfoAndContext.mockResolvedValue({
      value: null,
      context: { slot: 0 },
    });
    await expect(checkMintAccount(MINT)).rejects.toThrow("not found on chain");
  });

  it("returns renounced authorities for SPL Token mint", async () => {
    conn.getAccountInfoAndContext.mockResolvedValue({
      value: {
        owner: new PublicKey(SPL_TOKEN_PROGRAM),
        data: Buffer.alloc(82),
      },
      context: { slot: 300000000 },
    });
    (getMint as Mock).mockResolvedValue({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 1000000n,
      decimals: 6,
    });

    const result = await checkMintAccount(MINT);
    expect(result.mintAuthority).toBeNull();
    expect(result.freezeAuthority).toBeNull();
    expect(result.isToken2022).toBe(false);
    expect(result.extensions).toEqual([]);
    expect(result.rpcSlot).toBe(300000000);
  });

  it("returns active authorities", async () => {
    conn.getAccountInfoAndContext.mockResolvedValue({
      value: {
        owner: new PublicKey(SPL_TOKEN_PROGRAM),
        data: Buffer.alloc(82),
      },
      context: { slot: 300000001 },
    });
    (getMint as Mock).mockResolvedValue({
      mintAuthority: SOME_PUBKEY,
      freezeAuthority: SOME_PUBKEY,
      supply: 500n,
      decimals: 9,
    });

    const result = await checkMintAccount(MINT);
    expect(result.mintAuthority).toBe(SOME_PUBKEY.toBase58());
    expect(result.freezeAuthority).toBe(SOME_PUBKEY.toBase58());
    expect(result.supplyRaw).toBe(500n);
    expect(result.decimals).toBe(9);
  });

  it("detects Token-2022 program", async () => {
    conn.getAccountInfoAndContext.mockResolvedValue({
      value: {
        owner: new PublicKey(TOKEN_2022_PROGRAM),
        data: Buffer.alloc(83), // 82 base + 1 account_type
      },
      context: { slot: 300000002 },
    });
    (getMint as Mock).mockResolvedValue({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 0n,
      decimals: 0,
    });

    const result = await checkMintAccount(MINT);
    expect(result.isToken2022).toBe(true);
  });

  it("parses PermanentDelegate extension", async () => {
    // PermanentDelegate (typeId=12): COption<Pubkey> — tag=1 + 32 bytes pubkey
    const value = Buffer.alloc(36);
    value.writeUInt32LE(1, 0); // Some
    SOME_PUBKEY.toBuffer().copy(value, 4);
    const data = buildToken2022Data([{ typeId: 12, value }]);

    conn.getAccountInfoAndContext.mockResolvedValue({
      value: {
        owner: new PublicKey(TOKEN_2022_PROGRAM),
        data,
      },
      context: { slot: 300000003 },
    });
    (getMint as Mock).mockResolvedValue({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 0n,
      decimals: 0,
    });

    const result = await checkMintAccount(MINT);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].name).toBe("PermanentDelegate");
    expect(result.extensions[0].permanent_delegate).toBe(
      SOME_PUBKEY.toBase58(),
    );
  });

  it("parses TransferFeeConfig extension", async () => {
    // TransferFeeConfig (typeId=1): needs ≥108 bytes, basis_points at offset 106
    const value = Buffer.alloc(108);
    value.writeUInt16LE(500, 106); // 5% transfer fee
    const data = buildToken2022Data([{ typeId: 1, value }]);

    conn.getAccountInfoAndContext.mockResolvedValue({
      value: {
        owner: new PublicKey(TOKEN_2022_PROGRAM),
        data,
      },
      context: { slot: 300000004 },
    });
    (getMint as Mock).mockResolvedValue({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 0n,
      decimals: 0,
    });

    const result = await checkMintAccount(MINT);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].name).toBe("TransferFeeConfig");
    expect(result.extensions[0].transfer_fee_bps).toBe(500);
  });

  it("handles TLV with no extensions (data ends at base)", async () => {
    // Token-2022 account that is exactly 83 bytes (base + account_type, no TLV)
    conn.getAccountInfoAndContext.mockResolvedValue({
      value: {
        owner: new PublicKey(TOKEN_2022_PROGRAM),
        data: Buffer.alloc(83),
      },
      context: { slot: 300000005 },
    });
    (getMint as Mock).mockResolvedValue({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 0n,
      decimals: 0,
    });

    const result = await checkMintAccount(MINT);
    expect(result.isToken2022).toBe(true);
    expect(result.extensions).toEqual([]);
  });

  it("parses multiple extensions with alignment padding", async () => {
    const metaPtr = Buffer.alloc(64); // MetadataPointer (typeId=18)
    const transferFee = Buffer.alloc(108); // TransferFeeConfig (typeId=1)
    transferFee.writeUInt16LE(300, 106); // 3% fee
    const data = buildToken2022Data([
      { typeId: 18, value: metaPtr },
      { typeId: 1, value: transferFee },
    ]);

    conn.getAccountInfoAndContext.mockResolvedValue({
      value: { owner: new PublicKey(TOKEN_2022_PROGRAM), data },
      context: { slot: 300000010 },
    });
    (getMint as Mock).mockResolvedValue({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 0n,
      decimals: 0,
    });

    const result = await checkMintAccount(MINT);
    expect(result.extensions).toHaveLength(2);
    expect(result.extensions.map((e) => e.name)).toContain("MetadataPointer");
    expect(result.extensions.map((e) => e.name)).toContain("TransferFeeConfig");
    const tfExt = result.extensions.find((e) => e.name === "TransferFeeConfig");
    expect(tfExt!.transfer_fee_bps).toBe(300);
  });

  it("extracts name/symbol/uri from TokenMetadata extension", async () => {
    const parts: Buffer[] = [];
    parts.push(SOME_PUBKEY.toBuffer()); // update_authority
    parts.push(Buffer.alloc(32)); // mint
    const borshStr = (s: string) => {
      const bytes = Buffer.from(s, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32LE(bytes.length);
      return Buffer.concat([len, bytes]);
    };
    parts.push(borshStr("PumpToken"));
    parts.push(borshStr("PUMP"));
    parts.push(borshStr("https://pump.fun/meta.json"));
    const metadataValue = Buffer.concat(parts);
    const data = buildToken2022Data([{ typeId: 19, value: metadataValue }]);

    conn.getAccountInfoAndContext.mockResolvedValue({
      value: { owner: new PublicKey(TOKEN_2022_PROGRAM), data },
      context: { slot: 300000011 },
    });
    (getMint as Mock).mockResolvedValue({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 1000000n,
      decimals: 6,
    });

    const result = await checkMintAccount(MINT);
    expect(result.extensions).toHaveLength(1);
    const tmExt = result.extensions[0];
    expect(tmExt.name).toBe("TokenMetadata");
    expect(tmExt.token_name).toBe("PumpToken");
    expect(tmExt.token_symbol).toBe("PUMP");
    expect(tmExt.token_uri).toBe("https://pump.fun/meta.json");
    expect(tmExt.update_authority).toBe(SOME_PUBKEY.toBase58());
  });

  it("parses pump.fun token (MetadataPointer + TokenMetadata)", async () => {
    const metaPtr = Buffer.alloc(64); // MetadataPointer (typeId=18)
    const parts: Buffer[] = [];
    parts.push(SOME_PUBKEY.toBuffer()); // update_authority
    parts.push(Buffer.alloc(32)); // mint
    const borshStr = (s: string) => {
      const bytes = Buffer.from(s, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32LE(bytes.length);
      return Buffer.concat([len, bytes]);
    };
    parts.push(borshStr("DogCoin"));
    parts.push(borshStr("DOG"));
    parts.push(borshStr("https://arweave.net/dog"));
    const metadataValue = Buffer.concat(parts);

    const data = buildToken2022Data([
      { typeId: 18, value: metaPtr },
      { typeId: 19, value: metadataValue },
    ]);

    conn.getAccountInfoAndContext.mockResolvedValue({
      value: { owner: new PublicKey(TOKEN_2022_PROGRAM), data },
      context: { slot: 300000012 },
    });
    (getMint as Mock).mockResolvedValue({
      mintAuthority: SOME_PUBKEY,
      freezeAuthority: null,
      supply: 1000000000n,
      decimals: 9,
    });

    const result = await checkMintAccount(MINT);
    expect(result.extensions).toHaveLength(2);
    const tm = result.extensions.find((e) => e.name === "TokenMetadata")!;
    expect(tm.token_name).toBe("DogCoin");
    expect(tm.token_symbol).toBe("DOG");
    expect(tm.token_uri).toBe("https://arweave.net/dog");
    expect(result.isToken2022).toBe(true);
    expect(result.mintAuthority).toBe(SOME_PUBKEY.toBase58());
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. top-holders
// ════════════════════════════════════════════════════════════════════

describe("checkTopHolders", () => {
  let conn: ReturnType<typeof fakeConnection>;

  beforeEach(() => {
    vi.restoreAllMocks();
    conn = fakeConnection();
    (getConnection as Mock).mockReturnValue(conn);
  });

  it("returns zeros for zero supply", async () => {
    conn.getTokenLargestAccounts.mockResolvedValue({ value: [] });
    const result = await checkTopHolders(MINT, 0n);
    expect(result.top_10_percentage).toBe(0);
    expect(result.holder_count_estimate).toBe(0);
    expect(result.risk).toBe("SAFE");
  });

  it("returns zeros for empty accounts", async () => {
    conn.getTokenLargestAccounts.mockResolvedValue({ value: [] });
    const result = await checkTopHolders(MINT, 1000n);
    expect(result.top_10_percentage).toBe(0);
    expect(result.risk).toBe("SAFE");
  });

  it("flags HIGH when top1 > 20%", async () => {
    conn.getTokenLargestAccounts.mockResolvedValue({
      value: [
        { address: SOME_PUBKEY, amount: "300" },
        { address: SOME_PUBKEY, amount: "100" },
      ],
    });
    const result = await checkTopHolders(MINT, 1000n);
    expect(result.top_1_percentage).toBe(30);
    expect(result.risk).toBe("HIGH");
  });

  it("flags HIGH when top10 > 50%", async () => {
    // 6 holders each with 100/1000 = 10%, total 60%
    const accounts = Array.from({ length: 6 }, () => ({
      address: SOME_PUBKEY,
      amount: "100",
    }));
    conn.getTokenLargestAccounts.mockResolvedValue({ value: accounts });
    const result = await checkTopHolders(MINT, 1000n);
    expect(result.top_10_percentage).toBe(60);
    expect(result.risk).toBe("HIGH");
  });

  it("flags CRITICAL when both top1 > 20% and top10 > 50%", async () => {
    conn.getTokenLargestAccounts.mockResolvedValue({
      value: [
        { address: SOME_PUBKEY, amount: "600" },
        { address: SOME_PUBKEY, amount: "100" },
      ],
    });
    const result = await checkTopHolders(MINT, 1000n);
    expect(result.top_1_percentage).toBe(60);
    expect(result.top_10_percentage).toBe(70);
    expect(result.risk).toBe("CRITICAL");
  });

  it("returns exact count when < 20 holders", async () => {
    const accounts = Array.from({ length: 5 }, () => ({
      address: SOME_PUBKEY,
      amount: "10",
    }));
    conn.getTokenLargestAccounts.mockResolvedValue({ value: accounts });
    const result = await checkTopHolders(MINT, 10000n);
    expect(result.holder_count_estimate).toBe(5);
  });

  it("returns null count when 20 holders (max RPC window)", async () => {
    const accounts = Array.from({ length: 20 }, () => ({
      address: SOME_PUBKEY,
      amount: "10",
    }));
    conn.getTokenLargestAccounts.mockResolvedValue({ value: accounts });
    const result = await checkTopHolders(MINT, 10000n);
    expect(result.holder_count_estimate).toBeNull();
  });

  it("returns top_holders_detail with addresses and percentages", async () => {
    conn.getTokenLargestAccounts.mockResolvedValue({
      value: [
        { address: SOME_PUBKEY, amount: "300" },
        { address: SOME_PUBKEY, amount: "200" },
      ],
    });
    const result = await checkTopHolders(MINT, 1000n);
    expect(result.top_holders_detail).toHaveLength(2);
    expect(result.top_holders_detail![0]).toEqual({
      address: SOME_PUBKEY.toBase58(),
      percentage: 30,
    });
    expect(result.top_holders_detail![1]).toEqual({
      address: SOME_PUBKEY.toBase58(),
      percentage: 20,
    });
  });

  it("returns null top_holders_detail for zero supply", async () => {
    conn.getTokenLargestAccounts.mockResolvedValue({ value: [] });
    const result = await checkTopHolders(MINT, 0n);
    expect(result.top_holders_detail).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. liquidity (prefetched quote path — production path)
// ════════════════════════════════════════════════════════════════════

describe("checkLiquidity", () => {
  it("returns SAFE with pool info from prefetched quote", async () => {
    const result = await checkLiquidity(MINT, {
      outAmount: "1000000",
      priceImpactPct: 0.5,
      primaryPool: "Raydium",
      poolAddress: "pool123",
    });
    expect(result.has_liquidity).toBe(true);
    expect(result.primary_pool).toBe("Raydium");
    expect(result.liquidity_rating).toBe("DEEP");
    expect(result.risk).toBe("SAFE");
  });

  it("returns CRITICAL when prefetched quote is null", async () => {
    const result = await checkLiquidity(MINT, null);
    expect(result.has_liquidity).toBe(false);
    expect(result.risk).toBe("CRITICAL");
  });

  it("returns CRITICAL when no quote provided", async () => {
    const result = await checkLiquidity(MINT);
    expect(result.has_liquidity).toBe(false);
    expect(result.risk).toBe("CRITICAL");
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. metadata
// ════════════════════════════════════════════════════════════════════

describe("checkMetadata", () => {
  let conn: ReturnType<typeof fakeConnection>;

  beforeEach(() => {
    vi.restoreAllMocks();
    conn = fakeConnection();
    (getConnection as Mock).mockReturnValue(conn);
  });

  it("returns null when no metadata account exists", async () => {
    conn.getAccountInfo.mockResolvedValue(null);
    const result = await checkMetadata(MINT);
    expect(result).toBeNull();
  });

  it("returns WARNING for mutable metadata", async () => {
    const data = buildMetadataBuffer(
      "TestToken",
      "TST",
      "https://example.com/meta.json",
      true,
    );
    conn.getAccountInfo.mockResolvedValue({ data });
    const result = await checkMetadata(MINT);
    expect(result).not.toBeNull();
    expect(result!.mutable).toBe(true);
    expect(result!.risk).toBe("WARNING");
  });

  it("returns SAFE for immutable metadata", async () => {
    const data = buildMetadataBuffer(
      "TestToken",
      "TST",
      "https://example.com/meta.json",
      false,
    );
    conn.getAccountInfo.mockResolvedValue({ data });
    const result = await checkMetadata(MINT);
    expect(result).not.toBeNull();
    expect(result!.mutable).toBe(false);
    expect(result!.risk).toBe("SAFE");
  });

  it("parses name, symbol, URI, and update_authority", async () => {
    const data = buildMetadataBuffer(
      "Cool Token",
      "COOL",
      "https://arweave.net/abc",
      false,
    );
    conn.getAccountInfo.mockResolvedValue({ data });
    const result = await checkMetadata(MINT);
    expect(result!.name).toBe("Cool Token");
    expect(result!.symbol).toBe("COOL");
    expect(result!.uri).toBe("https://arweave.net/abc");
    expect(result!.has_uri).toBe(true);
    // update_authority is 32 zero bytes → PublicKey.default (system program)
    expect(result!.update_authority).toBe("11111111111111111111111111111111");
  });

  it("returns null on parse error (corrupt data)", async () => {
    conn.getAccountInfo.mockResolvedValue({ data: Buffer.alloc(10) });
    const result = await checkMetadata(MINT);
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════
// 5. token-age
// ════════════════════════════════════════════════════════════════════

describe("checkTokenAge", () => {
  let conn: ReturnType<typeof fakeConnection>;

  beforeEach(() => {
    vi.restoreAllMocks();
    conn = fakeConnection();
    (getConnection as Mock).mockReturnValue(conn);
  });

  it("returns null age when no signatures found", async () => {
    conn.getSignaturesForAddress.mockResolvedValue([]);
    const result = await checkTokenAge(MINT);
    expect(result.token_age_hours).toBeNull();
    expect(result.token_age_minutes).toBeNull();
    expect(result.created_at).toBeNull();
  });

  it("returns null age when oldest sig has no blockTime", async () => {
    conn.getSignaturesForAddress.mockResolvedValue([{ blockTime: null }]);
    const result = await checkTokenAge(MINT);
    expect(result.token_age_hours).toBeNull();
    expect(result.token_age_minutes).toBeNull();
  });

  it("calculates age correctly", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const twoHoursAgo = nowSec - 2 * 3600;
    conn.getSignaturesForAddress.mockResolvedValue([
      { blockTime: nowSec },
      { blockTime: twoHoursAgo },
    ]);
    const result = await checkTokenAge(MINT);
    // Should be approximately 2 hours
    expect(result.token_age_hours).toBeGreaterThanOrEqual(1.9);
    expect(result.token_age_hours).toBeLessThanOrEqual(2.1);
    expect(result.token_age_minutes).toBeGreaterThanOrEqual(115);
    expect(result.token_age_minutes).toBeLessThanOrEqual(125);
    expect(result.created_at).not.toBeNull();
  });

  it("returns token_age_minutes for sub-hour tokens", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tenMinAgo = nowSec - 10 * 60;
    conn.getSignaturesForAddress.mockResolvedValue([
      { blockTime: nowSec },
      { blockTime: tenMinAgo },
    ]);
    const result = await checkTokenAge(MINT);
    expect(result.token_age_minutes).toBeGreaterThanOrEqual(9);
    expect(result.token_age_minutes).toBeLessThanOrEqual(11);
  });

  it("returns minimum age + established flag for 100-sig token", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const sigs = Array.from({ length: 100 }, (_, i) => ({
      blockTime: nowSec - i * 60,
    }));
    conn.getSignaturesForAddress.mockResolvedValue(sigs);
    const result = await checkTokenAge(MINT);
    expect(result.established).toBe(true);
    // Oldest sig is ~99 minutes ago
    expect(result.token_age_minutes).toBeGreaterThanOrEqual(95);
    expect(result.token_age_minutes).toBeLessThanOrEqual(105);
    expect(result.token_age_hours).not.toBeNull();
    expect(result.created_at).not.toBeNull();
  });

  it("returns established=true with null age when oldest 100-sig has no blockTime", async () => {
    const sigs = Array.from({ length: 100 }, () => ({ blockTime: null }));
    conn.getSignaturesForAddress.mockResolvedValue(sigs);
    const result = await checkTokenAge(MINT);
    expect(result.established).toBe(true);
    expect(result.token_age_hours).toBeNull();
    expect(result.created_at).toBeNull();
  });

  it("does not set established flag for < 100 sig tokens", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    conn.getSignaturesForAddress.mockResolvedValue([
      { blockTime: nowSec },
      { blockTime: nowSec - 7200 },
    ]);
    const result = await checkTokenAge(MINT);
    expect(result.established).toBeUndefined();
  });

  it("returns null age when RPC throws", async () => {
    conn.getSignaturesForAddress.mockRejectedValue(new Error("timeout"));
    const result = await checkTokenAge(MINT);
    expect(result.token_age_hours).toBeNull();
    expect(result.token_age_minutes).toBeNull();
    expect(result.created_at).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════
// 6. honeypot
// ════════════════════════════════════════════════════════════════════

describe("analyzeHoneypot", () => {
  const buyQuote = {
    outAmount: "500000000",
    priceImpactPct: 0.1,
    primaryPool: "Raydium",
    poolAddress: "pool123",
  };

  it("returns SAFE when round-trip has low loss", () => {
    const sellQuote = {
      outAmount: "99000000", // ~1% loss (within noise floor)
      priceImpactPct: 0.1,
      primaryPool: "Raydium",
      poolAddress: "pool123",
    };
    const result = analyzeHoneypot(
      buyQuote,
      sellQuote,
      BUY_AMOUNT_LAMPORTS_BIGINT,
    );
    expect(result.can_sell).toBe(true);
    expect(result.risk).toBe("SAFE");
  });

  it("returns UNKNOWN with null can_sell when buy quote is null (no route, not a confirmed honeypot)", () => {
    const result = analyzeHoneypot(null, null, BUY_AMOUNT_LAMPORTS_BIGINT);
    expect(result.can_sell).toBeNull();
    expect(result.risk).toBe("UNKNOWN");
    expect(result.note).toContain("too new");
  });

  it("returns DANGEROUS when sell quote is null (true honeypot — buy exists, sell doesn't)", () => {
    const result = analyzeHoneypot(buyQuote, null, BUY_AMOUNT_LAMPORTS_BIGINT);
    expect(result.can_sell).toBe(false);
    expect(result.risk).toBe("DANGEROUS");
  });

  it("returns DANGEROUS with high sell tax", () => {
    const sellQuote = {
      outAmount: "50000000", // 50% loss
      priceImpactPct: 0.1,
      primaryPool: "Raydium",
      poolAddress: "pool123",
    };
    const result = analyzeHoneypot(
      buyQuote,
      sellQuote,
      BUY_AMOUNT_LAMPORTS_BIGINT,
    );
    expect(result.can_sell).toBe(true);
    expect(result.risk).toBe("DANGEROUS");
    expect(result.sell_tax_bps).toBeGreaterThan(1000);
  });

  it("handles USDC-denominated round-trip without false sell tax (wSOL case)", () => {
    const usdcBuyAmount = 5_000_000n; // 5 USDC
    const buyQ = {
      outAmount: "30000000",
      priceImpactPct: 0.5,
      primaryPool: "Raydium",
      poolAddress: "p1",
    };
    // Sell returns 4.9M USDC — 2% round-trip loss, after subtracting
    // expected losses (0.5% buy impact + 0.5% sell impact + 0.5% fees = 1.5%),
    // remaining 0.5% = 50 bps < 100 bps noise floor → 0
    const sellQ = {
      outAmount: "4900000",
      priceImpactPct: 0.5,
      primaryPool: "Raydium",
      poolAddress: "p1",
    };
    const result = analyzeHoneypot(buyQ, sellQ, usdcBuyAmount);
    expect(result.can_sell).toBe(true);
    expect(result.sell_tax_bps).toBe(0);
    expect(result.risk).toBe("SAFE");
  });

  it("detects real sell tax with correct buy amount", () => {
    const buyAmount = 100_000_000n; // 0.1 SOL
    const buyQ = {
      outAmount: "500000000",
      priceImpactPct: 0.1,
      primaryPool: "Raydium",
      poolAddress: "p1",
    };
    const sellQ = {
      outAmount: "50000000",
      priceImpactPct: 0.1,
      primaryPool: "Raydium",
      poolAddress: "p1",
    }; // 50% loss
    const result = analyzeHoneypot(buyQ, sellQ, buyAmount);
    expect(result.sell_tax_bps).toBeGreaterThan(1000);
    expect(result.risk).toBe("DANGEROUS");
  });
});

// ════════════════════════════════════════════════════════════════════
// 7. fetchRoundTrip — 6s ceiling
// ════════════════════════════════════════════════════════════════════

describe("fetchRoundTrip", () => {
  it("returns empty trip when both quotes timeout", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(new Response(JSON.stringify({}))), 10000),
          ),
      );

    const result = await fetchRoundTrip(
      "SomeMint111111111111111111111111111111111111",
    );
    expect(result.buyQuote).toBeNull();
    expect(result.sellQuote).toBeNull();
    expect(result.buyInputAmount).toBe(0n);

    globalThis.fetch = originalFetch;
  }, 10000);

  it("resolves within 7s even when fetch is slow", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(new Response(JSON.stringify({}))), 10000),
          ),
      );

    const start = Date.now();
    await fetchRoundTrip("SomeMint111111111111111111111111111111111111");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(7000);

    globalThis.fetch = originalFetch;
  }, 10000);
});

// ════════════════════════════════════════════════════════════════════
// 8. checkTokenLite — enriched fields + has_risky_extensions logic
// ════════════════════════════════════════════════════════════════════

const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function makeFullResult(
  overrides: Partial<TokenCheckResult> = {},
): TokenCheckResult {
  return {
    mint: MINT,
    name: "TestToken",
    symbol: "TST",
    checked_at: "2026-02-28T00:00:00.000Z",
    cached_at: null,
    risk_score: 10,
    risk_level: "LOW",
    checks: {
      mint_authority: { status: "RENOUNCED", authority: null, risk: "SAFE" },
      freeze_authority: { status: "RENOUNCED", authority: null, risk: "SAFE" },
      supply: { total: "1000000000", decimals: 9 },
      top_holders: {
        top_10_percentage: 10,
        top_1_percentage: 2,
        holder_count_estimate: 500,
        top_holders_detail: null,
        note: null,
        risk: "SAFE",
      },
      liquidity: null,
      metadata: null,
      honeypot: null,
      token_age_hours: 24,
      token_age_minutes: 1440,
      created_at: "2026-02-27T00:00:00.000Z",
      token_program: SPL_TOKEN_PROGRAM_ID,
      is_token_2022: false,
      token_2022_extensions: null,
    },
    rpc_slot: 300000000,
    methodology_version: "1.0.0",
    risk_factors: [],
    summary: "Low risk",
    degraded: false,
    degraded_checks: [],
    response_signature: "mock-signature",
    signer_pubkey: "mock-pubkey",
    ...overrides,
  };
}

describe("checkTokenLite", () => {
  const mockGetCached = vi.mocked(getCached);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns enriched fields from full result", async () => {
    mockGetCached.mockReturnValue(makeFullResult());
    const { result } = await checkTokenLite(MINT);
    expect(result.mint).toBe(MINT);
    expect(result.name).toBe("TestToken");
    expect(result.symbol).toBe("TST");
    expect(result.risk_score).toBe(10);
    expect(result.risk_level).toBe("LOW");
    expect(result.summary).toBe("Low risk");
    expect(result.degraded).toBe(false);
    expect(result.is_token_2022).toBe(false);
    expect(result.has_risky_extensions).toBe(false);
    expect(result.full_report).toContain("/v1/check?mint=");
  });

  it("has_risky_extensions is false when extensions is null", async () => {
    mockGetCached.mockReturnValue(
      makeFullResult({
        checks: { ...makeFullResult().checks, token_2022_extensions: null },
      }),
    );
    const { result } = await checkTokenLite(MINT);
    expect(result.has_risky_extensions).toBe(false);
  });

  it("has_risky_extensions is false when extensions array is empty", async () => {
    mockGetCached.mockReturnValue(
      makeFullResult({
        checks: { ...makeFullResult().checks, token_2022_extensions: [] },
      }),
    );
    const { result } = await checkTokenLite(MINT);
    expect(result.has_risky_extensions).toBe(false);
  });

  it("has_risky_extensions is true when permanent_delegate is set", async () => {
    mockGetCached.mockReturnValue(
      makeFullResult({
        checks: {
          ...makeFullResult().checks,
          is_token_2022: true,
          token_2022_extensions: [
            {
              name: "PermanentDelegate",
              permanent_delegate: SOME_PUBKEY.toBase58(),
            },
          ],
        },
      }),
    );
    const { result } = await checkTokenLite(MINT);
    expect(result.is_token_2022).toBe(true);
    expect(result.has_risky_extensions).toBe(true);
  });

  it("has_risky_extensions is true when transfer_fee_bps > 0", async () => {
    mockGetCached.mockReturnValue(
      makeFullResult({
        checks: {
          ...makeFullResult().checks,
          is_token_2022: true,
          token_2022_extensions: [
            { name: "TransferFeeConfig", transfer_fee_bps: 500 },
          ],
        },
      }),
    );
    const { result } = await checkTokenLite(MINT);
    expect(result.has_risky_extensions).toBe(true);
  });

  it("has_risky_extensions is false when transfer_fee_bps is 0", async () => {
    mockGetCached.mockReturnValue(
      makeFullResult({
        checks: {
          ...makeFullResult().checks,
          is_token_2022: true,
          token_2022_extensions: [
            { name: "TransferFeeConfig", transfer_fee_bps: 0 },
          ],
        },
      }),
    );
    const { result } = await checkTokenLite(MINT);
    expect(result.has_risky_extensions).toBe(false);
  });

  it("has_risky_extensions is true when transfer_hook_program is set", async () => {
    mockGetCached.mockReturnValue(
      makeFullResult({
        checks: {
          ...makeFullResult().checks,
          is_token_2022: true,
          token_2022_extensions: [
            {
              name: "TransferHook",
              transfer_hook_program: SOME_PUBKEY.toBase58(),
            },
          ],
        },
      }),
    );
    const { result } = await checkTokenLite(MINT);
    expect(result.has_risky_extensions).toBe(true);
  });

  it("full_report includes baseUrl when provided", async () => {
    mockGetCached.mockReturnValue(makeFullResult());
    const { result } = await checkTokenLite(MINT, "https://api.example.com");
    expect(result.full_report).toContain(
      "https://api.example.com/v1/check?mint=",
    );
    expect(result.full_report).toContain("$0.008");
  });

  it("full_report omits baseUrl when not provided", async () => {
    mockGetCached.mockReturnValue(makeFullResult());
    const { result } = await checkTokenLite(MINT);
    expect(result.full_report).toContain("/v1/check?mint=");
    expect(result.full_report).not.toContain("https://");
  });

  it("propagates fromCache correctly", async () => {
    mockGetCached.mockReturnValue(makeFullResult());
    const { fromCache } = await checkTokenLite(MINT);
    expect(fromCache).toBe(true);
  });
});
