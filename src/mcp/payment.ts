import type { Request, Response } from "express";
import type { PaymentRequired } from "@x402/core/types";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { resourceServer } from "../x402/middleware.js";
import { config } from "../config.js";
import { catalog, buildAccepts, mcpPaidTool } from "../discovery/catalog.js";
import { checkToken } from "../analysis/token-checker.js";
import { validateMint } from "../utils/validation.js";
import { ApiError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { tokenChecksTotal } from "../utils/metrics.js";

/**
 * x402-over-MCP gate for the paid full-check tool.
 *
 * One POST /mcp request carries both free and paid tool calls, so the
 * route-keyed paymentMiddleware can't price it — we gate at the JSON-RPC
 * layer instead. The flow mirrors the REST x402 path and is compatible with
 * x402-enabled MCP clients (withPayment), which intercept an HTTP 402:
 *
 *   no/invalid payment → HTTP 402 + PAYMENT-REQUIRED challenge
 *   valid payment      → verify → run full check → settle → 200 + receipt
 *
 * Settlement happens only after a successful check, so a failed analysis is
 * never charged. Fail-closed: any verify error returns a 402, never the report.
 */

const checkEntry = catalog.find((e) => e.path === mcpPaidTool.pricePath);

interface JsonRpcToolCall {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

/** True when the body is a tools/call for the paid full-check tool. (Pure —
 * the PAID_MCP_TOOL_ENABLED flag is checked by the route before calling this.) */
export function isPaidMcpToolCall(body: unknown): boolean {
  const b = body as JsonRpcToolCall | null | undefined;
  return b?.method === "tools/call" && b?.params?.name === mcpPaidTool.toolName;
}

let initPromise: Promise<void> | null = null;
function ensureInitialized(): Promise<void> {
  if (!initPromise) initPromise = resourceServer.initialize();
  return initPromise;
}

function paymentHeader(req: Request): string | undefined {
  return (req.get("payment-signature") || req.get("x-payment")) ?? undefined;
}

function send402(res: Response, challenge: PaymentRequired): void {
  res.status(402);
  res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(challenge));
  res.json(challenge);
}

export async function handlePaidMcpToolCall(
  req: Request,
  res: Response,
): Promise<void> {
  if (!checkEntry) throw new Error("paid MCP tool: missing price catalog entry");

  const body = req.body as JsonRpcToolCall;
  const id = body?.id ?? null;
  const baseUrl =
    config.publicBaseUrl.replace(/\/+$/, "") ||
    `${req.protocol}://${req.get("host")}`;
  const resourceInfo = {
    url: `${baseUrl}/mcp`,
    description: mcpPaidTool.description,
    mimeType: "application/json",
  };

  res.setHeader("Access-Control-Allow-Origin", "*");

  // Build the canonical challenge (scheme-enriched, e.g. SVM feePayer). Used
  // both as the 402 we return and as the requirements we verify/settle against.
  await ensureInitialized();
  const challenge = await resourceServer.createPaymentRequiredResponse(
    buildAccepts(checkEntry),
    resourceInfo,
  );
  const requirements = challenge.accepts[0];

  const header = paymentHeader(req);
  if (!header) return send402(res, challenge);

  let payload;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    return send402(res, challenge);
  }

  let verification;
  try {
    verification = await resourceServer.verifyPayment(payload, requirements);
  } catch (err) {
    logger.error({ err }, "MCP payment verification threw");
    return send402(res, challenge);
  }
  if (!verification.isValid) return send402(res, challenge);

  // Payment authorized — run the full check. Do NOT settle if it fails.
  const args = body?.params?.arguments ?? {};
  const mint = (args.mint_address ?? args.mint) as string | undefined;
  try {
    if (!mint) {
      throw new ApiError("MISSING_REQUIRED_PARAM", "Missing mint_address");
    }
    validateMint(mint);
    const { result } = await checkToken(mint);
    tokenChecksTotal.labels("mcp_paid").inc();

    // Settle after a successful analysis (best-effort; report already produced).
    try {
      const settle = await resourceServer.settlePayment(payload, requirements);
      if (settle.success) {
        res.setHeader("PAYMENT-RESPONSE", encodePaymentResponseHeader(settle));
      } else {
        logger.warn(
          { reason: settle.errorReason },
          "MCP settle failed after delivery",
        );
      }
    } catch (err) {
      logger.error({ err }, "MCP settle threw after delivery");
    }

    res.json({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(result) }] },
    });
  } catch (err) {
    // Analysis failed → return the error WITHOUT settling (no charge).
    res.json({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: err instanceof Error ? err.message : "Unknown error",
            }),
          },
        ],
        isError: true,
      },
    });
  }
}
