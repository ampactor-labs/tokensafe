import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  fetchRoundTrip,
  fetchQuote,
  SOL_MINT,
  BUY_AMOUNT_LAMPORTS,
  BUY_AMOUNT_LAMPORTS_BIGINT,
} from "../src/analysis/checks/jupiter.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function jupiterOkResponse(
  overrides: {
    outAmount?: string;
    priceImpactPct?: string;
    label?: string;
    ammKey?: string;
  } = {},
) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        outAmount: overrides.outAmount ?? "500000000",
        routePlan: [
          {
            swapInfo: {
              label: overrides.label ?? "Raydium",
              ammKey: overrides.ammKey ?? "pool123",
            },
          },
        ],
        priceImpactPct: overrides.priceImpactPct ?? "0.5",
      }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchQuote", () => {
  it("returns parsed quote on success", async () => {
    mockFetch.mockResolvedValue(
      jupiterOkResponse({
        outAmount: "999",
        label: "Orca",
        ammKey: "orcaPool",
      }),
    );
    const result = await fetchQuote(SOL_MINT, BONK_MINT, "100000000");
    expect(result).not.toBeNull();
    expect(result!.outAmount).toBe("999");
    expect(result!.primaryPool).toBe("Orca");
    expect(result!.poolAddress).toBe("orcaPool");
  });

  it("returns null on non-ok response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400 });
    const result = await fetchQuote(SOL_MINT, BONK_MINT, "100000000");
    expect(result).toBeNull();
  });

  it("returns null when routePlan is empty", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ routePlan: [] }),
    });
    const result = await fetchQuote(SOL_MINT, BONK_MINT, "100000000");
    expect(result).toBeNull();
  });
});

describe("fetchRoundTrip", () => {
  it("uses SOL as pair and BUY_AMOUNT_LAMPORTS for normal tokens", async () => {
    mockFetch
      .mockResolvedValueOnce(jupiterOkResponse({ outAmount: "500000000" })) // buy
      .mockResolvedValueOnce(jupiterOkResponse({ outAmount: "99000000" })); // sell

    const result = await fetchRoundTrip(BONK_MINT);

    // Verify buy call uses SOL as input, BONK as output
    const buyUrl = mockFetch.mock.calls[0][0] as string;
    expect(buyUrl).toContain(`inputMint=${SOL_MINT}`);
    expect(buyUrl).toContain(`outputMint=${BONK_MINT}`);
    expect(buyUrl).toContain(`amount=${BUY_AMOUNT_LAMPORTS}`);

    expect(result.buyQuote).not.toBeNull();
    expect(result.sellQuote).not.toBeNull();
    expect(result.buyInputAmount).toBe(BUY_AMOUNT_LAMPORTS_BIGINT);
  });

  it("uses USDC as pair and 5000000 amount for wSOL", async () => {
    mockFetch
      .mockResolvedValueOnce(jupiterOkResponse({ outAmount: "30000000" })) // buy
      .mockResolvedValueOnce(jupiterOkResponse({ outAmount: "4700000" })); // sell

    const result = await fetchRoundTrip(SOL_MINT);

    // Verify buy call uses USDC as input (not SOL — can't self-quote)
    const buyUrl = mockFetch.mock.calls[0][0] as string;
    expect(buyUrl).toContain(`inputMint=${USDC_MINT}`);
    expect(buyUrl).toContain(`outputMint=${SOL_MINT}`);
    expect(buyUrl).toContain("amount=5000000");

    expect(result.buyInputAmount).toBe(5_000_000n);
  });

  it("sell quote uses buyQuote.outAmount as input amount", async () => {
    mockFetch
      .mockResolvedValueOnce(jupiterOkResponse({ outAmount: "12345678" }))
      .mockResolvedValueOnce(jupiterOkResponse({ outAmount: "90000000" }));

    await fetchRoundTrip(BONK_MINT);

    // Sell call should use the buy output amount
    const sellUrl = mockFetch.mock.calls[1][0] as string;
    expect(sellUrl).toContain("amount=12345678");
    // Sell swaps token back to SOL
    expect(sellUrl).toContain(`inputMint=${BONK_MINT}`);
    expect(sellUrl).toContain(`outputMint=${SOL_MINT}`);
  });

  it("returns null quotes when buy route fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 });

    const result = await fetchRoundTrip(BONK_MINT);

    expect(result.buyQuote).toBeNull();
    expect(result.sellQuote).toBeNull();
    expect(result.buyInputAmount).toBe(BUY_AMOUNT_LAMPORTS_BIGINT);
    // Should not have made a sell call
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns null quotes when buy outAmount is zero", async () => {
    mockFetch.mockResolvedValueOnce(jupiterOkResponse({ outAmount: "0" }));

    const result = await fetchRoundTrip(BONK_MINT);
    expect(result.buyQuote).toBeNull();
    expect(result.sellQuote).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns buyQuote with null sellQuote when sell route fails", async () => {
    mockFetch
      .mockResolvedValueOnce(jupiterOkResponse({ outAmount: "500000000" }))
      .mockResolvedValueOnce({ ok: false, status: 400 });

    const result = await fetchRoundTrip(BONK_MINT);

    expect(result.buyQuote).not.toBeNull();
    expect(result.sellQuote).toBeNull();
    expect(result.buyInputAmount).toBe(BUY_AMOUNT_LAMPORTS_BIGINT);
  });

  it("buyInputAmount matches actual buy amount for both paths", async () => {
    // Normal token path
    mockFetch
      .mockResolvedValueOnce(jupiterOkResponse())
      .mockResolvedValueOnce(jupiterOkResponse());
    const normalResult = await fetchRoundTrip(BONK_MINT);
    expect(normalResult.buyInputAmount).toBe(BigInt(BUY_AMOUNT_LAMPORTS));

    vi.clearAllMocks();

    // wSOL path
    mockFetch
      .mockResolvedValueOnce(jupiterOkResponse())
      .mockResolvedValueOnce(jupiterOkResponse());
    const wsolResult = await fetchRoundTrip(SOL_MINT);
    expect(wsolResult.buyInputAmount).toBe(5_000_000n);
  });
});
