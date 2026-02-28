import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { PublicKey } from "@solana/web3.js";

// ── Mocks (declared before imports per vitest hoisting) ─────────────

vi.mock("../src/solana/rpc.js", () => ({
  getConnection: vi.fn(),
}));

vi.mock("@solana/spl-token", () => ({
  getMint: vi.fn(),
}));

vi.mock("../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
    conn.getAccountInfo.mockResolvedValue(null);
    await expect(checkMintAccount(MINT)).rejects.toThrow("not found on chain");
  });

  it("returns renounced authorities for SPL Token mint", async () => {
    conn.getAccountInfo.mockResolvedValue({
      owner: new PublicKey(SPL_TOKEN_PROGRAM),
      data: Buffer.alloc(82),
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
  });

  it("returns active authorities", async () => {
    conn.getAccountInfo.mockResolvedValue({
      owner: new PublicKey(SPL_TOKEN_PROGRAM),
      data: Buffer.alloc(82),
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
    conn.getAccountInfo.mockResolvedValue({
      owner: new PublicKey(TOKEN_2022_PROGRAM),
      data: Buffer.alloc(83), // 82 base + 1 account_type
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

    conn.getAccountInfo.mockResolvedValue({
      owner: new PublicKey(TOKEN_2022_PROGRAM),
      data,
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

    conn.getAccountInfo.mockResolvedValue({
      owner: new PublicKey(TOKEN_2022_PROGRAM),
      data,
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
    conn.getAccountInfo.mockResolvedValue({
      owner: new PublicKey(TOKEN_2022_PROGRAM),
      data: Buffer.alloc(83),
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
});

// ════════════════════════════════════════════════════════════════════
// 3. liquidity
// ════════════════════════════════════════════════════════════════════

describe("checkLiquidity", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("returns SAFE with pool label when routes found", async () => {
    (fetch as Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          routePlan: [{ swapInfo: { label: "Raydium" } }],
        }),
    });
    const result = await checkLiquidity(MINT);
    expect(result.has_liquidity).toBe(true);
    expect(result.primary_pool).toBe("Raydium");
    expect(result.risk).toBe("SAFE");
  });

  it("returns CRITICAL when response is not ok", async () => {
    (fetch as Mock).mockResolvedValue({ ok: false });
    const result = await checkLiquidity(MINT);
    expect(result.has_liquidity).toBe(false);
    expect(result.risk).toBe("CRITICAL");
  });

  it("returns CRITICAL when routePlan is empty", async () => {
    (fetch as Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ routePlan: [] }),
    });
    const result = await checkLiquidity(MINT);
    expect(result.has_liquidity).toBe(false);
    expect(result.risk).toBe("CRITICAL");
  });

  it("returns CRITICAL when fetch throws", async () => {
    (fetch as Mock).mockRejectedValue(new Error("network error"));
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

  it("parses name, symbol, and URI", async () => {
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
    expect(result.created_at).toBeNull();
  });

  it("returns null age when oldest sig has no blockTime", async () => {
    conn.getSignaturesForAddress.mockResolvedValue([{ blockTime: null }]);
    const result = await checkTokenAge(MINT);
    expect(result.token_age_hours).toBeNull();
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
    expect(result.created_at).not.toBeNull();
  });

  it("returns null age for established token (1000 sigs)", async () => {
    const sigs = Array.from({ length: 1000 }, (_, i) => ({
      blockTime: Math.floor(Date.now() / 1000) - i * 60,
    }));
    conn.getSignaturesForAddress.mockResolvedValue(sigs);
    const result = await checkTokenAge(MINT);
    expect(result.token_age_hours).toBeNull();
    expect(result.created_at).toBeNull();
  });

  it("returns null age when RPC throws", async () => {
    conn.getSignaturesForAddress.mockRejectedValue(new Error("timeout"));
    const result = await checkTokenAge(MINT);
    expect(result.token_age_hours).toBeNull();
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
    const result = analyzeHoneypot(buyQuote, sellQuote);
    expect(result.can_sell).toBe(true);
    expect(result.risk).toBe("SAFE");
  });

  it("returns DANGEROUS when buy quote is null", () => {
    const result = analyzeHoneypot(null, null);
    expect(result.can_sell).toBe(false);
    expect(result.risk).toBe("DANGEROUS");
  });

  it("returns DANGEROUS when sell quote is null (true honeypot)", () => {
    const result = analyzeHoneypot(buyQuote, null);
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
    const result = analyzeHoneypot(buyQuote, sellQuote);
    expect(result.can_sell).toBe(true);
    expect(result.risk).toBe("DANGEROUS");
    expect(result.sell_tax_bps).toBeGreaterThan(1000);
  });
});
