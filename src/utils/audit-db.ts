import { getDb, type AuditResultRow } from "./db.js";

export type { AuditResultRow };

export function saveAuditResult(record: AuditResultRow): void {
  getDb()
    .prepare(
      `INSERT INTO audit_results (id, api_key_id, mints_json, policy_json, results_json, violations_json, aggregate_risk_score, attestation_hash, attestation_signature, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.api_key_id,
      record.mints_json,
      record.policy_json,
      record.results_json,
      record.violations_json,
      record.aggregate_risk_score,
      record.attestation_hash,
      record.attestation_signature,
      record.created_at,
      record.expires_at,
    );
}

export function getAuditResult(id: string): AuditResultRow | null {
  return (
    (getDb().prepare("SELECT * FROM audit_results WHERE id = ?").get(id) as
      | AuditResultRow
      | undefined) ?? null
  );
}

export interface ListAuditHistoryOpts {
  apiKeyId?: number;
  mint?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export function listAuditHistory(
  opts: ListAuditHistoryOpts = {},
): AuditResultRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (opts.apiKeyId !== undefined) {
    clauses.push("api_key_id = ?");
    params.push(opts.apiKeyId);
  }
  if (opts.mint) {
    clauses.push("mints_json LIKE ?");
    params.push(`%"${opts.mint}"%`);
  }
  if (opts.from) {
    clauses.push("created_at >= ?");
    params.push(opts.from);
  }
  if (opts.to) {
    clauses.push("created_at <= ?");
    params.push(opts.to);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts.limit ?? 100;

  return getDb()
    .prepare(
      `SELECT * FROM audit_results ${where} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, limit) as AuditResultRow[];
}

export function pruneExpiredAudits(): number {
  const result = getDb()
    .prepare("DELETE FROM audit_results WHERE expires_at < datetime('now')")
    .run();
  return result.changes;
}
