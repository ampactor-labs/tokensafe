#!/usr/bin/env tsx

const BASE = process.env.SMOKE_URL ?? "http://localhost:3000";
const WSOL = "So11111111111111111111111111111111111111112";

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${(err as Error).message}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

async function main() {
  console.log(`\nSmoke testing ${BASE}\n`);

  // Connectivity check
  try {
    await fetch(`${BASE}/health`);
  } catch {
    console.error(
      `\x1b[31mServer not reachable at ${BASE}.\x1b[0m Start with: npm run dev`,
    );
    process.exit(1);
  }

  // --- Health ---
  console.log("Health:");

  await check("GET /health → 200", async () => {
    const res = await fetch(`${BASE}/health`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.status === "ok", `expected status:"ok", got ${body.status}`);
    assert(typeof body.version === "string", "missing version");
    assert(typeof body.network === "string", "missing network");
    assert(typeof body.uptime === "number", "missing uptime");
    assert(typeof body.cache?.size === "number", "missing cache.size");
    assert(
      typeof body.monitorCache?.size === "number",
      "missing monitorCache.size",
    );
  });

  await check("X-Response-Time header present", async () => {
    const res = await fetch(`${BASE}/health`);
    const header = res.headers.get("x-response-time");
    assert(
      header !== null && /^\d+ms$/.test(header),
      `expected \\d+ms, got ${header}`,
    );
  });

  await check("X-RateLimit headers present", async () => {
    const res = await fetch(`${BASE}/health`);
    assert(
      res.headers.get("x-ratelimit-limit") !== null,
      "missing x-ratelimit-limit",
    );
    assert(
      res.headers.get("x-ratelimit-remaining") !== null,
      "missing x-ratelimit-remaining",
    );
    assert(
      res.headers.get("x-ratelimit-reset") !== null,
      "missing x-ratelimit-reset",
    );
  });

  // --- Lite endpoint (free) ---
  console.log("\nLite endpoint:");

  await check("GET /v1/check/lite → 200 with risk score", async () => {
    const res = await fetch(`${BASE}/v1/check/lite?mint=${WSOL}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.mint === WSOL, `expected mint=${WSOL}, got ${body.mint}`);
    assert(typeof body.risk_score === "number", "missing risk_score");
    assert(typeof body.risk_level === "string", "missing risk_level");
    assert(typeof body.summary === "string", "missing summary");
    assert(typeof body.full_report === "string", "missing full_report");
    assert(
      !body.checks,
      "lite response should NOT include checks (that's the paid endpoint)",
    );
  });

  await check("GET /v1/check/lite with bad mint → 400", async () => {
    const res = await fetch(`${BASE}/v1/check/lite?mint=not-a-real-mint`);
    assert(res.status === 400, `expected 400, got ${res.status}`);
    const body = await res.json();
    assert(
      body.error?.code === "INVALID_MINT_ADDRESS",
      `expected INVALID_MINT_ADDRESS, got ${body.error?.code}`,
    );
  });

  await check("GET /v1/check/lite without mint → 400", async () => {
    const res = await fetch(`${BASE}/v1/check/lite`);
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await check("X-Cache header present on lite", async () => {
    const res = await fetch(`${BASE}/v1/check/lite?mint=${WSOL}`);
    const cache = res.headers.get("x-cache");
    assert(
      cache === "HIT" || cache === "MISS",
      `expected HIT or MISS, got ${cache}`,
    );
  });

  // --- x402 gate ---
  console.log("\nx402 payment gate:");

  await check("GET /v1/check → 402 with PAYMENT-REQUIRED header", async () => {
    const res = await fetch(`${BASE}/v1/check?mint=${WSOL}`);
    assert(res.status === 402, `expected 402, got ${res.status}`);
    const pr = res.headers.get("payment-required");
    assert(pr !== null && pr.length > 0, "missing PAYMENT-REQUIRED header");
  });

  await check("GET /v1/monitor → 402 with PAYMENT-REQUIRED header", async () => {
    const res = await fetch(`${BASE}/v1/monitor?mints=${WSOL}`);
    assert(res.status === 402, `expected 402, got ${res.status}`);
    const pr = res.headers.get("payment-required");
    assert(pr !== null && pr.length > 0, "missing PAYMENT-REQUIRED header");
  });

  // --- Error handling ---
  console.log("\nError handling:");

  await check("GET /unknown → 404", async () => {
    const res = await fetch(`${BASE}/no-such-route`);
    assert(res.status === 404, `expected 404, got ${res.status}`);
    const body = await res.json();
    assert(
      body.error?.code === "NOT_FOUND",
      `expected NOT_FOUND, got ${body.error?.code}`,
    );
  });

  // --- Summary ---
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
