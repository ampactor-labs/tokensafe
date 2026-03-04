import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { JupiterQuote } from "../src/analysis/checks/jupiter.js";

// Mock RPC
vi.mock("../src/solana/rpc.js", () => ({
  getConnection: vi.fn(),
}));

// Mock logger
vi.mock("../src/utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Mock DexScreener — default to null (no fallback data)
vi.mock("../src/analysis/checks/dexscreener.js", () => ({
  fetchDexScreenerLiquidity: vi.fn().mockResolvedValue(null),
}));

import {
  checkLiquidity,
  KNOWN_LOCKERS,
} from "../src/analysis/checks/liquidity.js";
import { getConnection } from "../src/solana/rpc.js";
import { fetchDexScreenerLiquidity } from "../src/analysis/checks/dexscreener.js";

const mockGetConnection = vi.mocked(getConnection);

const FAKE_MINT = "So11111111111111111111111111111111111111112";
const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

// Helper: build a prefetched JupiterQuote
function makeQuote(overrides: Partial<JupiterQuote> = {}): JupiterQuote {
  return {
    outAmount: overrides.outAmount ?? "1000000",
    priceImpactPct: overrides.priceImpactPct ?? 0.5,
    primaryPool: overrides.primaryPool ?? "Raydium",
    poolAddress:
      overrides.poolAddress ?? "PoolAddress111111111111111111111111111111111",
  };
}

// Helper: build a 752-byte Raydium AMM v4 pool account
function makePoolAccount(lpMintPubkey: PublicKey) {
  const data = Buffer.alloc(752);
  // Write LP mint at offset 464 (verified against SOL/USDC pool)
  lpMintPubkey.toBuffer().copy(data, 464);
  return {
    owner: new PublicKey(RAYDIUM_AMM_V4),
    data,
    lamports: 1000000,
    executable: false,
  };
}

// Helper: build a SPL Token account with owner at bytes 32-64
function makeTokenAccountInfo(ownerPubkey: PublicKey) {
  const data = Buffer.alloc(165); // standard SPL token account size
  // mint at 0-32 (we don't care)
  // owner at 32-64
  ownerPubkey.toBuffer().copy(data, 32);
  return {
    owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    data,
    lamports: 2039280,
    executable: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkLiquidity", () => {
  // -------------------------------------------------------------------------
  // Prefetched quote scenarios
  // -------------------------------------------------------------------------

  it("returns null when prefetched quote is null and DexScreener also null", async () => {
    const result = await checkLiquidity(FAKE_MINT, null);
    expect(result).toBeNull();
  });

  it("returns null when no quote provided and DexScreener has no data", async () => {
    const result = await checkLiquidity(FAKE_MINT);
    expect(result).toBeNull();
  });

  it("returns noLiquidity when DexScreener confirms zero pairs", async () => {
    vi.mocked(fetchDexScreenerLiquidity).mockResolvedValueOnce({
      has_liquidity: false,
      primary_pool: null,
      pool_address: null,
      liquidity_usd: 0,
      liquidity_rating: "NONE",
    });
    const result = await checkLiquidity(FAKE_MINT, null);
    expect(result).not.toBeNull();
    expect(result!.has_liquidity).toBe(false);
    expect(result!.risk).toBe("CRITICAL");
  });

  it("uses DexScreener fallback when Jupiter quote is null", async () => {
    vi.mocked(fetchDexScreenerLiquidity).mockResolvedValueOnce({
      has_liquidity: true,
      primary_pool: "raydium",
      pool_address: "DexPool111",
      liquidity_usd: 150_000,
      liquidity_rating: "DEEP",
    });

    const result = await checkLiquidity(FAKE_MINT, null);
    expect(result.has_liquidity).toBe(true);
    expect(result.primary_pool).toBe("raydium");
    expect(result.pool_address).toBe("DexPool111");
    expect(result.liquidity_rating).toBe("DEEP");
    expect(result.price_impact_pct).toBeNull();
    expect(result.risk).toBe("SAFE");
  });

  it("returns WARNING risk from DexScreener when liquidity is shallow", async () => {
    vi.mocked(fetchDexScreenerLiquidity).mockResolvedValueOnce({
      has_liquidity: true,
      primary_pool: "meteora",
      pool_address: "MetPool111",
      liquidity_usd: 500,
      liquidity_rating: "NONE",
    });

    const result = await checkLiquidity(FAKE_MINT, null);
    expect(result.has_liquidity).toBe(true);
    expect(result.risk).toBe("WARNING");
  });

  it("extracts priceImpactPct, poolAddress, and primaryPool from quote", async () => {
    const quote = makeQuote({
      primaryPool: "Orca",
      poolAddress: "OrcaPool111111111111111111111111111111111111",
      priceImpactPct: 2.5,
    });
    const result = await checkLiquidity(FAKE_MINT, quote);
    expect(result.has_liquidity).toBe(true);
    expect(result.primary_pool).toBe("Orca");
    expect(result.pool_address).toBe(
      "OrcaPool111111111111111111111111111111111111",
    );
    expect(result.price_impact_pct).toBe(2.5);
    expect(result.liquidity_rating).toBe("MODERATE"); // 1 <= 2.5 < 5
  });

  it("derives DEEP rating for price impact < 1%", async () => {
    const result = await checkLiquidity(
      FAKE_MINT,
      makeQuote({ priceImpactPct: 0.3 }),
    );
    expect(result.liquidity_rating).toBe("DEEP");
  });

  it("derives SHALLOW rating for price impact 5-20%", async () => {
    const result = await checkLiquidity(
      FAKE_MINT,
      makeQuote({ priceImpactPct: 12.0 }),
    );
    expect(result.liquidity_rating).toBe("SHALLOW");
  });

  it("derives NONE rating for price impact >= 20%", async () => {
    const result = await checkLiquidity(
      FAKE_MINT,
      makeQuote({ priceImpactPct: 25.0 }),
    );
    expect(result.liquidity_rating).toBe("NONE");
  });

  // -------------------------------------------------------------------------
  // LP lock detection — skipped for non-Raydium pools
  // -------------------------------------------------------------------------

  it("returns lp_locked=null for non-Raydium pool (Orca)", async () => {
    const result = await checkLiquidity(
      FAKE_MINT,
      makeQuote({ primaryPool: "Orca", poolAddress: "OrcaPool1111" }),
    );
    expect(result.lp_locked).toBeNull();
    expect(result.lp_lock_percentage).toBeNull();
  });

  // -------------------------------------------------------------------------
  // LP lock detection — Raydium AMM v4
  // -------------------------------------------------------------------------

  it("includes lp_mint and lp_locker when locked LP detected", async () => {
    const lpMint = PublicKey.unique();
    const streamflowPubkey = new PublicKey(
      "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m",
    );
    const tokenAccount = PublicKey.unique();
    const poolAddr = PublicKey.unique().toBase58();

    const mockConnection = {
      getAccountInfo: vi.fn().mockResolvedValue(makePoolAccount(lpMint)),
      getTokenLargestAccounts: vi.fn().mockResolvedValue({
        value: [
          {
            address: tokenAccount,
            amount: "1000000",
            decimals: 6,
            uiAmount: 1,
          },
        ],
      }),
      getMultipleAccountsInfo: vi
        .fn()
        .mockResolvedValue([makeTokenAccountInfo(streamflowPubkey)]),
    };
    mockGetConnection.mockReturnValue(mockConnection as any);

    const result = await checkLiquidity(
      FAKE_MINT,
      makeQuote({ primaryPool: "Raydium", poolAddress: poolAddr }),
    );
    expect(result.lp_mint).toBe(lpMint.toBase58());
    expect(result.lp_locker).toBe("Streamflow");
  });

  it("returns lp_mint=null and lp_locker=null for non-Raydium pools", async () => {
    const result = await checkLiquidity(
      FAKE_MINT,
      makeQuote({ primaryPool: "Orca", poolAddress: "OrcaPool1111" }),
    );
    expect(result.lp_mint).toBeNull();
    expect(result.lp_locker).toBeNull();
  });

  it("detects locked LP when top holder is owned by Streamflow", async () => {
    const lpMint = PublicKey.unique();
    const streamflowPubkey = new PublicKey(
      "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m",
    );
    const tokenAccount = PublicKey.unique();
    const poolAddr = PublicKey.unique().toBase58();

    const mockConnection = {
      getAccountInfo: vi.fn().mockResolvedValue(makePoolAccount(lpMint)),
      getTokenLargestAccounts: vi.fn().mockResolvedValue({
        value: [
          {
            address: tokenAccount,
            amount: "1000000",
            decimals: 6,
            uiAmount: 1,
          },
        ],
      }),
      getMultipleAccountsInfo: vi
        .fn()
        .mockResolvedValue([makeTokenAccountInfo(streamflowPubkey)]),
    };
    mockGetConnection.mockReturnValue(mockConnection as any);

    const result = await checkLiquidity(
      FAKE_MINT,
      makeQuote({ primaryPool: "Raydium", poolAddress: poolAddr }),
    );
    expect(result.lp_locked).toBe(true);
    expect(result.lp_lock_percentage).toBeGreaterThan(0);
  });

  it("detects locked LP when top holder is owned by UNCX", async () => {
    const lpMint = PublicKey.unique();
    const uncxPubkey = new PublicKey(
      "UNCX77nZrA3TdAxMEggqG18xxpgiNGT6iqyynPwpoxN",
    );
    const tokenAccount = PublicKey.unique();
    const poolAddr = PublicKey.unique().toBase58();

    const mockConnection = {
      getAccountInfo: vi.fn().mockResolvedValue(makePoolAccount(lpMint)),
      getTokenLargestAccounts: vi.fn().mockResolvedValue({
        value: [
          {
            address: tokenAccount,
            amount: "800000",
            decimals: 6,
            uiAmount: 0.8,
          },
        ],
      }),
      getMultipleAccountsInfo: vi
        .fn()
        .mockResolvedValue([makeTokenAccountInfo(uncxPubkey)]),
    };
    mockGetConnection.mockReturnValue(mockConnection as any);

    const result = await checkLiquidity(
      FAKE_MINT,
      makeQuote({ primaryPool: "Raydium", poolAddress: poolAddr }),
    );
    expect(result.lp_locked).toBe(true);
  });

  it("returns lp_locked=false when no known locker found", async () => {
    const lpMint = PublicKey.unique();
    const randomOwner = PublicKey.unique();
    const tokenAccount = PublicKey.unique();
    const poolAddr = PublicKey.unique().toBase58();

    const mockConnection = {
      getAccountInfo: vi.fn().mockResolvedValue(makePoolAccount(lpMint)),
      getTokenLargestAccounts: vi.fn().mockResolvedValue({
        value: [
          {
            address: tokenAccount,
            amount: "500000",
            decimals: 6,
            uiAmount: 0.5,
          },
        ],
      }),
      getMultipleAccountsInfo: vi
        .fn()
        .mockResolvedValue([makeTokenAccountInfo(randomOwner)]),
    };
    mockGetConnection.mockReturnValue(mockConnection as any);

    const result = await checkLiquidity(
      FAKE_MINT,
      makeQuote({ primaryPool: "Raydium", poolAddress: poolAddr }),
    );
    expect(result.lp_locked).toBe(false);
    expect(result.lp_lock_percentage).toBe(0);
  });

  it("returns lp_locked=null when pool account has wrong length", async () => {
    const poolAddr = PublicKey.unique().toBase58();

    const mockConnection = {
      getAccountInfo: vi.fn().mockResolvedValue({
        owner: new PublicKey(RAYDIUM_AMM_V4),
        data: Buffer.alloc(500), // wrong length
        lamports: 1000000,
        executable: false,
      }),
      getTokenLargestAccounts: vi.fn(),
      getMultipleAccountsInfo: vi.fn(),
    };
    mockGetConnection.mockReturnValue(mockConnection as any);

    const result = await checkLiquidity(
      FAKE_MINT,
      makeQuote({ primaryPool: "Raydium", poolAddress: poolAddr }),
    );
    expect(result.lp_locked).toBeNull();
    // Should not have called getTokenLargestAccounts since pool was invalid
    expect(mockConnection.getTokenLargestAccounts).not.toHaveBeenCalled();
  });

  it("returns lp_locked=null when pool account is null", async () => {
    const poolAddr = PublicKey.unique().toBase58();

    const mockConnection = {
      getAccountInfo: vi.fn().mockResolvedValue(null),
      getTokenLargestAccounts: vi.fn(),
      getMultipleAccountsInfo: vi.fn(),
    };
    mockGetConnection.mockReturnValue(mockConnection as any);

    const result = await checkLiquidity(
      FAKE_MINT,
      makeQuote({ primaryPool: "Raydium", poolAddress: poolAddr }),
    );
    expect(result.lp_locked).toBeNull();
  });

  it("handles RPC error in LP lock detection gracefully", async () => {
    const poolAddr = PublicKey.unique().toBase58();

    const mockConnection = {
      getAccountInfo: vi.fn().mockRejectedValue(new Error("RPC timeout")),
    };
    mockGetConnection.mockReturnValue(mockConnection as any);

    const result = await checkLiquidity(
      FAKE_MINT,
      makeQuote({ primaryPool: "Raydium", poolAddress: poolAddr }),
    );
    // Should still return liquidity info from quote, just with null LP lock
    expect(result.has_liquidity).toBe(true);
    expect(result.lp_locked).toBeNull();
  });

  it("skips null entries from getMultipleAccountsInfo", async () => {
    const lpMint = PublicKey.unique();
    const randomOwner = PublicKey.unique();
    const tokenAccount1 = PublicKey.unique();
    const tokenAccount2 = PublicKey.unique();
    const poolAddr = PublicKey.unique().toBase58();

    const mockConnection = {
      getAccountInfo: vi.fn().mockResolvedValue(makePoolAccount(lpMint)),
      getTokenLargestAccounts: vi.fn().mockResolvedValue({
        value: [
          {
            address: tokenAccount1,
            amount: "500000",
            decimals: 6,
            uiAmount: 0.5,
          },
          {
            address: tokenAccount2,
            amount: "300000",
            decimals: 6,
            uiAmount: 0.3,
          },
        ],
      }),
      getMultipleAccountsInfo: vi
        .fn()
        .mockResolvedValue([null, makeTokenAccountInfo(randomOwner)]),
    };
    mockGetConnection.mockReturnValue(mockConnection as any);

    const result = await checkLiquidity(
      FAKE_MINT,
      makeQuote({ primaryPool: "Raydium", poolAddress: poolAddr }),
    );
    // Should not crash, should process second account fine
    expect(result.lp_locked).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Risk determination
  // -------------------------------------------------------------------------

  it("returns WARNING risk for shallow liquidity without lock info", async () => {
    const result = await checkLiquidity(
      FAKE_MINT,
      makeQuote({ primaryPool: "Orca", priceImpactPct: 15.0 }),
    );
    expect(result.liquidity_rating).toBe("SHALLOW");
    expect(result.risk).toBe("WARNING");
  });

  it("returns SAFE risk for deep liquidity", async () => {
    const result = await checkLiquidity(
      FAKE_MINT,
      makeQuote({ primaryPool: "Orca", priceImpactPct: 0.1 }),
    );
    expect(result.liquidity_rating).toBe("DEEP");
    expect(result.risk).toBe("SAFE");
  });
});

describe("KNOWN_LOCKERS", () => {
  it("contains Streamflow address", () => {
    expect(
      KNOWN_LOCKERS.has("strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m"),
    ).toBe(true);
  });

  it("contains at least 9 locker addresses", () => {
    expect(KNOWN_LOCKERS.size).toBeGreaterThanOrEqual(9);
  });
});
