#!/usr/bin/env tsx
/**
 * Mainnet accuracy audit — checks ~21 tokens across 7 risk categories
 * against the production TokenSafe API and flags scoring surprises.
 *
 * Usage:
 *   SMOKE_URL=https://tokensafe-production.up.railway.app \
 *   API_KEY=tks_... \
 *   npx tsx scripts/accuracy-audit.ts
 */

const BASE = process.env.SMOKE_URL ?? "http://localhost:3000";
const API_KEY = process.env.API_KEY ?? "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Token roster ────────────────────────────────────────────────────────

interface TokenEntry {
  symbol: string;
  mint: string;
  category: string;
  expectMin: number;
  expectMax: number;
  fullCheck: boolean;
  note: string;
}

const CATEGORIES: Record<string, { label: string; expectMin: number; expectMax: number }> = {
  trusted:     { label: "Trusted Authority Tokens",    expectMin: 0,  expectMax: 50 },
  untrusted:   { label: "Active Untrusted Authority",  expectMin: 5,  expectMax: 50 },
  concentrated:{ label: "High Concentration",          expectMin: 40, expectMax: 70 },
  rugged:      { label: "Rugged / Zero Liquidity",     expectMin: 50, expectMax: 100 },
  extensions:  { label: "Token-2022 Extensions",       expectMin: 20, expectMax: 100 },
  fresh:       { label: "Fresh pump.fun Tokens",       expectMin: 25, expectMax: 100 },
  baseline:    { label: "Established Baseline",        expectMin: 0,  expectMax: 40 },
};

const STATIC_TOKENS: TokenEntry[] = [
  // Category 1: Trusted Authority
  { symbol: "mSOL",    mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",     category: "trusted", expectMin: 0, expectMax: 25, fullCheck: false, note: "LST, trusted mint auth" },
  { symbol: "JitoSOL", mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",     category: "trusted", expectMin: 0, expectMax: 15, fullCheck: false, note: "LST, trusted mint auth" },
  { symbol: "bSOL",    mint: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",       category: "trusted", expectMin: 0, expectMax: 50, fullCheck: false, note: "LST, trusted mint auth, high holder concentration" },
  { symbol: "PYUSD",   mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",     category: "trusted", expectMin: 0, expectMax: 50, fullCheck: true,  note: "Token-2022, Paxos, high holder concentration" },

  // Category 2: Active Untrusted Authority
  { symbol: "JupSOL",  mint: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",       category: "untrusted", expectMin: 5, expectMax: 50, fullCheck: true, note: "NOT trusted, deep liquidity + established" },
  { symbol: "INF",     mint: "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm",       category: "untrusted", expectMin: 5, expectMax: 50, fullCheck: false, note: "Sanctum multi-LST, not trusted" },

  // Category 3: High Concentration
  { symbol: "TRUMP",   mint: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",       category: "concentrated", expectMin: 40, expectMax: 70, fullCheck: true, note: "top10=91.5%, top1=76.8%" },

  // Category 4: Rugged / Zero Liquidity
  { symbol: "SHAR",    mint: "DCfVHxrnLfHQuyjiMdHdnbn3NAAnPX8Ny15WNgofpump",       category: "rugged", expectMin: 50, expectMax: 100, fullCheck: true, note: "Confirmed rug, $0 liquidity, pump.fun Token-2022" },

  // Category 5: Token-2022 Extensions
  { symbol: "PD-test", mint: "aNMXxywEHAH3VfWnaVwedLJWPT9NsxagsGTEQqS5WKK",       category: "extensions", expectMin: 20, expectMax: 100, fullCheck: true, note: "PermanentDelegate example" },

  // Category 6: Fresh pump.fun — 1 known + 3 dynamic
  { symbol: "MeuW...", mint: "MeuWvMQTbze3BMzhKuD9TQhLmVwtwUqA6PFPPV1pump",         category: "fresh", expectMin: 25, expectMax: 100, fullCheck: true, note: "Known pump.fun, score=58 last session" },

  // Category 7: Established Baseline
  { symbol: "wSOL",    mint: "So11111111111111111111111111111111111111112",           category: "baseline", expectMin: 0, expectMax: 20, fullCheck: false, note: "Blue chip" },
  { symbol: "USDC",    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",       category: "baseline", expectMin: 0, expectMax: 15, fullCheck: false, note: "Stablecoin" },
  { symbol: "BONK",    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",       category: "baseline", expectMin: 0, expectMax: 25, fullCheck: false, note: "Established memecoin" },
  { symbol: "WIF",     mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",       category: "baseline", expectMin: 0, expectMax: 25, fullCheck: false, note: "Established memecoin" },
  { symbol: "PENGU",   mint: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",       category: "baseline", expectMin: 0, expectMax: 25, fullCheck: false, note: "NFT-community" },
  { symbol: "JUP",     mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",         category: "baseline", expectMin: 0, expectMax: 40, fullCheck: false, note: "DeFi blue chip, may have holder concentration" },
];

// ── Result types ────────────────────────────────────────────────────────

interface LiteResult {
  mint: string;
  name: string | null;
  symbol: string | null;
  risk_score: number;
  risk_level: string;
  summary: string;
  degraded: boolean;
  degraded_checks: string[];
  checks_completed: number;
  checks_total: number;
  is_token_2022: boolean;
  has_risky_extensions: boolean;
  can_sell: boolean | null;
  authorities_renounced: boolean;
  has_liquidity: boolean;
  liquidity_rating: string | null;
  top_10_concentration: number | null;
  token_age_hours: number | null;
}

interface FullResult {
  risk_score: number;
  risk_level: string;
  score_breakdown: Record<string, number>;
  checks: Record<string, unknown>;
  degraded: boolean;
  degraded_checks: string[];
}

interface AuditRow {
  entry: TokenEntry;
  lite: LiteResult | null;
  full: FullResult | null;
  error: string | null;
  verdict: "PASS" | "WARN" | "FAIL";
}

// ── API calls ───────────────────────────────────────────────────────────

async function fetchLite(mint: string): Promise<LiteResult> {
  const res = await fetch(`${BASE}/v1/check/lite?mint=${mint}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`lite ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchFull(mint: string): Promise<FullResult> {
  const headers: Record<string, string> = {};
  if (API_KEY) headers["X-API-Key"] = API_KEY;
  const res = await fetch(`${BASE}/v1/check?mint=${mint}`, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`full ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ── Fetch fresh pump.fun tokens from DexScreener ────────────────────────

async function fetchFreshPumpTokens(count: number): Promise<TokenEntry[]> {
  try {
    const res = await fetch("https://api.dexscreener.com/token-profiles/latest/v1");
    if (!res.ok) throw new Error(`DexScreener ${res.status}`);
    const profiles: Array<{ chainId: string; tokenAddress: string; description?: string }> = await res.json();

    const pumpTokens = profiles
      .filter((p) => p.chainId === "solana" && p.tokenAddress.endsWith("pump"))
      .slice(0, count);

    return pumpTokens.map((p) => ({
      symbol: p.tokenAddress.slice(0, 6) + "...",
      mint: p.tokenAddress,
      category: "fresh",
      expectMin: 25,
      expectMax: 100,
      fullCheck: false,
      note: "Dynamic pump.fun from DexScreener",
    }));
  } catch (err) {
    console.log(`  \x1b[33m⚠\x1b[0m Could not fetch DexScreener profiles: ${(err as Error).message}`);
    return [];
  }
}

// ── Verdict logic ───────────────────────────────────────────────────────

function judge(entry: TokenEntry, score: number | null): "PASS" | "WARN" | "FAIL" {
  if (score === null) return "WARN";

  // Hard failures — trusted authority ≠ low risk (concentration can push scores up)
  if (entry.category === "trusted" && score > 50) return "FAIL";
  if (entry.category === "rugged" && score < 40) return "FAIL";
  if (entry.category === "baseline" && score > 40) return "FAIL";

  // Soft warnings
  if (score < entry.expectMin || score > entry.expectMax) return "WARN";

  return "PASS";
}

// ── Display ─────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";

function verdictIcon(v: "PASS" | "WARN" | "FAIL"): string {
  if (v === "PASS") return `${GREEN}✓${RESET}`;
  if (v === "WARN") return `${YELLOW}⚠${RESET}`;
  return `${RED}✗${RESET}`;
}

function riskColor(level: string): string {
  if (level === "LOW") return GREEN;
  if (level === "MODERATE") return YELLOW;
  if (level === "HIGH") return `\x1b[38;5;208m`; // orange
  if (level === "CRITICAL") return RED;
  if (level === "EXTREME") return `\x1b[35m`; // magenta
  return RESET;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function printRow(row: AuditRow) {
  const l = row.lite;
  const sym = pad(l?.symbol ?? row.entry.symbol, 12);
  const score = l ? String(l.risk_score).padStart(3) : " ? ";
  const level = l ? pad(l.risk_level, 9) : pad("ERROR", 9);
  const color = l ? riskColor(l.risk_level) : RED;

  let details = "";
  if (l) {
    const auth = l.authorities_renounced ? "renounced" : "active";
    const liq = l.liquidity_rating ?? (l.has_liquidity ? "yes" : "NONE");
    const t2022 = l.is_token_2022 ? "yes" : "no";
    details = `auth=${pad(auth, 9)}  liq=${pad(liq, 8)}  t2022=${t2022}`;
    if (l.can_sell === false) details += `  ${RED}can_sell=false${RESET}`;
    if (l.degraded) details += `  ${YELLOW}degraded=${JSON.stringify(l.degraded_checks)}${RESET}`;
  } else if (row.error) {
    details = `${RED}${row.error}${RESET}`;
  }

  console.log(`  ${verdictIcon(row.verdict)} ${sym} ${color}${score} ${level}${RESET}  ${details}`);
}

function printFullDetails(row: AuditRow) {
  if (!row.full) return;
  const f = row.full;
  const bd = Object.entries(f.score_breakdown)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  console.log(`    ${DIM}breakdown: ${bd || "(none)"}${RESET}`);

  const checks = f.checks as Record<string, Record<string, unknown>>;
  if (checks.top_holders) {
    const th = checks.top_holders as { top_10_percentage?: number; top_1_percentage?: number; status?: string };
    if (th.status === "OK") {
      console.log(`    ${DIM}holders: top10=${th.top_10_percentage}%, top1=${th.top_1_percentage}%${RESET}`);
    } else {
      console.log(`    ${DIM}holders: ${th.status}${RESET}`);
    }
  }
  if (checks.liquidity) {
    const lq = checks.liquidity as { liquidity_rating?: string; lp_locked?: boolean | null; pool_address?: string };
    console.log(`    ${DIM}liquidity: rating=${lq.liquidity_rating}, lp_locked=${lq.lp_locked}, pool=${(lq.pool_address ?? "none").slice(0, 12)}...${RESET}`);
  }
  if (checks.token_2022_extensions) {
    const ext = checks.token_2022_extensions as Array<{ name: string }>;
    if (Array.isArray(ext) && ext.length > 0) {
      console.log(`    ${DIM}extensions: ${ext.map((e) => e.name).join(", ")}${RESET}`);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log(`\n${BOLD}${"═".repeat(65)}${RESET}`);
  console.log(`${BOLD}  TOKENSAFE ACCURACY AUDIT — ${new Date().toISOString().split("T")[0]}${RESET}`);
  console.log(`${BOLD}  Target: ${BASE}${RESET}`);
  console.log(`${BOLD}  API Key: ${API_KEY ? API_KEY.slice(0, 8) + "..." : "(none — full checks will use x402 gate)"}${RESET}`);
  console.log(`${BOLD}${"═".repeat(65)}${RESET}\n`);

  // Verify server is reachable
  try {
    const res = await fetch(`${BASE}/health`);
    const body = await res.json() as { status: string; network: string };
    console.log(`  ${GREEN}✓${RESET} Server reachable, network=${body.network}\n`);
  } catch {
    console.error(`  ${RED}✗ Server not reachable at ${BASE}${RESET}`);
    process.exit(1);
  }

  // Fetch dynamic pump.fun tokens
  console.log(`${DIM}Fetching fresh pump.fun tokens from DexScreener...${RESET}`);
  const dynamicTokens = await fetchFreshPumpTokens(3);
  console.log(`  Found ${dynamicTokens.length} fresh pump.fun tokens\n`);

  const allTokens: TokenEntry[] = [...STATIC_TOKENS, ...dynamicTokens];

  // Phase 1: Lite checks for all tokens (paced at ~2.5s intervals)
  const results: AuditRow[] = [];

  console.log(`${BOLD}Phase 1: Lite checks (${allTokens.length} tokens, ~${Math.ceil(allTokens.length * 2.5)}s)${RESET}\n`);

  for (let i = 0; i < allTokens.length; i++) {
    const entry = allTokens[i];
    try {
      const lite = await fetchLite(entry.mint);
      // Update symbol from API if we have a placeholder
      if (lite.symbol && entry.symbol.includes("...")) {
        entry.symbol = lite.symbol;
      }
      const verdict = judge(entry, lite.risk_score);
      results.push({ entry, lite, full: null, error: null, verdict });
      const icon = verdict === "PASS" ? `${GREEN}✓${RESET}` : verdict === "WARN" ? `${YELLOW}⚠${RESET}` : `${RED}✗${RESET}`;
      const color = riskColor(lite.risk_level);
      console.log(`  ${icon} ${pad(lite.symbol ?? entry.symbol, 12)} ${color}${String(lite.risk_score).padStart(3)} ${lite.risk_level}${RESET}`);
    } catch (err) {
      const msg = (err as Error).message;
      results.push({ entry, lite: null, full: null, error: msg, verdict: "WARN" });
      console.log(`  ${YELLOW}⚠${RESET} ${pad(entry.symbol, 12)} ${RED}ERROR: ${msg.slice(0, 60)}${RESET}`);
    }

    // Rate limit pacing (30/min = 2s between calls, use 2.5s for safety)
    if (i < allTokens.length - 1) await sleep(2500);
  }

  // Phase 2: Full checks for selected tokens (via API key)
  const fullTargets = results.filter((r) => r.entry.fullCheck && r.lite !== null);

  if (fullTargets.length > 0 && API_KEY) {
    console.log(`\n${BOLD}Phase 2: Full checks (${fullTargets.length} tokens via API key)${RESET}\n`);

    for (const row of fullTargets) {
      try {
        const full = await fetchFull(row.entry.mint);
        row.full = full;
        console.log(`  ${GREEN}✓${RESET} ${pad(row.lite!.symbol ?? row.entry.symbol, 12)} full check complete`);
      } catch (err) {
        console.log(`  ${YELLOW}⚠${RESET} ${pad(row.entry.symbol, 12)} full check failed: ${(err as Error).message.slice(0, 60)}`);
      }
      await sleep(500);
    }
  } else if (fullTargets.length > 0 && !API_KEY) {
    console.log(`\n${DIM}Skipping full checks — no API_KEY set (would trigger x402 paywall)${RESET}`);
  }

  // ── Results table ─────────────────────────────────────────────────────

  console.log(`\n${BOLD}${"═".repeat(65)}${RESET}`);
  console.log(`${BOLD}  DETAILED RESULTS${RESET}`);
  console.log(`${BOLD}${"═".repeat(65)}${RESET}\n`);

  const categoryOrder = ["trusted", "untrusted", "concentrated", "rugged", "extensions", "fresh", "baseline"];

  for (const catKey of categoryOrder) {
    const cat = CATEGORIES[catKey];
    const rows = results.filter((r) => r.entry.category === catKey);
    if (rows.length === 0) continue;

    console.log(`${CYAN}${cat.label}${RESET} ${DIM}(expect: ${cat.expectMin}-${cat.expectMax})${RESET}`);

    for (const row of rows) {
      printRow(row);
      if (row.full) printFullDetails(row);
    }
    console.log();
  }

  // ── Accuracy summary ─────────────────────────────────────────────────

  console.log(`${BOLD}${"═".repeat(65)}${RESET}`);
  console.log(`${BOLD}  SCORING ACCURACY SUMMARY${RESET}`);
  console.log(`${BOLD}${"═".repeat(65)}${RESET}\n`);

  console.log(`  ${pad("Category", 35)} ${pad("Tokens", 7)} ${pad("Pass", 5)} ${pad("Warn", 5)} ${pad("Fail", 5)}`);
  console.log(`  ${"─".repeat(57)}`);

  let totalPass = 0, totalWarn = 0, totalFail = 0;

  for (const catKey of categoryOrder) {
    const cat = CATEGORIES[catKey];
    const rows = results.filter((r) => r.entry.category === catKey);
    if (rows.length === 0) continue;

    const pass = rows.filter((r) => r.verdict === "PASS").length;
    const warn = rows.filter((r) => r.verdict === "WARN").length;
    const fail = rows.filter((r) => r.verdict === "FAIL").length;
    totalPass += pass; totalWarn += warn; totalFail += fail;

    const failStr = fail > 0 ? `${RED}${fail}${RESET}` : "0";
    const warnStr = warn > 0 ? `${YELLOW}${warn}${RESET}` : "0";
    console.log(`  ${pad(cat.label, 35)} ${pad(String(rows.length), 7)} ${pad(String(pass), 5)} ${pad(warnStr, warn > 0 ? 14 : 5)} ${pad(failStr, fail > 0 ? 14 : 5)}`);
  }

  const total = totalPass + totalWarn + totalFail;
  console.log(`  ${"─".repeat(57)}`);
  const totalFailStr = totalFail > 0 ? `${RED}${totalFail}${RESET}` : "0";
  const totalWarnStr = totalWarn > 0 ? `${YELLOW}${totalWarn}${RESET}` : "0";
  console.log(`  ${pad("Total", 35)} ${pad(String(total), 7)} ${pad(String(totalPass), 5)} ${pad(totalWarnStr, totalWarn > 0 ? 14 : 5)} ${pad(totalFailStr, totalFail > 0 ? 14 : 5)}`);

  // ── Surprises detail ──────────────────────────────────────────────────

  const surprises = results.filter((r) => r.verdict !== "PASS");
  if (surprises.length > 0) {
    console.log(`\n${BOLD}  SURPRISES (needs review)${RESET}\n`);
    for (const s of surprises) {
      const score = s.lite?.risk_score ?? "?";
      const expected = `${s.entry.expectMin}-${s.entry.expectMax}`;
      const icon = s.verdict === "FAIL" ? `${RED}FAIL${RESET}` : `${YELLOW}WARN${RESET}`;
      console.log(`  ${icon} ${s.lite?.symbol ?? s.entry.symbol} (${s.entry.category}): score=${score}, expected=${expected}, note="${s.entry.note}"`);
      if (s.full) {
        const bd = Object.entries(s.full.score_breakdown)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        console.log(`        breakdown: ${bd}`);
      }
      if (s.error) {
        console.log(`        error: ${s.error}`);
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${DIM}Completed in ${elapsed}s${RESET}\n`);

  process.exit(totalFail > 0 ? 1 : 0);
}

main();
