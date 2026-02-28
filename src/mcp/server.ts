import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PublicKey } from "@solana/web3.js";
import { checkToken, checkTokenLite } from "../analysis/token-checker.js";
import { monitorTokens } from "../analysis/monitor.js";
import { ApiError } from "../utils/errors.js";

function validateMint(address: string): void {
  try {
    new PublicKey(address);
  } catch {
    throw new Error(`Invalid Solana mint address: ${address}`);
  }
}

function parseMintList(csv: string, max: number): string[] {
  const mints = [
    ...new Set(
      csv
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
    ),
  ];
  if (mints.length === 0) throw new Error("No valid mint addresses provided");
  if (mints.length > max)
    throw new Error(`Maximum ${max} mints, got ${mints.length}`);
  for (const m of mints) validateMint(m);
  return mints;
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "tokensafe", version: "1.0.0" });

  server.registerTool(
    "solana_token_safety_lite",
    {
      description:
        "Quick free safety check for any Solana SPL token. Returns risk score (0-100), risk level, and a human-readable summary. Same analysis engine as the full check but without detailed per-check breakdowns. Use for fast screening before deciding whether to pay for a full report via the x402 REST API.",
      inputSchema: {
        mint_address: z
          .string()
          .describe("Solana token mint address in base58 format"),
      },
    },
    async ({ mint_address }) => {
      validateMint(mint_address);
      const { result } = await checkTokenLite(mint_address);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "solana_token_safety_check",
    {
      description:
        "Full safety analysis for any Solana SPL token. Returns mint/freeze authority status, top holder concentration, liquidity depth and LP lock status, sell-side honeypot detection with tax estimation, metadata mutability, token age, Token-2022 extension risks (transfer fees, permanent delegate), and a composite risk score 0-100. Direct on-chain analysis via RPC — no third-party security APIs, no opaque ML. Use before buying, swapping, or providing liquidity.",
      inputSchema: {
        mint_address: z
          .string()
          .describe("Solana token mint address in base58 format"),
      },
    },
    async ({ mint_address }) => {
      validateMint(mint_address);
      const { result } = await checkToken(mint_address);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "solana_token_batch_check",
    {
      description:
        "Check up to 10 Solana tokens at once. Returns full safety analysis for each token — mint/freeze authority, top holders, liquidity, honeypot detection, metadata, token age, Token-2022 extensions, and risk score. Use for portfolio screening, watchlist evaluation, or comparing multiple tokens.",
      inputSchema: {
        mint_addresses: z
          .string()
          .describe(
            "Comma-separated Solana token mint addresses in base58 format (max 10)",
          ),
      },
    },
    async ({ mint_addresses }) => {
      const mints = parseMintList(mint_addresses, 10);
      const settled = await Promise.allSettled(mints.map((m) => checkToken(m)));

      const results: unknown[] = [];
      const errors: { mint: string; error: string }[] = [];
      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        if (outcome.status === "fulfilled") {
          results.push(outcome.value.result);
        } else {
          const err = outcome.reason;
          errors.push({
            mint: mints[i],
            error: err instanceof ApiError ? err.message : "Analysis failed",
          });
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              checked_at: new Date().toISOString(),
              token_count: mints.length,
              results,
              errors,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "solana_token_portfolio_monitor",
    {
      description:
        "Monitor up to 10 Solana tokens at once. Returns current safety state for each token plus delta detection — what changed since the last check (authority changes, holder concentration shifts, liquidity movements, risk score changes). Generates severity-ranked alerts for critical changes like authority activations or liquidity removals. Use for portfolio surveillance and automated risk alerts.",
      inputSchema: {
        mint_addresses: z
          .string()
          .describe(
            "Comma-separated Solana token mint addresses in base58 format (max 10)",
          ),
      },
    },
    async ({ mint_addresses }) => {
      const mints = parseMintList(mint_addresses, 10);
      const response = await monitorTokens(mints);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(response) }],
      };
    },
  );

  return server;
}
