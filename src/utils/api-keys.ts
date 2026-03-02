import crypto from "node:crypto";
import { getDb } from "./db.js";
import { config } from "../config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ApiKeyTier = "pro" | "enterprise";

export interface ApiKeyRecord {
  id: number;
  key_prefix: string;
  label: string;
  tier: ApiKeyTier;
  created_at: string;
  expires_at: string | null;
  active: boolean;
  monthly_limit: number;
  rate_limit_per_minute: number;
}

interface ApiKeyRow {
  id: number;
  key_hash: string;
  key_prefix: string;
  label: string;
  tier: string;
  created_at: string;
  expires_at: string | null;
  active: number;
  monthly_limit: number;
  rate_limit_per_minute: number;
}

interface UsageRow {
  api_key_id: number;
  month: string;
  check_count: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function rowToRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    key_prefix: row.key_prefix,
    label: row.label,
    tier: row.tier as ApiKeyTier,
    created_at: row.created_at,
    expires_at: row.expires_at,
    active: row.active === 1,
    monthly_limit: row.monthly_limit,
    rate_limit_per_minute: row.rate_limit_per_minute,
  };
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ─── Per-key rate limiter ────────────────────────────────────────────────────

interface RateBucket {
  count: number;
  resetAt: number;
}

const keyRateBuckets = new Map<string, RateBucket>();

// Purge stale entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of keyRateBuckets) {
    if (entry.resetAt <= now) keyRateBuckets.delete(key);
  }
}, 60_000).unref();

export function clearKeyRateBuckets(): void {
  keyRateBuckets.clear();
}

export function checkKeyRateLimit(record: ApiKeyRecord): boolean {
  const now = Date.now();
  const key = `apikey:${record.id}`;
  let bucket = keyRateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + 60_000 };
    keyRateBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count <= record.rate_limit_per_minute;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export function createApiKey(
  label: string,
  tier: ApiKeyTier,
  expiresAt?: string,
): { fullKey: string; record: ApiKeyRecord } {
  const rawBytes = crypto.randomBytes(32).toString("hex");
  const fullKey = `tks_${rawBytes}`;
  const keyHash = hashKey(fullKey);
  const keyPrefix = `tks_${rawBytes.slice(0, 8)}`;

  const monthlyLimit = tier === "enterprise" ? 0 : config.proMonthlyLimit;
  const rateLimit =
    tier === "enterprise" ? config.enterpriseRateLimit : config.proRateLimit;

  const stmt = getDb().prepare(`
    INSERT INTO api_keys (key_hash, key_prefix, label, tier, expires_at, monthly_limit, rate_limit_per_minute)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    keyHash,
    keyPrefix,
    label,
    tier,
    expiresAt ?? null,
    monthlyLimit,
    rateLimit,
  );

  const row = getDb()
    .prepare("SELECT * FROM api_keys WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as ApiKeyRow;

  return { fullKey, record: rowToRecord(row) };
}

export function validateApiKey(key: string): ApiKeyRecord | null {
  if (!key.startsWith("tks_")) return null;
  const keyHash = hashKey(key);
  const row = getDb()
    .prepare("SELECT * FROM api_keys WHERE key_hash = ?")
    .get(keyHash) as ApiKeyRow | undefined;
  if (!row) return null;
  return rowToRecord(row);
}

export function listApiKeys(): ApiKeyRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM api_keys ORDER BY id")
    .all() as ApiKeyRow[];
  return rows.map(rowToRecord);
}

export function revokeApiKey(id: number): boolean {
  const result = getDb()
    .prepare("UPDATE api_keys SET active = 0 WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

export function checkUsageLimit(keyId: number): {
  allowed: boolean;
  used: number;
  limit: number;
} {
  const row = getDb()
    .prepare("SELECT * FROM api_keys WHERE id = ?")
    .get(keyId) as ApiKeyRow | undefined;
  if (!row) return { allowed: false, used: 0, limit: 0 };

  const monthlyLimit = row.monthly_limit;
  if (monthlyLimit === 0) {
    // Enterprise: unlimited
    const usage = getDb()
      .prepare(
        "SELECT check_count FROM api_key_usage WHERE api_key_id = ? AND month = ?",
      )
      .get(keyId, currentMonth()) as { check_count: number } | undefined;
    return { allowed: true, used: usage?.check_count ?? 0, limit: 0 };
  }

  const usage = getDb()
    .prepare(
      "SELECT check_count FROM api_key_usage WHERE api_key_id = ? AND month = ?",
    )
    .get(keyId, currentMonth()) as { check_count: number } | undefined;

  const used = usage?.check_count ?? 0;
  return { allowed: used < monthlyLimit, used, limit: monthlyLimit };
}

export function incrementUsage(keyId: number): void {
  const month = currentMonth();
  getDb()
    .prepare(
      `INSERT INTO api_key_usage (api_key_id, month, check_count)
       VALUES (?, ?, 1)
       ON CONFLICT(api_key_id, month) DO UPDATE SET check_count = check_count + 1`,
    )
    .run(keyId, month);
}

export function getApiKeyUsage(
  keyId: number,
): { month: string; check_count: number }[] {
  return getDb()
    .prepare(
      "SELECT month, check_count FROM api_key_usage WHERE api_key_id = ? ORDER BY month DESC",
    )
    .all(keyId) as UsageRow[];
}
