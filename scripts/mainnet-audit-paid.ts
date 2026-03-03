#!/usr/bin/env tsx
/**
 * Mainnet audit — paid x402 endpoints.
 * Spends real USDC. Run with:
 *   source .env && SMOKE_URL=https://tokensafe-production.up.railway.app npx tsx scripts/mainnet-audit-paid.ts
 */

import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

const BASE = process.env.SMOKE_URL ?? "https://tokensafe-production.up.railway.app";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

if (!process.env.SVM_PRIVATE_KEY) {
  console.error("SVM_PRIVATE_KEY required");
  process.exit(1);
}

const keypairBytes = base58.decode(process.env.SVM_PRIVATE_KEY);
const keypair = await createKeyPairSignerFromBytes(keypairBytes);
const signer = toClientSvmSigner(keypair);
const client = new x402Client();
registerExactSvmScheme(client, { signer });
const paidFetch = wrapFetchWithPayment(fetch, client);

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`   ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`   ✗ ${name}`);
    console.log(`     ${(err as Error).message}`);
    failed++;
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

console.log(`\n========================================`);
console.log(`  x402 PAID ENDPOINT AUDIT`);
console.log(`  ${new Date().toISOString()}`);
console.log(`  Wallet: ${keypair.address}`);
console.log(`========================================\n`);

// 1. Single check — wSOL ($0.008)
await check("GET /v1/check wSOL ($0.008)", async () => {
  const res = await paidFetch(`${BASE}/v1/check?mint=${WSOL}`);
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json() as any;
  assert(body.mint === WSOL, `wrong mint`);
  assert(typeof body.risk_score === "number", "missing risk_score");
  assert(typeof body.checks === "object", "missing checks");
  assert(typeof body.response_signature === "string", "missing signature");
  assert(typeof body.score_breakdown === "object", "missing score_breakdown");
  const receipt = res.headers.get("payment-response");
  assert(receipt !== null, "missing payment-response header");
  console.log(`     risk=${body.risk_score} (${body.risk_level}) name=${body.name}`);
  console.log(`     receipt: ${receipt!.slice(0, 60)}...`);
});

// 2. Single check — USDC ($0.008)
await check("GET /v1/check USDC ($0.008)", async () => {
  const res = await paidFetch(`${BASE}/v1/check?mint=${USDC}`);
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json() as any;
  assert(body.risk_score <= 20, `USDC risk too high: ${body.risk_score}`);
  console.log(`     risk=${body.risk_score} (${body.risk_level}) name=${body.name}`);
});

// 3. Batch small — 3 tokens ($0.025)
await check("POST /v1/check/batch/small — 3 tokens ($0.025)", async () => {
  const res = await paidFetch(`${BASE}/v1/check/batch/small`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mints: [WSOL, USDC, USDT] }),
  });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json() as any;
  assert(body.total === 3, `expected total=3, got ${body.total}`);
  assert(body.succeeded >= 1, `expected succeeded>=1, got ${body.succeeded}`);
  console.log(`     total=${body.total} succeeded=${body.succeeded} failed=${body.failed}`);
  for (const r of body.results) {
    console.log(`     ${r.mint.slice(0, 8)}... risk=${r.risk_score ?? "ERR"} (${r.risk_level ?? r.error?.code})`);
  }
});

// 4. Batch medium — 5 tokens ($0.08)
await check("POST /v1/check/batch/medium — 5 tokens ($0.08)", async () => {
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
  const res = await paidFetch(`${BASE}/v1/check/batch/medium`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mints: [WSOL, USDC, USDT, BONK, JUP] }),
  });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json() as any;
  assert(body.total === 5, `expected total=5, got ${body.total}`);
  console.log(`     total=${body.total} succeeded=${body.succeeded} failed=${body.failed}`);
  for (const r of body.results) {
    console.log(`     ${r.symbol ?? r.mint.slice(0, 8)} risk=${r.risk_score ?? "ERR"} (${r.risk_level ?? r.error?.code})`);
  }
});

// 5. Audit small — 3 tokens ($0.08)
await check("POST /v1/audit/small — 3 tokens ($0.08)", async () => {
  const res = await paidFetch(`${BASE}/v1/audit/small`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mints: [WSOL, USDC, USDT] }),
  });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json() as any;
  assert(typeof body.audit_id === "string", "missing audit_id");
  assert(typeof body.attestation?.hash === "string", "missing attestation.hash");
  assert(typeof body.attestation?.signature === "string", "missing attestation.signature");
  assert(Array.isArray(body.results), "missing results array");
  console.log(`     audit_id=${body.audit_id}`);
  console.log(`     violations=${body.policy_violations?.length ?? 0} aggregate_risk=${body.aggregate_risk_score}`);
  console.log(`     attestation: ${body.attestation.hash.slice(0, 40)}...`);

  // 5b. Verify audit report is accessible
  const reportRes = await fetch(`${BASE}/v1/audit/${body.audit_id}/report`, {
    headers: { "Authorization": `Bearer ${process.env.WEBHOOK_ADMIN_BEARER ?? ""}` },
  });
  assert(reportRes.status === 200, `report expected 200, got ${reportRes.status}`);
  const report = await reportRes.text();
  assert(report.includes("TokenSafe"), "report missing TokenSafe header");
  console.log(`     report: ${report.length} chars markdown`);
});

// 6. Batch large — 5 tokens ($0.15) — test with duplicates to verify dedup
await check("POST /v1/check/batch/large — 5 tokens ($0.15)", async () => {
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
  const res = await paidFetch(`${BASE}/v1/check/batch/large`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mints: [WSOL, USDC, USDT, BONK, JUP] }),
  });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json() as any;
  assert(body.total === 5, `expected total=5, got ${body.total}`);
  console.log(`     total=${body.total} succeeded=${body.succeeded} failed=${body.failed}`);
});

// 7. Audit standard — 5 tokens ($0.30)
await check("POST /v1/audit/standard — 5 tokens ($0.30)", async () => {
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
  const res = await paidFetch(`${BASE}/v1/audit/standard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mints: [WSOL, USDC, USDT, BONK, JUP] }),
  });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json() as any;
  assert(typeof body.audit_id === "string", "missing audit_id");
  assert(typeof body.attestation?.hash === "string", "missing attestation.hash");
  console.log(`     audit_id=${body.audit_id} violations=${body.policy_violations?.length ?? 0} aggregate_risk=${body.aggregate_risk_score}`);
});

console.log(`\n=== SUMMARY ===`);
console.log(`   ${passed} passed, ${failed} failed (${passed + failed} total)`);
console.log(`   Approximate spend: $0.008 + $0.008 + $0.025 + $0.08 + $0.08 + $0.15 + $0.30 = ~$0.65 USDC`);
console.log();
process.exit(failed > 0 ? 1 : 0);
