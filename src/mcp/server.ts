import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PublicKey } from "@solana/web3.js";
import { checkTokenLite } from "../analysis/token-checker.js";

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
        "Preview safety analysis for any Solana SPL token. Returns risk score (0-100), risk level, and summary. Full report with authority addresses, holder breakdown, LP lock status, honeypot details, and change detection requires x402 payment ($0.008 USDC) via the REST API at GET /v1/check?mint=<address>.",
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

  return server;
}
