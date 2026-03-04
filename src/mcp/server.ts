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
        "Quick safety screening for any Solana SPL token. Returns: risk score (0-100), risk level (LOW/MODERATE/HIGH/CRITICAL/EXTREME), human-readable summary, token name/symbol, whether authorities are renounced, liquidity rating (DEEP/MODERATE/SHALLOW/NONE), top-10 holder concentration percentage, honeypot status (can_sell), token age, Token-2022 extension risks, and degradation status. This is a FREE lite check — for full details (individual authority addresses, holder breakdown with addresses, LP lock status and locker identity, honeypot sell tax, field-level change detection), use the x402 paid endpoint at GET /v1/check?mint=<address> ($0.008 USDC per request). If degraded=true, some checks failed (see degraded_checks array). The risk_score includes uncertainty penalties for missing data — it may overestimate risk.",
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
