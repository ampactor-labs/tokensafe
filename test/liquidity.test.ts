import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

// Mock RPC
vi.mock("../src/solana/rpc.js", () => ({
  getConnection: vi.fn(),
}));

// Mock logger
vi.mock("../src/utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Mock global fetch for Jupiter
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  checkLiquidity,
  KNOWN_LOCKERS,
} from "../src/analysis/checks/liquidity.js";
import { getConnection } from "../src/solana/rpc.js";

const mockGetConnection = vi.mocked(getConnection);

const FAKE_MINT = "So11111111111111111111111111111111111111112";
const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

// Helper: build a Jupiter quote response
function jupiterResponse(
  overrides: {
    label?: string;
    ammKey?: string;
    priceImpactPct?: string;
  } = {},
) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        routePlan: [
          {
            swapInfo: {
              label: overrides.label ?? "Raydium",
              ammKey:
                overrides.ammKey ??
                "PoolAddress111111111111111111111111111111111",
            },
          },
        ],
        priceImpactPct: overrides.priceImpactPct ?? "0.5",
      }),
  };
}

// Helper: build a 752-byte Raydium AMM v4 pool account
function makePoolAccount(lpMintPubkey: PublicKey) {
  const data = Buffer.alloc(752);
  // Write LP mint at offset 432
  lpMintPubkey.toBuffer().copy(data, 432);
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
  // Jupiter response scenarios
  // -------------------------------------------------------------------------

  it("returns noLiquidity when Jupiter returns non-ok response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400 });
    const result = await checkLiquidity(FAKE_MINT);
    expect(result.has_liquidity).toBe(false);
    expect(result.risk).toBe("CRITICAL");
    expect(result.liquidity_rating).toBeNull();
  });

  it("returns noLiquidity when Jupiter returns empty routePlan", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ routePlan: [] }),
    });
    const result = await checkLiquidity(FAKE_MINT);
    expect(result.has_liquidity).toBe(false);
  });

  it("extracts priceImpactPct, ammKey, and label from Jupiter", async () => {
    mockFetch.mockResolvedValue(
      jupiterResponse({
        label: "Orca",
        ammKey: "OrcaPool111111111111111111111111111111111111",
        priceImpactPct: "2.5",
      }),
    );
    const result = await checkLiquidity(FAKE_MINT);
    expect(result.has_liquidity).toBe(true);
    expect(result.primary_pool).toBe("Orca");
    expect(result.pool_address).toBe(
      "OrcaPool111111111111111111111111111111111111",
    );
    expect(result.price_impact_pct).toBe(2.5);
    expect(result.liquidity_rating).toBe("MODERATE"); // 1 <= 2.5 < 5
  });

  it("derives DEEP rating for price impact < 1%", async () => {
    mockFetch.mockResolvedValue(jupiterResponse({ priceImpactPct: "0.3" }));
    const result = await checkLiquidity(FAKE_MINT);
    expect(result.liquidity_rating).toBe("DEEP");
  });

  it("derives SHALLOW rating for price impact 5-20%", async () => {
    mockFetch.mockResolvedValue(jupiterResponse({ priceImpactPct: "12.0" }));
    const result = await checkLiquidity(FAKE_MINT);
    expect(result.liquidity_rating).toBe("SHALLOW");
  });

  it("derives NONE rating for price impact >= 20%", async () => {
    mockFetch.mockResolvedValue(jupiterResponse({ priceImpactPct: "25.0" }));
    const result = await checkLiquidity(FAKE_MINT);
    expect(result.liquidity_rating).toBe("NONE");
  });

  // -------------------------------------------------------------------------
  // LP lock detection — skipped for non-Raydium pools
  // -------------------------------------------------------------------------

  it("returns lp_locked=null for non-Raydium pool (Orca)", async () => {
    mockFetch.mockResolvedValue(
      jupiterResponse({ label: "Orca", ammKey: "OrcaPool1111" }),
    );
    const result = await checkLiquidity(FAKE_MINT);
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

    mockFetch.mockResolvedValue(
      jupiterResponse({
        label: "Raydium",
        ammKey: PublicKey.unique().toBase58(),
      }),
    );

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

    const result = await checkLiquidity(FAKE_MINT);
    expect(result.lp_mint).toBe(lpMint.toBase58());
    expect(result.lp_locker).toBe("Streamflow");
  });

  it("returns lp_mint=null and lp_locker=null for non-Raydium pools", async () => {
    mockFetch.mockResolvedValue(
      jupiterResponse({ label: "Orca", ammKey: "OrcaPool1111" }),
    );
    const result = await checkLiquidity(FAKE_MINT);
    expect(result.lp_mint).toBeNull();
    expect(result.lp_locker).toBeNull();
  });

  it("detects locked LP when top holder is owned by Streamflow", async () => {
    const lpMint = PublicKey.unique();
    const streamflowPubkey = new PublicKey(
      "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m",
    );
    const tokenAccount = PublicKey.unique();

    mockFetch.mockResolvedValue(
      jupiterResponse({
        label: "Raydium",
        ammKey: PublicKey.unique().toBase58(),
      }),
    );

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

    const result = await checkLiquidity(FAKE_MINT);
    expect(result.lp_locked).toBe(true);
    expect(result.lp_lock_percentage).toBeGreaterThan(0);
  });

  it("detects locked LP when top holder is owned by UNCX", async () => {
    const lpMint = PublicKey.unique();
    const uncxPubkey = new PublicKey(
      "UNCX77nZrA3TdAxMEggqG18xxpgiNGT6iqyynPwpoxN",
    );
    const tokenAccount = PublicKey.unique();

    mockFetch.mockResolvedValue(
      jupiterResponse({
        label: "Raydium",
        ammKey: PublicKey.unique().toBase58(),
      }),
    );

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

    const result = await checkLiquidity(FAKE_MINT);
    expect(result.lp_locked).toBe(true);
  });

  it("returns lp_locked=false when no known locker found", async () => {
    const lpMint = PublicKey.unique();
    const randomOwner = PublicKey.unique();
    const tokenAccount = PublicKey.unique();

    mockFetch.mockResolvedValue(
      jupiterResponse({
        label: "Raydium",
        ammKey: PublicKey.unique().toBase58(),
      }),
    );

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

    const result = await checkLiquidity(FAKE_MINT);
    expect(result.lp_locked).toBe(false);
    expect(result.lp_lock_percentage).toBe(0);
  });

  it("returns lp_locked=null when pool account has wrong length", async () => {
    mockFetch.mockResolvedValue(
      jupiterResponse({
        label: "Raydium",
        ammKey: PublicKey.unique().toBase58(),
      }),
    );

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

    const result = await checkLiquidity(FAKE_MINT);
    expect(result.lp_locked).toBeNull();
    // Should not have called getTokenLargestAccounts since pool was invalid
    expect(mockConnection.getTokenLargestAccounts).not.toHaveBeenCalled();
  });

  it("returns lp_locked=null when pool account is null", async () => {
    mockFetch.mockResolvedValue(
      jupiterResponse({
        label: "Raydium",
        ammKey: PublicKey.unique().toBase58(),
      }),
    );

    const mockConnection = {
      getAccountInfo: vi.fn().mockResolvedValue(null),
      getTokenLargestAccounts: vi.fn(),
      getMultipleAccountsInfo: vi.fn(),
    };
    mockGetConnection.mockReturnValue(mockConnection as any);

    const result = await checkLiquidity(FAKE_MINT);
    expect(result.lp_locked).toBeNull();
  });

  it("handles RPC error in LP lock detection gracefully", async () => {
    mockFetch.mockResolvedValue(
      jupiterResponse({
        label: "Raydium",
        ammKey: PublicKey.unique().toBase58(),
      }),
    );

    const mockConnection = {
      getAccountInfo: vi.fn().mockRejectedValue(new Error("RPC timeout")),
    };
    mockGetConnection.mockReturnValue(mockConnection as any);

    const result = await checkLiquidity(FAKE_MINT);
    // Should still return liquidity info from Jupiter, just with null LP lock
    expect(result.has_liquidity).toBe(true);
    expect(result.lp_locked).toBeNull();
  });

  it("skips null entries from getMultipleAccountsInfo", async () => {
    const lpMint = PublicKey.unique();
    const randomOwner = PublicKey.unique();
    const tokenAccount1 = PublicKey.unique();
    const tokenAccount2 = PublicKey.unique();

    mockFetch.mockResolvedValue(
      jupiterResponse({
        label: "Raydium",
        ammKey: PublicKey.unique().toBase58(),
      }),
    );

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

    const result = await checkLiquidity(FAKE_MINT);
    // Should not crash, should process second account fine
    expect(result.lp_locked).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Risk determination
  // -------------------------------------------------------------------------

  it("returns WARNING risk for shallow liquidity without lock info", async () => {
    mockFetch.mockResolvedValue(
      jupiterResponse({ label: "Orca", priceImpactPct: "15.0" }),
    );
    const result = await checkLiquidity(FAKE_MINT);
    expect(result.liquidity_rating).toBe("SHALLOW");
    expect(result.risk).toBe("WARNING");
  });

  it("returns SAFE risk for deep liquidity", async () => {
    mockFetch.mockResolvedValue(
      jupiterResponse({ label: "Orca", priceImpactPct: "0.1" }),
    );
    const result = await checkLiquidity(FAKE_MINT);
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
