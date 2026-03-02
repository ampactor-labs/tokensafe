import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkTokenLite } from "../analysis/token-checker.js";
import { validateMint } from "../utils/validation.js";

async function handleToolCall(
  mintAddress: string,
  baseUrl: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    validateMint(mintAddress);
    const { result } = await checkTokenLite(mintAddress, baseUrl);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: (err as Error).message || "Unknown error",
          }),
        },
      ],
      // @ts-expect-error -- MCP SDK accepts isError on tool results
      isError: true,
    };
  }
}

export function createMcpServer(baseUrl: string = ""): McpServer {
  const server = new McpServer({
    name: "tokensafe",
    version: "1.0.0",
    description:
      "Solana token safety scanner. Risk score 0-100 from pure on-chain analysis — mint/freeze authority, holder concentration, liquidity, LP locks, honeypot detection, Token-2022 extensions. Free lite check or $0.008 USDC full report via x402.",
    websiteUrl: "https://github.com/ampactor-labs/tokensafe",
    icons: baseUrl
      ? [
          {
            src: `${baseUrl}/icon.svg`,
            mimeType: "image/svg+xml",
            sizes: ["any"],
          },
        ]
      : [],
  });

  server.registerTool(
    "solana_token_safety_check",
    {
      title: "Solana Token Safety Check",
      description:
        "Free safety check for any Solana SPL token. Returns risk score (0-100), risk level, summary, name, symbol, Token-2022 detection, and risky extension flag. Full report with authority addresses, holder breakdown, LP lock status, honeypot details, and change detection available via x402 payment ($0.008 USDC) at GET /v1/check?mint=<address>.",
      inputSchema: {
        mint_address: z
          .string()
          .describe("Solana token mint address in base58 format"),
      },
      annotations: {
        title: "Solana Token Safety Check",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ mint_address }) => handleToolCall(mint_address, baseUrl),
  );

  return server;
}
