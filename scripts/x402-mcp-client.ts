#!/usr/bin/env tsx
/**
 * x402-over-MCP test client — calls the PAID full-check MCP tool and pays.
 *
 * Use this to verify a real settlement before enabling PAID_MCP_TOOL_ENABLED
 * in production. Point it at a devnet/testnet deployment first.
 *
 * Usage:
 *   SVM_PRIVATE_KEY=<base58-keypair> SMOKE_URL=https://deployed.url npm run test:x402-mcp
 *
 * The target must have PAID_MCP_TOOL_ENABLED=true. SVM_PRIVATE_KEY is a
 * base58-encoded 64-byte Solana keypair (see DEPLOY.md §4).
 */

import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

const BASE = process.env.SMOKE_URL ?? "http://localhost:3000";
const MINT = process.argv[2] ?? "So11111111111111111111111111111111111111112";

if (!process.env.SVM_PRIVATE_KEY) {
  console.error("SVM_PRIVATE_KEY is required (base58-encoded 64-byte keypair)");
  process.exit(1);
}

const keypairBytes = base58.decode(process.env.SVM_PRIVATE_KEY);
if (keypairBytes.length !== 64) {
  console.error(`Expected 64-byte keypair, got ${keypairBytes.length} bytes`);
  process.exit(1);
}

const keypair = await createKeyPairSignerFromBytes(keypairBytes);
const signer = toClientSvmSigner(keypair);

const client = new x402Client();
registerExactSvmScheme(client, { signer });
const paidFetch = wrapFetchWithPayment(fetch, client);

const rpcBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "solana_token_safety_check_full",
    arguments: { mint_address: MINT },
  },
};

console.log(`→ POST ${BASE}/mcp  (tool: solana_token_safety_check_full, mint: ${MINT})`);
const res = await paidFetch(`${BASE}/mcp`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  },
  body: JSON.stringify(rpcBody),
});

console.log(`← ${res.status} ${res.statusText}`);
const receipt = res.headers.get("payment-response");
console.log(`   Payment receipt: ${receipt ? receipt.slice(0, 80) + "..." : "(none)"}`);

const body = await res.json();
console.log(JSON.stringify(body, null, 2));

const ok =
  res.ok && !!receipt && body?.result?.content?.[0]?.text?.includes("risk_score");
console.log(ok ? "\n✅ Paid MCP tool settled and returned a full report." : "\n❌ Paid MCP flow did not complete.");
process.exit(ok ? 0 : 1);
