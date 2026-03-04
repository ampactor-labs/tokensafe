import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
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

// Mock DexScreener — default to null (no fallback data)
vi.mock("../src/analysis/checks/dexscreener.js", () => ({
  fetchDexScreenerLiquidity: vi.fn().mockResolvedValue(null),
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

  it("handles TLV zero-padding between extensions without skipping real entries", async () => {
    // Build a buffer with: MetadataPointer(18) + 2 bytes zero padding + TransferFeeConfig(1)
    const base = Buffer.alloc(83); // 82 base + 1 account_type
    const tlvParts: Buffer[] = [];

    // Extension 1: MetadataPointer (typeId=18, 64 bytes)
    const metaPtrHeader = Buffer.alloc(4);
    metaPtrHeader.writeUInt16LE(18, 0);
    metaPtrHeader.writeUInt16LE(64, 2);
    tlvParts.push(metaPtrHeader, Buffer.alloc(64));

    // 2-byte zero padding (typeId=0)
    tlvParts.push(Buffer.alloc(2));

    // Extension 2: TransferFeeConfig (typeId=1, 108 bytes)
    const tfHeader = Buffer.alloc(4);
    tfHeader.writeUInt16LE(1, 0);
    tfHeader.writeUInt16LE(108, 2);
    const tfValue = Buffer.alloc(108);
    tfValue.writeUInt16LE(250, 106); // 2.5% fee
    tlvParts.push(tfHeader, tfValue);

    const data = Buffer.concat([base, ...tlvParts]);

    conn.getAccountInfoAndContext.mockResolvedValue({
      value: { owner: new PublicKey(TOKEN_2022_PROGRAM), data },
      context: { slot: 300000020 },
    });
    (getMint as Mock).mockResolvedValue({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 0n,
      decimals: 0,
    });

    const result = await checkMintAccount(MINT);
    // Should find BOTH extensions, not skip the second one
    const names = result.extensions.map((e) => e.name);
    expect(names).toContain("MetadataPointer");
    expect(names).toContain("TransferFeeConfig");
    const tfExt = result.extensions.find((e) => e.name === "TransferFeeConfig");
    expect(tfExt!.transfer_fee_bps).toBe(250);
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. top-holders
// ════════════════════════════════════════════════════════════════════

describe("checkTopHolders", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Build a fake SPL token account buffer with the given owner pubkey bytes
  function buildTokenAccountBuffer(ownerPubkey: PublicKey): string {
    const buf = Buffer.alloc(165); // SPL token account size
    // Bytes 0-31: mint (irrelevant for our test)
    // Bytes 32-63: owner
    ownerPubkey.toBuffer().copy(buf, 32);
    return buf.toString("base64");
  }

  // A known on-curve (wallet) address
  const WALLET_OWNER = new PublicKey("9yy87vYzU4NgL2jF8yoFFtrRY7YbaW9mbtD6yMKkBjrf");
  // A known off-curve (PDA) address — derived deterministically
  const PDA_OWNER = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  )[0];

  // A known DeFi program (Raydium AMM v4) for PDA whitelist tests
  const KNOWN_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
  // An unknown program (not in known-programs registry)
  const UNKNOWN_PROGRAM = "UnknownProg1111111111111111111111111111111";

  function mockRpcResponse(value: Array<{ address: string; amount: string }>) {
    // Chain: call 1 = getTokenLargestAccounts, call 2 = getMultipleAccounts (Phase 1),
    // call 3 = getMultipleAccounts (Phase 2 — PDA program resolution, only if PDAs exist)
    const ownersResponse = value.map((v) => ({
      data: [buildTokenAccountBuffer(WALLET_OWNER), "base64"],
    }));
    // All owners are wallets (on-curve), so no Phase 2 call needed
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { value: ownersResponse } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
  }

  function mockRpcWithOwners(
    accounts: Array<{ address: string; amount: string }>,
    owners: Array<{ pubkey: PublicKey } | null>,
    pdaProgramOwners?: Map<string, string>,
  ) {
    const ownersResponse = owners.map((o) =>
      o ? { data: [buildTokenAccountBuffer(o.pubkey), "base64"] } : null,
    );

    // Phase 2: resolve PDA owner addresses → their owning program
    // Collect unique off-curve owners
    const pdaOwnerAddresses: string[] = [];
    for (const o of owners) {
      if (!o) continue;
      const bytes = o.pubkey.toBytes();
      if (!PublicKey.isOnCurve(bytes)) {
        const addr = o.pubkey.toBase58();
        if (!pdaOwnerAddresses.includes(addr)) pdaOwnerAddresses.push(addr);
      }
    }

    const phase2Response = pdaOwnerAddresses.map((addr) => {
      const program = pdaProgramOwners?.get(addr);
      return program ? { owner: program } : { owner: "11111111111111111111111111111111" };
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: accounts } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { value: ownersResponse } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    // Only add Phase 2 mock if there are PDAs
    if (pdaOwnerAddresses.length > 0) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { value: phase2Response } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    globalThis.fetch = fetchMock;
  }

  function mockRpcError(message: string) {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  function mockFetchReject(err: Error) {
    globalThis.fetch = vi.fn().mockRejectedValue(err);
  }

  const ADDR = SOME_PUBKEY.toBase58();

  it("returns zeros for zero supply", async () => {
    mockRpcResponse([]);
    const result = await checkTopHolders(MINT, 0n);
    expect(result.top_10_percentage).toBe(0);
    expect(result.holder_count_estimate).toBe(0);
    expect(result.risk).toBe("SAFE");
  });

  it("returns UNAVAILABLE when accounts empty but supply non-zero", async () => {
    mockRpcResponse([]);
    const result = await checkTopHolders(MINT, 1000n);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.risk).toBe("UNKNOWN");
    expect(result.note).toContain("concentration unknown");
  });

  it("flags HIGH when top1 > 20%", async () => {
    mockRpcResponse([
      { address: ADDR, amount: "300" },
      { address: ADDR, amount: "100" },
    ]);
    const result = await checkTopHolders(MINT, 1000n);
    expect(result.top_1_percentage).toBe(30);
    expect(result.risk).toBe("HIGH");
  });

  it("flags HIGH when top10 > 50%", async () => {
    // 6 holders each with 100/1000 = 10%, total 60%
    const accounts = Array.from({ length: 6 }, () => ({
      address: ADDR,
      amount: "100",
    }));
    mockRpcResponse(accounts);
    const result = await checkTopHolders(MINT, 1000n);
    expect(result.top_10_percentage).toBe(60);
    expect(result.risk).toBe("HIGH");
  });

  it("flags CRITICAL when both top1 > 20% and top10 > 50%", async () => {
    mockRpcResponse([
      { address: ADDR, amount: "600" },
      { address: ADDR, amount: "100" },
    ]);
    const result = await checkTopHolders(MINT, 1000n);
    expect(result.top_1_percentage).toBe(60);
    expect(result.top_10_percentage).toBe(70);
    expect(result.risk).toBe("CRITICAL");
  });

  it("returns exact count when < 20 holders", async () => {
    const accounts = Array.from({ length: 5 }, () => ({
      address: ADDR,
      amount: "10",
    }));
    mockRpcResponse(accounts);
    const result = await checkTopHolders(MINT, 10000n);
    expect(result.holder_count_estimate).toBe(5);
  });

  it("returns null count when 20 holders (max RPC window)", async () => {
    const accounts = Array.from({ length: 20 }, () => ({
      address: ADDR,
      amount: "10",
    }));
    mockRpcResponse(accounts);
    const result = await checkTopHolders(MINT, 10000n);
    expect(result.holder_count_estimate).toBeNull();
  });

  it("returns top_holders_detail with addresses, percentages, owner and is_protocol_account", async () => {
    mockRpcResponse([
      { address: ADDR, amount: "300" },
      { address: ADDR, amount: "200" },
    ]);
    const result = await checkTopHolders(MINT, 1000n);
    expect(result.top_holders_detail).toHaveLength(2);
    expect(result.top_holders_detail![0]).toMatchObject({
      address: ADDR,
      percentage: 30,
      owner: WALLET_OWNER.toBase58(),
      is_protocol_account: false,
    });
    expect(result.top_holders_detail![1]).toMatchObject({
      address: ADDR,
      percentage: 20,
      owner: WALLET_OWNER.toBase58(),
      is_protocol_account: false,
    });
  });

  it("returns null top_holders_detail for zero supply", async () => {
    mockRpcResponse([]);
    const result = await checkTopHolders(MINT, 0n);
    expect(result.top_holders_detail).toBeNull();
  });

  it("returns UNAVAILABLE/UNKNOWN when RPC returns error", async () => {
    mockRpcError("Too many accounts provided; max 500");

    const result = await checkTopHolders(MINT, 1_000_000_000_000n);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.risk).toBe("UNKNOWN");
    expect(result.holder_count_estimate).toBeNull();
    expect(result.top_10_percentage).toBe(0);
    expect(result.top_1_percentage).toBe(0);
    expect(result.note).toContain("RPC error");
  });

  it("returns UNAVAILABLE on connection timeout", async () => {
    mockFetchReject(new Error("Connection timeout"));
    const result = await checkTopHolders(MINT, 1000n);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.risk).toBe("UNKNOWN");
    expect(result.note).toContain("RPC error");
  });

  // ── PDA-based protocol account detection ──────────────────────────

  it("excludes PDA-owned accounts from concentration when owned by known program", async () => {
    const ACCT_PDA = "PdaAcct111111111111111111111111111111111111";
    const ACCT_WALLET = "WalAcct111111111111111111111111111111111111";
    mockRpcWithOwners(
      [
        { address: ACCT_PDA, amount: "600" },   // 60% — PDA owned by known program
        { address: ACCT_WALLET, amount: "200" }, // 20% — wallet
      ],
      [
        { pubkey: PDA_OWNER },
        { pubkey: WALLET_OWNER },
      ],
      new Map([[PDA_OWNER.toBase58(), KNOWN_PROGRAM]]),
    );
    const result = await checkTopHolders(MINT, 1000n);
    // Scoring should exclude the 60% PDA (known program) → top1=20%, top10=20%
    expect(result.top_1_percentage).toBe(20);
    expect(result.top_10_percentage).toBe(20);
    expect(result.risk).toBe("SAFE");
    expect(result.note).toContain("PDA-owned");
    // But detail still contains both
    expect(result.top_holders_detail).toHaveLength(2);
    expect(result.top_holders_detail![0].is_protocol_account).toBe(true);
    expect(result.top_holders_detail![0].owner_program).toBe(KNOWN_PROGRAM);
    expect(result.top_holders_detail![1].is_protocol_account).toBe(false);
  });

  it("enriches top_holders_detail with owner, owner_program and is_protocol_account", async () => {
    const ACCT_A = "AcctAAAA1111111111111111111111111111111111";
    mockRpcWithOwners(
      [{ address: ACCT_A, amount: "500" }],
      [{ pubkey: PDA_OWNER }],
      new Map([[PDA_OWNER.toBase58(), KNOWN_PROGRAM]]),
    );
    const result = await checkTopHolders(MINT, 1000n);
    expect(result.top_holders_detail![0].owner).toBe(PDA_OWNER.toBase58());
    expect(result.top_holders_detail![0].owner_program).toBe(KNOWN_PROGRAM);
    expect(result.top_holders_detail![0].is_protocol_account).toBe(true);
  });

  it("falls back to raw concentration when resolveOwners fails", async () => {
    // First call succeeds (getTokenLargestAccounts), second fails (getMultipleAccounts)
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          jsonrpc: "2.0", id: 1,
          result: { value: [{ address: ADDR, amount: "600" }, { address: ADDR, amount: "100" }] },
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      )
      .mockRejectedValueOnce(new Error("RPC timeout"));
    const result = await checkTopHolders(MINT, 1000n);
    // Should still compute raw concentration (no crash)
    expect(result.status).toBe("OK");
    expect(result.top_1_percentage).toBe(60);
    expect(result.top_10_percentage).toBe(70);
    expect(result.note).toBeNull(); // no adjustment note
    // owner/is_protocol_account default to null/false when no ownerMap
    expect(result.top_holders_detail![0].owner).toBeNull();
    expect(result.top_holders_detail![0].is_protocol_account).toBe(false);
  });

  it("uses raw concentration when all holders are known-program PDAs", async () => {
    const ACCT_A = "AcctAAAA1111111111111111111111111111111111";
    const ACCT_B = "AcctBBBB1111111111111111111111111111111111";
    mockRpcWithOwners(
      [
        { address: ACCT_A, amount: "600" },
        { address: ACCT_B, amount: "300" },
      ],
      [
        { pubkey: PDA_OWNER },
        { pubkey: PDA_OWNER },
      ],
      new Map([[PDA_OWNER.toBase58(), KNOWN_PROGRAM]]),
    );
    const result = await checkTopHolders(MINT, 1000n);
    // All holders are known-program PDAs → raw concentration preserved, no false 0%
    expect(result.top_1_percentage).toBe(60);
    expect(result.top_10_percentage).toBe(90);
    expect(result.note).toBeNull();
  });

  it("computes correct adjusted percentages with mixed PDA/wallet holders", async () => {
    const ACCT_PDA1 = "Pda1Acct1111111111111111111111111111111111";
    const ACCT_PDA2 = "Pda2Acct1111111111111111111111111111111111";
    const ACCT_WAL1 = "Wal1Acct1111111111111111111111111111111111";
    const ACCT_WAL2 = "Wal2Acct1111111111111111111111111111111111";
    mockRpcWithOwners(
      [
        { address: ACCT_PDA1, amount: "400" }, // 40% PDA (known program)
        { address: ACCT_WAL1, amount: "300" }, // 30% wallet
        { address: ACCT_PDA2, amount: "200" }, // 20% PDA (known program)
        { address: ACCT_WAL2, amount: "50" },  // 5% wallet
      ],
      [
        { pubkey: PDA_OWNER },
        { pubkey: WALLET_OWNER },
        { pubkey: PDA_OWNER },
        { pubkey: WALLET_OWNER },
      ],
      new Map([[PDA_OWNER.toBase58(), KNOWN_PROGRAM]]),
    );
    const result = await checkTopHolders(MINT, 1000n);
    // Wallet-only: wal1=30%, wal2=5% → top1=30%, top10=35%
    expect(result.top_1_percentage).toBe(30);
    expect(result.top_10_percentage).toBe(35);
    expect(result.risk).toBe("HIGH"); // top1 > 20%
    expect(result.note).toContain("2 PDA-owned accounts");
  });

  it("treats null getMultipleAccounts entries as wallets (conservative)", async () => {
    const ACCT_A = "AcctAAAA1111111111111111111111111111111111";
    const ACCT_B = "AcctBBBB1111111111111111111111111111111111";
    mockRpcWithOwners(
      [
        { address: ACCT_A, amount: "600" },
        { address: ACCT_B, amount: "200" },
      ],
      [
        null,                    // null → treated as wallet
        { pubkey: PDA_OWNER },   // PDA owned by known program
      ],
      new Map([[PDA_OWNER.toBase58(), KNOWN_PROGRAM]]),
    );
    const result = await checkTopHolders(MINT, 1000n);
    // ACCT_A: null owner → wallet (conservative), ACCT_B: known-program PDA excluded
    // Wallet-only: ACCT_A=60% → top1=60%, top10=60%
    expect(result.top_1_percentage).toBe(60);
    expect(result.top_holders_detail![0].owner).toBeNull();
    expect(result.top_holders_detail![0].is_protocol_account).toBe(false);
    expect(result.top_holders_detail![1].is_protocol_account).toBe(true);
  });

  it("counts PDA owned by unknown program as wallet concentration", async () => {
    const ACCT_PDA = "PdaAcct111111111111111111111111111111111111";
    const ACCT_WALLET = "WalAcct111111111111111111111111111111111111";
    mockRpcWithOwners(
      [
        { address: ACCT_PDA, amount: "600" },   // 60% — PDA owned by UNKNOWN program
        { address: ACCT_WALLET, amount: "200" }, // 20% — wallet
      ],
      [
        { pubkey: PDA_OWNER },
        { pubkey: WALLET_OWNER },
      ],
      new Map([[PDA_OWNER.toBase58(), UNKNOWN_PROGRAM]]),  // unknown program
    );
    const result = await checkTopHolders(MINT, 1000n);
    // PDA owned by unknown program → NOT excluded → counted as wallet concentration
    expect(result.top_1_percentage).toBe(60);
    expect(result.top_10_percentage).toBe(80);
    expect(result.top_holders_detail![0].is_protocol_account).toBe(false);
    expect(result.top_holders_detail![0].owner_program).toBe(UNKNOWN_PROGRAM);
    expect(result.top_holders_detail![1].is_protocol_account).toBe(false);
  });

  it("treats PDAs as wallets when PDA owner resolution fails", async () => {
    const ACCT_PDA = "PdaAcct111111111111111111111111111111111111";
    const ACCT_WALLET = "WalAcct111111111111111111111111111111111111";
    // Phase 1 succeeds, Phase 2 (PDA program resolution) fails
    const ownersResponse = [
      { data: [buildTokenAccountBuffer(PDA_OWNER), "base64"] },
      { data: [buildTokenAccountBuffer(WALLET_OWNER), "base64"] },
    ];
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          jsonrpc: "2.0", id: 1,
          result: { value: [
            { address: ACCT_PDA, amount: "600" },
            { address: ACCT_WALLET, amount: "200" },
          ] },
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { value: ownersResponse } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockRejectedValueOnce(new Error("Phase 2 RPC timeout")); // Phase 2 fails

    const result = await checkTopHolders(MINT, 1000n);
    // Phase 2 failure → ownerProgram=null → PDA not excluded (conservative)
    expect(result.top_1_percentage).toBe(60);
    expect(result.top_10_percentage).toBe(80);
    expect(result.top_holders_detail![0].is_protocol_account).toBe(false);
    expect(result.top_holders_detail![0].owner_program).toBeNull();
  });

  it("handles zero supply with owner resolution gracefully", async () => {
    mockRpcResponse([]);
    const result = await checkTopHolders(MINT, 0n);
    expect(result.top_10_percentage).toBe(0);
    expect(result.holder_count_estimate).toBe(0);
    expect(result.risk).toBe("SAFE");
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

  it("returns null when prefetched quote is null and DexScreener also null", async () => {
    const result = await checkLiquidity(MINT, null);
    expect(result).toBeNull();
  });

  it("returns null when no quote provided and DexScreener null", async () => {
    const result = await checkLiquidity(MINT);
    expect(result).toBeNull();
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

  it("returns null when numCreators overflows buffer (OOB protection)", async () => {
    // Build metadata with a crafted numCreators = 0xFFFFFFFF
    const parts: Buffer[] = [];
    parts.push(Buffer.from([4])); // key
    parts.push(Buffer.alloc(32)); // update_authority
    parts.push(Buffer.alloc(32)); // mint

    const borshStr = (s: string) => {
      const bytes = Buffer.from(s, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32LE(bytes.length);
      return Buffer.concat([len, bytes]);
    };

    parts.push(borshStr("Test"));
    parts.push(borshStr("TST"));
    parts.push(borshStr("https://test.com"));
    parts.push(Buffer.alloc(2)); // seller_fee_basis_points
    parts.push(Buffer.from([1])); // hasCreators = true

    // numCreators = 0xFFFFFFFF — should trigger bounds guard
    const numCreators = Buffer.alloc(4);
    numCreators.writeUInt32LE(0xffffffff);
    parts.push(numCreators);

    const data = Buffer.concat(parts);
    conn.getAccountInfo.mockResolvedValue({ data });
    const result = await checkMetadata(MINT);
    // Should return null (parse error caught by outer try/catch)
    expect(result).toBeNull();
  });

  it("returns null when metadata truncated before isMutable", async () => {
    // Build metadata that ends right before isMutable byte
    const parts: Buffer[] = [];
    parts.push(Buffer.from([4])); // key
    parts.push(Buffer.alloc(32)); // update_authority
    parts.push(Buffer.alloc(32)); // mint

    const borshStr = (s: string) => {
      const bytes = Buffer.from(s, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32LE(bytes.length);
      return Buffer.concat([len, bytes]);
    };

    parts.push(borshStr("Test"));
    parts.push(borshStr("TST"));
    parts.push(borshStr(""));
    parts.push(Buffer.alloc(2)); // seller_fee_basis_points
    parts.push(Buffer.from([0])); // hasCreators = false
    parts.push(Buffer.from([0])); // primary_sale_happened
    // Don't add isMutable byte — truncated

    const data = Buffer.concat(parts);
    conn.getAccountInfo.mockResolvedValue({ data });
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

  it("returns null time fields + established flag for 1000-sig token", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const sigs = Array.from({ length: 1000 }, (_, i) => ({
      blockTime: nowSec - i * 60,
    }));
    conn.getSignaturesForAddress.mockResolvedValue(sigs);
    const result = await checkTokenAge(MINT);
    expect(result.established).toBe(true);
    expect(result.token_age_hours).toBeNull();
    expect(result.token_age_minutes).toBeNull();
    expect(result.created_at).toBeNull();
  });

  it("returns established=true with null age when oldest 1000-sig has no blockTime", async () => {
    const sigs = Array.from({ length: 1000 }, () => ({ blockTime: null }));
    conn.getSignaturesForAddress.mockResolvedValue(sigs);
    const result = await checkTokenAge(MINT);
    expect(result.established).toBe(true);
    expect(result.token_age_hours).toBeNull();
    expect(result.created_at).toBeNull();
  });

  it("does not set established flag for < 1000 sig tokens", async () => {
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
        status: "OK",
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
    score_breakdown: {},
    response_signature: "mock-signature",
    signer_pubkey: "mock-pubkey",
    changes: null,
    alerts: [],
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
    expect(result.full_report.url).toContain("/v1/check?mint=");
    expect(result.full_report.price_usd).toBe("$0.008");
    expect(result.full_report.payment_protocol).toBe("x402");
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
    expect(result.full_report.url).toBe(
      `https://api.example.com/v1/check?mint=${MINT}`,
    );
    expect(result.full_report.price_usd).toBe("$0.008");
    expect(result.full_report.payment_protocol).toBe("x402");
  });

  it("full_report omits baseUrl when not provided", async () => {
    mockGetCached.mockReturnValue(makeFullResult());
    const { result } = await checkTokenLite(MINT);
    expect(result.full_report.url).toBe(`/v1/check?mint=${MINT}`);
    expect(result.full_report.url).not.toContain("https://");
  });

  it("propagates fromCache correctly", async () => {
    mockGetCached.mockReturnValue(makeFullResult());
    const { fromCache } = await checkTokenLite(MINT);
    expect(fromCache).toBe(true);
  });
});

