import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { logger } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WebhookSubscription {
  id: number;
  callback_url: string;
  mints: string[];
  threshold: number;
  created_at: string;
  last_checked_at: string | null;
  active: boolean;
  secret_hmac: string;
}

export interface WebhookDelivery {
  id: number;
  subscription_id: number;
  mint: string;
  payload_json: string;
  delivered_at: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  next_retry_at: string | null;
}

export interface AuditResultRow {
  id: string;
  api_key_id: number | null;
  mints_json: string;
  policy_json: string;
  results_json: string;
  violations_json: string;
  aggregate_risk_score: number;
  attestation_hash: string;
  attestation_signature: string;
  created_at: string;
  expires_at: string;
}

// Raw row shape from SQLite (booleans are 0/1 integers, mints is JSON string)
interface WebhookSubscriptionRow {
  id: number;
  callback_url: string;
  mints_json: string;
  threshold: number;
  created_at: string;
  last_checked_at: string | null;
  active: number;
  secret_hmac: string;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  callback_url TEXT NOT NULL,
  mints_json TEXT NOT NULL DEFAULT '[]',
  threshold INTEGER NOT NULL DEFAULT 50,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  secret_hmac TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  mint TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  FOREIGN KEY (subscription_id) REFERENCES webhook_subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deliveries_subscription
  ON webhook_deliveries(subscription_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status
  ON webhook_deliveries(status, next_retry_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT 'pro',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  monthly_limit INTEGER NOT NULL DEFAULT 6000,
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 200
);

CREATE TABLE IF NOT EXISTS api_key_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  check_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
  UNIQUE(api_key_id, month)
);

CREATE TABLE IF NOT EXISTS audit_results (
  id TEXT PRIMARY KEY,
  api_key_id INTEGER,
  mints_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  results_json TEXT NOT NULL,
  violations_json TEXT NOT NULL,
  aggregate_risk_score REAL NOT NULL,
  attestation_hash TEXT NOT NULL,
  attestation_signature TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_results(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_api_key ON audit_results(api_key_id);
`;

// ─── Singleton ───────────────────────────────────────────────────────────────

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath = config.dbPath;
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  logger.info({ dbPath }, "SQLite database initialized");
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// For tests: inject a :memory: database
export function initTestDb(): Database.Database {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

// ─── Subscription CRUD ───────────────────────────────────────────────────────

function rowToSubscription(row: WebhookSubscriptionRow): WebhookSubscription {
  return {
    ...row,
    mints: JSON.parse(row.mints_json) as string[],
    active: row.active === 1,
  };
}

export function createSubscription(
  callbackUrl: string,
  mints: string[],
  threshold: number,
  secretHmac: string,
): WebhookSubscription {
  const stmt = getDb().prepare(`
    INSERT INTO webhook_subscriptions (callback_url, mints_json, threshold, secret_hmac)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(
    callbackUrl,
    JSON.stringify(mints),
    threshold,
    secretHmac,
  );
  return getSubscription(Number(result.lastInsertRowid))!;
}

export function getSubscription(id: number): WebhookSubscription | null {
  const row = getDb()
    .prepare("SELECT * FROM webhook_subscriptions WHERE id = ?")
    .get(id) as WebhookSubscriptionRow | undefined;
  return row ? rowToSubscription(row) : null;
}

export function listSubscriptions(): WebhookSubscription[] {
  const rows = getDb()
    .prepare("SELECT * FROM webhook_subscriptions ORDER BY id")
    .all() as WebhookSubscriptionRow[];
  return rows.map(rowToSubscription);
}

export function updateSubscription(
  id: number,
  updates: Partial<
    Pick<WebhookSubscription, "callback_url" | "mints" | "threshold" | "active">
  >,
): WebhookSubscription | null {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.callback_url !== undefined) {
    setClauses.push("callback_url = ?");
    values.push(updates.callback_url);
  }
  if (updates.mints !== undefined) {
    setClauses.push("mints_json = ?");
    values.push(JSON.stringify(updates.mints));
  }
  if (updates.threshold !== undefined) {
    setClauses.push("threshold = ?");
    values.push(updates.threshold);
  }
  if (updates.active !== undefined) {
    setClauses.push("active = ?");
    values.push(updates.active ? 1 : 0);
  }

  if (setClauses.length === 0) return getSubscription(id);

  values.push(id);
  getDb()
    .prepare(
      `UPDATE webhook_subscriptions SET ${setClauses.join(", ")} WHERE id = ?`,
    )
    .run(...values);
  return getSubscription(id);
}

export function deleteSubscription(id: number): boolean {
  const result = getDb()
    .prepare("DELETE FROM webhook_subscriptions WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

export function touchSubscriptionCheckedAt(id: number): void {
  getDb()
    .prepare(
      "UPDATE webhook_subscriptions SET last_checked_at = datetime('now') WHERE id = ?",
    )
    .run(id);
}

// ─── Delivery CRUD ───────────────────────────────────────────────────────────

export function createDelivery(
  subscriptionId: number,
  mint: string,
  payloadJson: string,
): WebhookDelivery {
  const stmt = getDb().prepare(`
    INSERT INTO webhook_deliveries (subscription_id, mint, payload_json)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(subscriptionId, mint, payloadJson);
  return getDb()
    .prepare("SELECT * FROM webhook_deliveries WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as WebhookDelivery;
}

export function markDelivered(id: number): void {
  getDb()
    .prepare(
      "UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1 WHERE id = ?",
    )
    .run(id);
}

export function markFailed(id: number, nextRetryAt: string | null): void {
  getDb()
    .prepare(
      "UPDATE webhook_deliveries SET status = 'failed', attempts = attempts + 1, next_retry_at = ? WHERE id = ?",
    )
    .run(nextRetryAt, id);
}

export function getPendingDeliveries(): WebhookDelivery[] {
  return getDb()
    .prepare(
      `SELECT * FROM webhook_deliveries
       WHERE status = 'pending'
          OR (status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= datetime('now'))
       ORDER BY id`,
    )
    .all() as WebhookDelivery[];
}
