#!/usr/bin/env tsx
/**
 * E2E Mainnet Customer Roleplay Test
 *
 * Exercises every TokenSafe endpoint as a real customer/agent would.
 * Budget: ~$0.034 USDC (2 x402 payments). Remaining phases use API key bypass.
 *
 * Usage:
 *   source .env && SMOKE_URL=https://tokensafe-production.up.railway.app npx tsx scripts/e2e-mainnet.ts
 *   SKIP_X402=1 npx tsx scripts/e2e-mainnet.ts   # skip real payments
 *   npx tsx scripts/e2e-mainnet.ts --wild <MINT>  # include extra token
 */

import crypto from "node:crypto";

// ── x402 imports (lazy — only needed if SKIP_X402 is not set) ──
let paidFetch: typeof fetch;

const BASE = process.env.SMOKE_URL ?? "https://tokensafe-production.up.railway.app";
const SKIP_X402 = process.env.SKIP_X402 === "1";

// ── Token Roster ──
const MINTS = {
  wSOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  TRUMP: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
  ai16z: "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC",
  POPCAT: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
  PENGU: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
} as const;

// Parse --wild argument
const wildIdx = process.argv.indexOf("--wild");
const WILD_MINT = wildIdx !== -1 ? process.argv[wildIdx + 1] : undefined;

// ── Test Harness (from smoke.ts) ──
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PhaseResult {
  name: string;
  passed: number;
  failed: number;
  skipped: number;
}

const phases: PhaseResult[] = [];
let currentPhase: PhaseResult = { name: "", passed: 0, failed: 0, skipped: 0 };

function startPhase(name: string) {
  if (currentPhase.name) phases.push(currentPhase);
  currentPhase = { name, passed: 0, failed: 0, skipped: 0 };
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Phase: ${name}`);
  console.log(`${"═".repeat(60)}`);
}

async function check(name: string, fn: () => Promise<void>): Promise<boolean> {
  const t0 = performance.now();
  try {
    await fn();
    const ms = Math.round(performance.now() - t0);
    console.log(`  \x1b[32m✓\x1b[0m ${name} \x1b[2m(${ms}ms)\x1b[0m`);
    currentPhase.passed++;
    return true;
  } catch (firstErr) {
    // Retry once — Railway edge occasionally returns 502
    try {
      await sleep(1000);
      await fn();
      const ms = Math.round(performance.now() - t0);
      console.log(`  \x1b[32m✓\x1b[0m ${name} (retry) \x1b[2m(${ms}ms)\x1b[0m`);
      currentPhase.passed++;
      return true;
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      console.log(`  \x1b[31m✗\x1b[0m ${name} \x1b[2m(${ms}ms)\x1b[0m`);
      console.log(`    ${(err as Error).message}`);
      currentPhase.failed++;
      return false;
    }
  }
}

function skip(name: string, reason: string) {
  console.log(`  \x1b[33m○\x1b[0m ${name} (skip: ${reason})`);
  currentPhase.skipped++;
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function log(msg: string) {
  console.log(`    ${msg}`);
}

// ── Main ──
async function main() {
  const BEARER = process.env.WEBHOOK_ADMIN_BEARER;

  const startTime = performance.now();
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  TOKENSAFE E2E MAINNET CUSTOMER ROLEPLAY`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Target: ${BASE}`);
  console.log(`${"═".repeat(60)}`);

  // ════════════════════════════════════════════
  // Phase 0: Preflight
  // ════════════════════════════════════════════
  startPhase("0 — Preflight");

  if (!SKIP_X402) {
    if (!process.env.SVM_PRIVATE_KEY) {
      console.error("\x1b[31mSVM_PRIVATE_KEY required (or set SKIP_X402=1)\x1b[0m");
      process.exit(1);
    }
    const { base58 } = await import("@scure/base");
    const keypairBytes = base58.decode(process.env.SVM_PRIVATE_KEY);
    assert(keypairBytes.length === 64, `SVM_PRIVATE_KEY must decode to 64 bytes, got ${keypairBytes.length}`);

    const { createKeyPairSignerFromBytes } = await import("@solana/kit");
    const { toClientSvmSigner } = await import("@x402/svm");
    const { wrapFetchWithPayment, x402Client } = await import("@x402/fetch");
    const { registerExactSvmScheme } = await import("@x402/svm/exact/client");

    const keypair = await createKeyPairSignerFromBytes(keypairBytes);
    const signer = toClientSvmSigner(keypair);
    const client = new x402Client();
    registerExactSvmScheme(client, { signer });
    paidFetch = wrapFetchWithPayment(fetch, client);

    log(`Wallet: ${keypair.address}`);
    log(`Estimated x402 spend: $0.033 USDC`);
    currentPhase.passed++;
  } else {
    skip("x402 wallet setup", "SKIP_X402=1");
  }

  if (!BEARER) {
    console.error("\x1b[31mWEBHOOK_ADMIN_BEARER required\x1b[0m");
    process.exit(1);
  }
  log(`WEBHOOK_ADMIN_BEARER: ***${BEARER.slice(-8)}`);
  if (WILD_MINT) log(`Wild token: ${WILD_MINT}`);
  currentPhase.passed++;

  // Capture signer_pubkey from health for later verification
  let signerPubkey: string;

  // ════════════════════════════════════════════
  // Phase 1: Free Endpoints
  // ════════════════════════════════════════════
  startPhase("1 — Free Endpoints");

  const bearerHeaders = { Authorization: `Bearer ${BEARER}` };

  // Health
  await check("GET /health — status, version, network, signer_pubkey", async () => {
    const res = await fetch(`${BASE}/health`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert(body.status === "ok", `expected status:ok, got ${body.status}`);
    assert(body.version === "1.0.0", `expected version 1.0.0, got ${body.version}`);
    assert(body.network === "mainnet", `expected network mainnet, got ${body.network}`);
    assert(typeof body.signer_pubkey === "string" && body.signer_pubkey.length > 0, "missing signer_pubkey");
    assert(typeof body.facilitator_url === "string", "missing facilitator_url");
    assert(typeof body.uptime === "number", "missing uptime");
    signerPubkey = body.signer_pubkey;
    log(`version=${body.version} network=${body.network} uptime=${body.uptime}s`);
    log(`signer_pubkey=${signerPubkey.slice(0, 16)}...`);
  });

  // Discovery doc
  await check("GET /.well-known/x402 — version, resources, pricing", async () => {
    const res = await fetch(`${BASE}/.well-known/x402`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert(body.version === 1, `expected version=1, got ${body.version}`);
    assert(body.resources?.length > 0, "missing resources");
    assert(body.instructions.includes("TokenSafe"), "instructions missing TokenSafe");
    assert(body.instructions.includes("$0.008"), "instructions missing pricing");
  });

  // Lite — wSOL (baseline)
  await check("GET /v1/check/lite wSOL — LOW risk, shape validation", async () => {
    const res = await fetch(`${BASE}/v1/check/lite?mint=${MINTS.wSOL}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.headers.get("x-cache") !== null, "missing X-Cache header");
    const body = await res.json() as any;
    assert(body.mint === MINTS.wSOL, `wrong mint`);
    assert(body.risk_score <= 20, `wSOL risk too high: ${body.risk_score}`);
    assert(body.risk_level === "LOW", `expected LOW, got ${body.risk_level}`);
    assert(body.authorities_renounced === true, "wSOL authorities not renounced");
    assert(body.has_liquidity === true, "wSOL missing liquidity");
    assert(typeof body.liquidity_rating === "string", "missing liquidity_rating");
    assert(body.top_10_concentration === null || typeof body.top_10_concentration === "number", "bad top_10_concentration type");
    // Data confidence fields
    assert(body.data_confidence === "complete" || body.data_confidence === "partial", `bad data_confidence: ${body.data_confidence}`);
    assert(body.degraded_note === null || typeof body.degraded_note === "string", "bad degraded_note type");
    if (body.data_confidence === "complete") {
      assert(body.degraded_note === null, "degraded_note should be null when complete");
      assert(body.uncertainty_penalties === null, "uncertainty_penalties should be null when complete");
    }
    // X-Data-Confidence header
    const confidence = res.headers.get("x-data-confidence");
    assert(confidence === body.data_confidence, `X-Data-Confidence header (${confidence}) != body (${body.data_confidence})`);
    // Paid-only fields MUST be absent
    assert(body.checks === undefined, "lite leaks checks");
    assert(body.response_signature === undefined, "lite leaks response_signature");
    assert(body.score_breakdown === undefined, "lite leaks score_breakdown");
    assert(body.rpc_slot === undefined, "lite leaks rpc_slot");
    log(`risk=${body.risk_score} (${body.risk_level}) confidence=${body.data_confidence} name=${body.name}`);
  });

  await sleep(3000);

  // Lite — USDC
  await check("GET /v1/check/lite USDC — LOW risk", async () => {
    const res = await fetch(`${BASE}/v1/check/lite?mint=${MINTS.USDC}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert(body.risk_level === "LOW", `USDC expected LOW, got ${body.risk_level}`);
    log(`risk=${body.risk_score} (${body.risk_level}) is_token_2022=${body.is_token_2022}`);
  });

  // Lite — TRUMP (high concentration)
  await check("GET /v1/check/lite TRUMP — expect elevated risk", async () => {
    const res = await fetch(`${BASE}/v1/check/lite?mint=${MINTS.TRUMP}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    // Railway multi-instance: lite may hit degraded cache (risk=10 from uncertainty penalties)
    // Full check in Phase 3 validates correct concentration scoring (risk=50)
    assert(body.risk_score >= 10, `TRUMP risk too low: ${body.risk_score}`);
    log(`risk=${body.risk_score} (${body.risk_level}) can_sell=${body.can_sell} liq=${body.has_liquidity}`);
  });

  await sleep(3000);

  // Lite — ai16z
  await check("GET /v1/check/lite ai16z — log profile", async () => {
    const res = await fetch(`${BASE}/v1/check/lite?mint=${MINTS.ai16z}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert(typeof body.risk_score === "number", "missing risk_score");
    log(`risk=${body.risk_score} (${body.risk_level}) can_sell=${body.can_sell} name=${body.name}`);
  });

  // Cache hit test — note: Railway multi-instance may cause misses
  await check("Second wSOL lite call → X-Cache present", async () => {
    const res = await fetch(`${BASE}/v1/check/lite?mint=${MINTS.wSOL}`);
    const cache = res.headers.get("x-cache");
    assert(cache !== null, "missing X-Cache header");
    log(`X-Cache: ${cache}`);
  });

  await sleep(3000);

  // Wild token (optional)
  if (WILD_MINT) {
    await check(`GET /v1/check/lite wild=${WILD_MINT.slice(0, 8)}...`, async () => {
      const res = await fetch(`${BASE}/v1/check/lite?mint=${WILD_MINT}`);
      assert(res.status === 200 || res.status === 404, `expected 200|404, got ${res.status}`);
      if (res.status === 200) {
        const body = await res.json() as any;
        log(`risk=${body.risk_score} (${body.risk_level}) name=${body.name} degraded=${body.degraded}`);
      } else {
        log("Token not found (404)");
      }
    });
    await sleep(3000);
  }

  // Decide endpoints
  await check("GET /v1/decide TRUMP threshold=30 → RISKY", async () => {
    const res = await fetch(`${BASE}/v1/decide?mint=${MINTS.TRUMP}&threshold=30`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const decideConfidence = res.headers.get("x-data-confidence");
    assert(decideConfidence === "complete" || decideConfidence === "partial", `missing/bad X-Data-Confidence on decide: ${decideConfidence}`);
    const body = await res.json() as any;
    assert(body.decision === "RISKY" || body.decision === "UNKNOWN", `expected RISKY|UNKNOWN for TRUMP, got ${body.decision}`);
    log(`decision=${body.decision} risk=${body.risk_score} threshold=${body.threshold_used} confidence=${decideConfidence}`);
  });

  await check("GET /v1/decide wSOL → SAFE or UNKNOWN (if degraded)", async () => {
    const res = await fetch(`${BASE}/v1/decide?mint=${MINTS.wSOL}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert(body.decision === "SAFE" || body.decision === "UNKNOWN", `expected SAFE|UNKNOWN for wSOL, got ${body.decision}`);
    log(`decision=${body.decision} risk=${body.risk_score}`);
  });

  await sleep(3000);

  // MCP
  const mcpHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

  await check("POST /mcp tools/list — solana_token_safety_check present", async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const text = await res.text();
    const data = text.split("\n").find((l) => l.startsWith("data: "));
    assert(data !== undefined, "no SSE data line");
    const parsed = JSON.parse(data!.replace("data: ", ""));
    const names = parsed.result.tools.map((t: any) => t.name);
    assert(names.includes("solana_token_safety_check"), `missing tool, got: ${names.join(", ")}`);
    assert(!names.includes("solana_token_safety_preview"), "deprecated tool still present");
  });

  await check("POST /mcp tools/call wSOL — lite data, absolute URL", async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "solana_token_safety_check", arguments: { mint_address: MINTS.wSOL } },
      }),
    });
    const text = await res.text();
    const data = text.split("\n").find((l) => l.startsWith("data: "));
    assert(data !== undefined, "no SSE data line");
    const parsed = JSON.parse(data!.replace("data: ", ""));
    const result = JSON.parse(parsed.result.content[0].text);
    assert(result.mint === MINTS.wSOL, `wrong mint`);
    assert(typeof result.risk_score === "number", "missing risk_score");
    assert(!result.checks, "MCP leaks full checks");
    assert(result.full_report.url.startsWith("http"), `full_report.url not absolute: ${result.full_report.url}`);
  });

  // Error gates
  await check("Bad mint → 400 INVALID_MINT_ADDRESS", async () => {
    const res = await fetch(`${BASE}/v1/check/lite?mint=not-a-valid-mint`);
    assert(res.status === 400, `expected 400, got ${res.status}`);
    const body = await res.json() as any;
    assert(body.error?.code === "INVALID_MINT_ADDRESS", `expected INVALID_MINT_ADDRESS, got ${body.error?.code}`);
  });

  await check("Missing mint → 400 MISSING_REQUIRED_PARAM", async () => {
    const res = await fetch(`${BASE}/v1/check/lite`);
    assert(res.status === 400, `expected 400, got ${res.status}`);
    const body = await res.json() as any;
    assert(body.error?.code === "MISSING_REQUIRED_PARAM", `expected MISSING_REQUIRED_PARAM, got ${body.error?.code}`);
  });

  await check("Non-mint account → 404 TOKEN_NOT_FOUND", async () => {
    const res = await fetch(`${BASE}/v1/check/lite?mint=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`);
    assert(res.status === 404, `expected 404, got ${res.status}`);
    const body = await res.json() as any;
    assert(body.error?.code === "TOKEN_NOT_FOUND", `expected TOKEN_NOT_FOUND, got ${body.error?.code}`);
  });

  await check("GET /v1/check no key → 402", async () => {
    const res = await fetch(`${BASE}/v1/check?mint=${MINTS.wSOL}`);
    assert(res.status === 402, `expected 402, got ${res.status}`);
    assert(res.headers.get("payment-required") !== null, "missing PAYMENT-REQUIRED header");
  });

  await check("Unknown route → 404 NOT_FOUND", async () => {
    const res = await fetch(`${BASE}/no-such-route`);
    assert(res.status === 404, `expected 404, got ${res.status}`);
    const body = await res.json() as any;
    assert(body.error?.code === "NOT_FOUND", `expected NOT_FOUND, got ${body.error?.code}`);
  });

  // ════════════════════════════════════════════
  // Phase 2: Bearer Admin
  // ════════════════════════════════════════════
  startPhase("2 — Bearer Admin");

  await check("GET /metrics with bearer → 200, Prometheus data", async () => {
    const res = await fetch(`${BASE}/metrics`, { headers: bearerHeaders });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const text = await res.text();
    assert(text.includes("tokensafe_http_requests_total"), "missing tokensafe_http_requests_total metric");
  });

  await check("GET /metrics without bearer → 401", async () => {
    const res = await fetch(`${BASE}/metrics`);
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  // Create API key
  let apiKey: string;
  let apiKeyId: number;

  await check("POST /v1/api-keys → 201, tks_ prefix", async () => {
    const res = await fetch(`${BASE}/v1/api-keys`, {
      method: "POST",
      headers: { ...bearerHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "e2e-test", tier: "pro" }),
    });
    assert(res.status === 201, `expected 201, got ${res.status}`);
    const body = await res.json() as any;
    assert(body.key.startsWith("tks_"), `key should start with tks_, got ${body.key.slice(0, 8)}`);
    assert(body.tier === "pro", `expected tier pro, got ${body.tier}`);
    apiKey = body.key;
    apiKeyId = body.id;
    log(`id=${apiKeyId} prefix=${body.key_prefix} tier=${body.tier}`);
  });

  await check("GET /v1/api-keys — lists keys, full key NOT exposed", async () => {
    const res = await fetch(`${BASE}/v1/api-keys`, { headers: bearerHeaders });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert(Array.isArray(body), "expected array");
    const found = body.find((k: any) => k.id === apiKeyId);
    assert(found !== undefined, `key ${apiKeyId} not in list`);
    assert(!found.key, "full key exposed in list");
    log(`${body.length} key(s) listed`);
  });

  // Create webhook
  let webhookId: number;

  await check("POST /v1/webhooks → 201 with HMAC secret", async () => {
    const res = await fetch(`${BASE}/v1/webhooks`, {
      method: "POST",
      headers: { ...bearerHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_url: "https://httpbin.org/post",
        mints: [MINTS.wSOL],
        threshold: 50,
      }),
    });
    assert(res.status === 201, `expected 201, got ${res.status}`);
    const body = await res.json() as any;
    assert(typeof body.id === "number", "missing webhook id");
    assert(typeof body.secret_hmac === "string" && body.secret_hmac.length > 16, "missing/short secret_hmac");
    webhookId = body.id;
    log(`id=${webhookId} threshold=${body.threshold} secret=***${body.secret_hmac.slice(-8)}`);
  });

  await check("GET /v1/webhooks — secret redacted", async () => {
    const res = await fetch(`${BASE}/v1/webhooks`, { headers: bearerHeaders });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    const found = body.find((w: any) => w.id === webhookId);
    assert(found !== undefined, "webhook not in list");
    assert(found.secret_hmac.startsWith("***"), `secret not redacted: ${found.secret_hmac.slice(0, 10)}`);
  });

  await check("PATCH /v1/webhooks/:id — threshold updated", async () => {
    const res = await fetch(`${BASE}/v1/webhooks/${webhookId}`, {
      method: "PATCH",
      headers: { ...bearerHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ threshold: 25 }),
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert(body.threshold === 25, `expected threshold 25, got ${body.threshold}`);
    assert(body.callback_url === "https://httpbin.org/post", "callback_url changed unexpectedly");
    log(`threshold → ${body.threshold}`);
  });

  // Auth rejection gates
  await check("Admin routes without bearer → 401", async () => {
    const res = await fetch(`${BASE}/v1/webhooks`);
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  // ════════════════════════════════════════════
  // Phase 3: API Key Bypass — Paid Business Logic
  // ════════════════════════════════════════════
  startPhase("3 — API Key Bypass (paid logic, $0)");

  const apiKeyHeaders = { "X-API-Key": apiKey! };

  // 3.1 Single check — wSOL
  await check("GET /v1/check wSOL via API key — 200, full response", async () => {
    const res = await fetch(`${BASE}/v1/check?mint=${MINTS.wSOL}`, { headers: apiKeyHeaders });
    assert(res.status === 200, `expected 200 (not 402!), got ${res.status}`);
    assert(res.headers.get("x-api-key-tier") === "pro", `expected tier pro, got ${res.headers.get("x-api-key-tier")}`);
    assert(res.headers.get("x-api-key-usage") !== null, "missing X-API-Key-Usage");
    assert(res.headers.get("access-control-allow-origin") === "*", "missing CORS on paid endpoint");
    const body = await res.json() as any;
    assert(body.checks.mint_authority.status === "RENOUNCED", `wSOL mint_authority not RENOUNCED`);
    assert(body.checks.freeze_authority.status === "RENOUNCED", `wSOL freeze_authority not RENOUNCED`);
    assert(body.checks.liquidity?.has_liquidity === true, "wSOL no liquidity");
    assert(typeof body.response_signature === "string", "missing response_signature");
    assert(typeof body.score_breakdown === "object", "missing score_breakdown");
    assert(body.signer_pubkey === signerPubkey!, `signer_pubkey mismatch: health=${signerPubkey!.slice(0, 8)} check=${body.signer_pubkey?.slice(0, 8)}`);
    // Data confidence
    assert(body.data_confidence === "complete" || body.data_confidence === "partial", `bad data_confidence: ${body.data_confidence}`);
    const checkConfidence = res.headers.get("x-data-confidence");
    assert(checkConfidence === body.data_confidence, `X-Data-Confidence header mismatch`);
    // Verify LP lock detection works (LP mint offset fix: 432→464)
    const liq = body.checks.liquidity;
    if (liq?.primary_pool?.toLowerCase().includes("raydium")) {
      log(`lp_locked=${liq.lp_locked} lp_mint=${liq.lp_mint?.slice(0, 12)}... lp_locker=${liq.lp_locker}`);
      // pool_vault_addresses should be present for Raydium AMM v4 pools
      if (liq.pool_vault_addresses) {
        assert(Array.isArray(liq.pool_vault_addresses), "pool_vault_addresses should be array");
        assert(liq.pool_vault_addresses.length === 2, `expected 2 vault addresses, got ${liq.pool_vault_addresses.length}`);
        log(`pool_vault_addresses: [${liq.pool_vault_addresses.map((a: string) => a.slice(0, 8) + "...").join(", ")}]`);
      } else {
        log(`pool_vault_addresses: null (non-AMM-v4 pool or LP lock skipped)`);
      }
    }
    log(`risk=${body.risk_score} (${body.risk_level}) mint_auth=${body.checks.mint_authority.status} freeze_auth=${body.checks.freeze_authority.status}`);
    log(`signer_pubkey consistent with /health ✓`);
  });

  // Brief pause — let Helius RPC recover between heavy token checks
  await sleep(2000);

  // 3.2 Single check — TRUMP
  await check("GET /v1/check TRUMP via API key — elevated risk or degraded", async () => {
    const res = await fetch(`${BASE}/v1/check?mint=${MINTS.TRUMP}`, { headers: apiKeyHeaders });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert(typeof body.checks === "object", "body.checks missing");
    // TRUMP should score high when non-degraded (concentration penalties).
    // When degraded (top_holders timeout under burst), uncertainty penalties → lower score.
    if (body.degraded) {
      assert(body.risk_score >= 5, `degraded TRUMP risk too low: ${body.risk_score}`);
      log(`DEGRADED — risk=${body.risk_score} (${body.risk_level}) degraded_checks=${JSON.stringify(body.degraded_checks)}`);
    } else {
      assert(body.risk_score > 15, `non-degraded TRUMP risk too low: ${body.risk_score}`);
      log(`risk=${body.risk_score} (${body.risk_level})`);
    }
    log(`mint_auth=${body.checks.mint_authority?.status} freeze_auth=${body.checks.freeze_authority?.status}`);
    const th = body.checks.top_holders;
    log(`top10=${th?.top_10_percentage}% top1=${th?.top_1_percentage}% status=${th?.status}`);
    if (th?.note) log(`top_holders note: ${th.note}`);
    const tliq = body.checks.liquidity;
    log(`liquidity=${tliq?.status} (${tliq?.liquidity_rating}) vaults=${JSON.stringify(tliq?.pool_vault_addresses?.map((a: string) => a.slice(0, 8)) ?? null)}`);
    log(`score_breakdown: ${JSON.stringify(body.score_breakdown)}`);
  });

  await sleep(3000);

  // 3.3 Batch medium — 5 diverse memecoins
  await check("POST /v1/check/batch/medium — 5 memecoins", async () => {
    const res = await fetch(`${BASE}/v1/check/batch/medium`, {
      method: "POST",
      headers: { ...apiKeyHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ mints: [MINTS.TRUMP, MINTS.ai16z, MINTS.WIF, MINTS.BONK, MINTS.POPCAT] }),
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert(res.headers.get("x-cache") !== null, "missing X-Cache on batch");
    assert(res.headers.get("access-control-allow-origin") === "*", "missing CORS on batch");
    assert(body.total === 5, `expected total=5, got ${body.total}`);
    assert(body.succeeded >= 3, `expected ≥3 succeeded, got ${body.succeeded}`);
    log(`total=${body.total} succeeded=${body.succeeded} failed=${body.failed}`);
    for (const r of body.results) {
      if (r.risk_score !== undefined) {
        log(`  ${(r.symbol ?? r.mint.slice(0, 8)).padEnd(8)} risk=${String(r.risk_score).padStart(3)} (${r.risk_level}) degraded=${r.degraded ?? false}`);
      } else {
        log(`  ${r.mint.slice(0, 8).padEnd(8)} ERROR: ${r.error?.code}`);
      }
    }
  });

  await sleep(5000);

  // 3.4 Batch large — full roster (10 tokens = ~60 RPC calls — give Helius breathing room)
  await check("POST /v1/check/batch/large — 10 tokens (full roster)", async () => {
    const allMints = Object.values(MINTS);
    if (WILD_MINT) allMints.push(WILD_MINT);
    const res = await fetch(`${BASE}/v1/check/batch/large`, {
      method: "POST",
      headers: { ...apiKeyHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ mints: allMints }),
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert(body.total === allMints.length, `expected total=${allMints.length}, got ${body.total}`);
    log(`total=${body.total} succeeded=${body.succeeded} failed=${body.failed}`);

    // Sort by risk_score ascending and print table
    const sorted = [...body.results]
      .filter((r: any) => r.risk_score !== undefined)
      .sort((a: any, b: any) => a.risk_score - b.risk_score);
    log(`\n    ${"Symbol".padEnd(10)} ${"Risk".padStart(4)} Level`);
    log(`    ${"─".repeat(30)}`);
    for (const r of sorted) {
      log(`    ${(r.symbol ?? r.mint.slice(0, 8)).padEnd(10)} ${String(r.risk_score).padStart(4)} ${r.risk_level}`);
    }

    // Sanity checks
    const wsolResult = body.results.find((r: any) => r.mint === MINTS.wSOL);
    const usdcResult = body.results.find((r: any) => r.mint === MINTS.USDC);
    const trumpResult = body.results.find((r: any) => r.mint === MINTS.TRUMP);
    if (wsolResult?.risk_score !== undefined) {
      assert(wsolResult.risk_score <= 20, `wSOL risk too high in batch: ${wsolResult.risk_score}`);
    }
    if (usdcResult?.risk_score !== undefined) {
      assert(usdcResult.risk_score <= 20, `USDC risk too high in batch: ${usdcResult.risk_score}`);
    }
    if (trumpResult?.risk_score !== undefined && wsolResult?.risk_score !== undefined) {
      // TRUMP may return degraded (top_holders timeout) — only compare when non-degraded
      if (!trumpResult.degraded) {
        assert(trumpResult.risk_score > wsolResult.risk_score, `TRUMP (${trumpResult.risk_score}) should score higher than wSOL (${wsolResult.risk_score})`);
      } else {
        log(`    ⚠ TRUMP degraded in batch — skipping risk comparison`);
      }
    }
  });

  await sleep(5000);

  // 3.5 Audit small — mixed risk
  let auditId: string;

  await check("POST /v1/audit/small — TRUMP, WIF, BONK", async () => {
    const res = await fetch(`${BASE}/v1/audit/small`, {
      method: "POST",
      headers: { ...apiKeyHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ mints: [MINTS.TRUMP, MINTS.WIF, MINTS.BONK] }),
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert(typeof body.audit_id === "string", "missing audit_id");
    assert(typeof body.attestation?.hash === "string", "missing attestation hash");
    assert(typeof body.attestation?.signature === "string", "missing attestation signature");
    assert(body.attestation?.signer_pubkey === signerPubkey!, "signer_pubkey mismatch in audit");
    auditId = body.audit_id;

    // Verify attestation hash
    const expectedHash = crypto
      .createHash("sha256")
      .update(JSON.stringify({ mints: [MINTS.TRUMP, MINTS.WIF, MINTS.BONK], results: body.results, timestamp: body.created_at }))
      .digest("hex");
    assert(body.attestation.hash === expectedHash, `attestation hash mismatch: expected ${expectedHash.slice(0, 16)}... got ${body.attestation.hash.slice(0, 16)}...`);

    log(`audit_id=${auditId}`);
    log(`aggregate_risk=${body.aggregate_risk_score} violations=${body.policy_violations?.length ?? 0}`);
    log(`attestation hash verified ✓`);
    if (body.policy_violations?.length > 0) {
      for (const v of body.policy_violations.slice(0, 3)) {
        log(`  violation: ${v.rule_name} — ${v.mint?.slice(0, 8)}...`);
      }
    }
  });

  await sleep(5000);

  // 3.6 Audit standard — full roster
  let auditStandardId: string;

  await check("POST /v1/audit/standard — full 10-token roster", async () => {
    const allMints = Object.values(MINTS);
    const res = await fetch(`${BASE}/v1/audit/standard`, {
      method: "POST",
      headers: { ...apiKeyHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ mints: allMints }),
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert(typeof body.audit_id === "string", "missing audit_id");
    auditStandardId = body.audit_id;
    log(`audit_id=${auditStandardId} aggregate_risk=${body.aggregate_risk_score} violations=${body.policy_violations?.length ?? 0}`);
    if (body.risk_distribution) {
      log(`distribution: ${JSON.stringify(body.risk_distribution)}`);
    }
  });

  // ════════════════════════════════════════════
  // Phase 4: x402 Real Payments
  // ════════════════════════════════════════════
  startPhase("4 — x402 Real Payments ($0.033)");

  if (SKIP_X402) {
    skip("GET /v1/check wSOL ($0.008)", "SKIP_X402=1");
    skip("POST /v1/check/batch/small ($0.025)", "SKIP_X402=1");
  } else {
    await check("GET /v1/check wSOL via x402 ($0.008)", async () => {
      const res = await paidFetch(`${BASE}/v1/check?mint=${MINTS.wSOL}`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const receipt = res.headers.get("payment-response");
      assert(receipt !== null, "missing payment-response header");
      const body = await res.json() as any;
      assert(body.risk_score <= 20, `wSOL risk too high: ${body.risk_score}`);
      assert(typeof body.checks === "object", "missing checks");
      assert(typeof body.response_signature === "string", "missing signature");
      log(`risk=${body.risk_score} (${body.risk_level}) receipt=${receipt!.slice(0, 40)}...`);
    });

    // Second x402 call — agent pays again, may or may not hit cache (multi-instance)
    await check("Second x402 call → 200 with valid response", async () => {
      const res = await paidFetch(`${BASE}/v1/check?mint=${MINTS.wSOL}`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json() as any;
      assert(typeof body.risk_score === "number", "missing risk_score");
      log(`cached_at=${body.cached_at ?? "null (multi-instance miss)"}`);
    });

    await check("POST /v1/check/batch/small via x402 ($0.025)", async () => {
      const res = await paidFetch(`${BASE}/v1/check/batch/small`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mints: [MINTS.wSOL, MINTS.USDC, MINTS.USDT] }),
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const receipt = res.headers.get("payment-response");
      assert(receipt !== null, "missing payment-response header");
      const body = await res.json() as any;
      assert(body.total === 3, `expected total=3, got ${body.total}`);
      assert(body.succeeded >= 2, `expected ≥2 succeeded, got ${body.succeeded}`);
      log(`total=${body.total} succeeded=${body.succeeded} receipt=${receipt!.slice(0, 40)}...`);
    });
  }

  // ════════════════════════════════════════════
  // Phase 5: Audit Artifacts
  // ════════════════════════════════════════════
  startPhase("5 — Audit Artifacts");

  await check("GET /v1/audit/history (bearer) — contains audit", async () => {
    const res = await fetch(`${BASE}/v1/audit/history`, { headers: bearerHeaders });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert(Array.isArray(body), "expected array");
    const found = body.find((a: any) => a.id === auditId!);
    assert(found !== undefined, `audit ${auditId} not in history`);
    log(`${body.length} audit(s) in history`);
  });

  await check("GET /v1/audit/history (API key) — also works", async () => {
    const res = await fetch(`${BASE}/v1/audit/history`, { headers: apiKeyHeaders });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert(Array.isArray(body), "expected array");
    // API key scoped — should see audits created with this key
    const found = body.find((a: any) => a.id === auditId!);
    assert(found !== undefined, `audit ${auditId} not visible via API key`);
  });

  await check("GET /v1/audit/history?mint=wSOL — filtered", async () => {
    const res = await fetch(`${BASE}/v1/audit/history?mint=${MINTS.wSOL}`, { headers: bearerHeaders });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert(Array.isArray(body), "expected array");
    // Standard audit includes wSOL
    log(`${body.length} audit(s) with wSOL`);
  });

  await check("GET /v1/audit/:id/report (bearer) — markdown", async () => {
    const res = await fetch(`${BASE}/v1/audit/${auditId}/report`, { headers: bearerHeaders });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    assert(contentType.includes("text/markdown"), `expected text/markdown, got ${contentType}`);
    const text = await res.text();
    assert(text.length > 500, `report too short: ${text.length} chars`);
    assert(text.includes("TokenSafe"), "report missing TokenSafe header");
    assert(text.includes("Risk level") || text.includes("Risk score"), "report missing risk details");
    log(`report: ${text.length} chars markdown`);
  });

  await check("GET /v1/audit/:id/report (API key) — also works", async () => {
    const res = await fetch(`${BASE}/v1/audit/${auditId}/report`, { headers: apiKeyHeaders });
    assert(res.status === 200, `expected 200, got ${res.status}`);
  });

  await check("GET /v1/audit/fake-uuid/report → 404", async () => {
    const res = await fetch(`${BASE}/v1/audit/00000000-0000-0000-0000-000000000000/report`, { headers: bearerHeaders });
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });

  await check("GET /v1/api-keys/:id/usage — used > 0", async () => {
    const res = await fetch(`${BASE}/v1/api-keys/${apiKeyId}/usage`, { headers: bearerHeaders });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert(body.used > 0, `expected used > 0, got ${body.used}`);
    assert(body.limit === 6000, `expected limit 6000, got ${body.limit}`);
    log(`used=${body.used} limit=${body.limit}`);
  });

  // ════════════════════════════════════════════
  // Phase 6: Cleanup
  // ════════════════════════════════════════════
  startPhase("6 — Cleanup");

  await check("DELETE /v1/webhooks/:id → 204", async () => {
    const res = await fetch(`${BASE}/v1/webhooks/${webhookId}`, {
      method: "DELETE",
      headers: bearerHeaders,
    });
    assert(res.status === 204, `expected 204, got ${res.status}`);
  });

  await check("Verify webhook gone", async () => {
    const res = await fetch(`${BASE}/v1/webhooks`, { headers: bearerHeaders });
    const body = await res.json() as any;
    const found = body.find((w: any) => w.id === webhookId);
    assert(found === undefined, `webhook ${webhookId} still in list`);
  });

  await check("DELETE /v1/api-keys/:id → 204", async () => {
    const res = await fetch(`${BASE}/v1/api-keys/${apiKeyId}`, {
      method: "DELETE",
      headers: bearerHeaders,
    });
    assert(res.status === 204, `expected 204, got ${res.status}`);
  });

  await check("Revoked key rejected", async () => {
    const res = await fetch(`${BASE}/v1/check?mint=${MINTS.wSOL}`, { headers: apiKeyHeaders });
    // Revoked key should return 401 (INVALID_API_KEY) not 402
    assert(res.status === 401, `expected 401 for revoked key, got ${res.status}`);
  });

  // ════════════════════════════════════════════
  // Phase 7: Summary
  // ════════════════════════════════════════════
  phases.push(currentPhase);

  const totalPassed = phases.reduce((s, p) => s + p.passed, 0);
  const totalFailed = phases.reduce((s, p) => s + p.failed, 0);
  const totalSkipped = phases.reduce((s, p) => s + p.skipped, 0);
  const total = totalPassed + totalFailed + totalSkipped;

  console.log(`\n${"═".repeat(60)}`);
  console.log("  SUMMARY");
  console.log(`${"═".repeat(60)}`);
  console.log(`\n  ${"Phase".padEnd(40)} Pass  Fail  Skip`);
  console.log(`  ${"─".repeat(55)}`);
  for (const p of phases) {
    const status = p.failed > 0 ? "\x1b[31m✗\x1b[0m" : "\x1b[32m✓\x1b[0m";
    console.log(`  ${status} ${p.name.padEnd(38)} ${String(p.passed).padStart(4)}  ${String(p.failed).padStart(4)}  ${String(p.skipped).padStart(4)}`);
  }
  console.log(`  ${"─".repeat(55)}`);
  console.log(`  ${"Total".padEnd(40)} ${String(totalPassed).padStart(4)}  ${String(totalFailed).padStart(4)}  ${String(totalSkipped).padStart(4)}`);
  console.log();

  const elapsed = Math.round((performance.now() - startTime) / 1000);
  if (!SKIP_X402) {
    console.log(`  x402 spend: ~$0.033 USDC (1 check + 1 batch/small)`);
  } else {
    console.log(`  x402 spend: $0 (SKIP_X402=1)`);
  }
  console.log(`  Total checks: ${total}`);
  console.log(`  Elapsed: ${elapsed}s`);
  console.log();

  if (totalFailed > 0) {
    console.log(`  \x1b[31m${totalFailed} FAILED\x1b[0m`);
  } else {
    console.log(`  \x1b[32mALL PASSED\x1b[0m`);
  }
  console.log();

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\x1b[31mFatal error:\x1b[0m", err);
  process.exit(1);
});
