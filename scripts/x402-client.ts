#!/usr/bin/env tsx
/**
 * x402 test client — sends a paid request to the TokenSafe API.
 *
 * Usage:
 *   SVM_PRIVATE_KEY=<base58-keypair> npm run test:x402
 *   SVM_PRIVATE_KEY=<base58-keypair> SMOKE_URL=https://deployed.url npm run test:x402
 *
 * SVM_PRIVATE_KEY is a base58-encoded 64-byte Solana keypair.
 * See DEPLOY.md §4 for wallet setup and funding instructions.
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
  console.error("See DEPLOY.md §4 for setup instructions.");
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
const url = `${BASE}/v1/check?mint=${MINT}`;

console.log(`→ ${url}`);
const res = await paidFetch(url);

console.log(`← ${res.status} ${res.statusText}`);
console.log(`   X-Cache: ${res.headers.get("x-cache") ?? "(none)"}`);
console.log(
  `   X-Response-Time: ${res.headers.get("x-response-time") ?? "(none)"}`,
);

const receipt = res.headers.get("payment-response");
if (receipt) {
  console.log(`   Payment receipt: ${receipt.slice(0, 80)}...`);
}

const body = await res.json();
console.log(JSON.stringify(body, null, 2));

process.exit(res.ok ? 0 : 1);
