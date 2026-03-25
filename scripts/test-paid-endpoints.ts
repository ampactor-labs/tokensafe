#!/usr/bin/env tsx
/**
 * Tests all paid endpoints with real x402 payments.
 * SVM_PRIVATE_KEY=<base58-keypair> SMOKE_URL=<url> npx tsx scripts/test-paid-endpoints.ts
 */

import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

const BASE = process.env.SMOKE_URL ?? "http://localhost:3000";

if (!process.env.SVM_PRIVATE_KEY) {
  console.error("SVM_PRIVATE_KEY required");
  process.exit(1);
}

const keypair = await createKeyPairSignerFromBytes(
  base58.decode(process.env.SVM_PRIVATE_KEY),
);
const client = new x402Client();
registerExactSvmScheme(client, { signer: toClientSvmSigner(keypair) });
const pf = wrapFetchWithPayment(fetch, client);

let failures = 0;

// --- /v1/check (3 tokens) ---
const checkMints = [
  "So11111111111111111111111111111111111111112", // wSOL
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", // JUP
  "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC", // ai16z
];

console.log("=== /v1/check ($0.008 each) ===\n");
for (const mint of checkMints) {
  const url = `${BASE}/v1/check?mint=${mint}`;
  console.log(`→ ${url}`);
  try {
    const res = await pf(url);
    console.log(
      `← ${res.status} ${res.statusText}  (${res.headers.get("x-response-time")})`,
    );
    const body = (await res.json()) as any;
    console.log(
      `  name="${body.name}" symbol="${body.symbol}" score=${body.risk_score} level=${body.risk_level}`,
    );
    console.log(
      `  degraded=${body.degraded} degraded_checks=[${body.degraded_checks?.join(",")}]`,
    );
    console.log(
      `  age_hours=${body.checks?.token_age_hours} created_at=${body.checks?.created_at}`,
    );
    console.log(`  summary: ${body.summary}`);
    if (!res.ok) failures++;
  } catch (err: any) {
    console.log(`  ERROR: ${err.message}`);
    failures++;
  }
  console.log();
}

console.log();
console.log(failures === 0 ? "All endpoints OK" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
