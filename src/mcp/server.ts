import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PublicKey } from "@solana/web3.js";
import { checkToken, checkTokenLite } from "../analysis/token-checker.js";

function validateMint(address: string): void {
  try {
    new PublicKey(address);
  } catch {
    throw new Error(`Invalid Solana mint address: ${address}`);
  }
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

  return server;
}
