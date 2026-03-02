import { describe, it, expect, beforeEach } from "vitest";
import { initTestDb, closeDb } from "../src/utils/db.js";
import {
  saveAuditResult,
  getAuditResult,
  listAuditHistory,
  pruneExpiredAudits,
} from "../src/utils/audit-db.js";
import type { AuditResultRow } from "../src/utils/db.js";

function makeAuditRow(overrides?: Partial<AuditResultRow>): AuditResultRow {
  return {
    id: "test-uuid-" + Math.random().toString(36).slice(2, 8),
    api_key_id: null,
    mints_json: '["So11111111111111111111111111111111111111112"]',
    policy_json: '{"name":"default","rules":[]}',
    results_json:
      '[{"mint":"So11111111111111111111111111111111111111112","risk_score":15}]',
    violations_json: "[]",
    aggregate_risk_score: 15.0,
    attestation_hash: "abc123",
    attestation_signature: "sig456",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  closeDb();
  initTestDb();
});

describe("saveAuditResult + getAuditResult", () => {
  it("roundtrips correctly", () => {
    const row = makeAuditRow({ id: "roundtrip-1" });
    saveAuditResult(row);
    const retrieved = getAuditResult("roundtrip-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe("roundtrip-1");
    expect(retrieved!.aggregate_risk_score).toBe(15.0);
    expect(retrieved!.attestation_hash).toBe("abc123");
  });

  it("returns null for non-existent ID", () => {
    expect(getAuditResult("nonexistent")).toBeNull();
  });
});

describe("listAuditHistory", () => {
  it("filters by api_key_id", () => {
    saveAuditResult(makeAuditRow({ id: "key1-audit", api_key_id: 1 }));
    saveAuditResult(makeAuditRow({ id: "key2-audit", api_key_id: 2 }));

    const results = listAuditHistory({ apiKeyId: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("key1-audit");
  });

  it("filters by date range", () => {
    saveAuditResult(
      makeAuditRow({ id: "old", created_at: "2025-01-01T00:00:00Z" }),
    );
    saveAuditResult(
      makeAuditRow({ id: "new", created_at: "2026-06-01T00:00:00Z" }),
    );

    const results = listAuditHistory({
      from: "2026-01-01T00:00:00Z",
      to: "2026-12-31T23:59:59Z",
    });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("new");
  });

  it("filters by mint (JSON LIKE)", () => {
    const mint1 = "So11111111111111111111111111111111111111112";
    const mint2 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    saveAuditResult(
      makeAuditRow({ id: "has-wsol", mints_json: JSON.stringify([mint1]) }),
    );
    saveAuditResult(
      makeAuditRow({ id: "has-usdc", mints_json: JSON.stringify([mint2]) }),
    );

    const results = listAuditHistory({ mint: mint1 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("has-wsol");
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      saveAuditResult(makeAuditRow());
    }
    const results = listAuditHistory({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("returns empty array when no audits", () => {
    expect(listAuditHistory()).toEqual([]);
  });
});

describe("pruneExpiredAudits", () => {
  it("deletes expired records", () => {
    saveAuditResult(
      makeAuditRow({
        id: "expired",
        expires_at: "2020-01-01T00:00:00Z",
      }),
    );
    saveAuditResult(
      makeAuditRow({
        id: "fresh",
        expires_at: new Date(
          Date.now() + 90 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      }),
    );

    const count = pruneExpiredAudits();
    expect(count).toBe(1);

    expect(getAuditResult("expired")).toBeNull();
    expect(getAuditResult("fresh")).not.toBeNull();
  });

  it("returns 0 when nothing to prune", () => {
    saveAuditResult(makeAuditRow());
    expect(pruneExpiredAudits()).toBe(0);
  });
});
