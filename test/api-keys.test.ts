import { describe, it, expect, beforeEach } from "vitest";
import { initTestDb, closeDb, getDb } from "../src/utils/db.js";
import {
  createApiKey,
  validateApiKey,
  checkUsageLimit,
  incrementUsage,
  checkKeyRateLimit,
  clearKeyRateBuckets,
  listApiKeys,
  revokeApiKey,
  getApiKeyUsage,
} from "../src/utils/api-keys.js";

beforeEach(() => {
  closeDb();
  initTestDb();
  clearKeyRateBuckets();
});

describe("createApiKey", () => {
  it("returns tks_ prefixed key", () => {
    const { fullKey, record } = createApiKey("test-key", "pro");
    expect(fullKey).toMatch(/^tks_[0-9a-f]{64}$/);
    expect(record.key_prefix).toMatch(/^tks_[0-9a-f]{8}$/);
    expect(record.label).toBe("test-key");
    expect(record.tier).toBe("pro");
    expect(record.active).toBe(true);
  });

  it("sets pro defaults", () => {
    const { record } = createApiKey("pro-key", "pro");
    expect(record.monthly_limit).toBe(6000);
    expect(record.rate_limit_per_minute).toBe(200);
  });

  it("sets enterprise defaults", () => {
    const { record } = createApiKey("ent-key", "enterprise");
    expect(record.monthly_limit).toBe(0); // unlimited
    expect(record.rate_limit_per_minute).toBe(600);
  });

  it("supports optional expires_at", () => {
    const { record } = createApiKey("exp-key", "pro", "2027-01-01T00:00:00Z");
    expect(record.expires_at).toBe("2027-01-01T00:00:00Z");
  });
});

describe("validateApiKey", () => {
  it("returns record for valid key", () => {
    const { fullKey } = createApiKey("test", "pro");
    const record = validateApiKey(fullKey);
    expect(record).not.toBeNull();
    expect(record!.label).toBe("test");
    expect(record!.tier).toBe("pro");
  });

  it("returns null for invalid key", () => {
    expect(validateApiKey("tks_invalid")).toBeNull();
  });

  it("returns null for non-tks prefixed key", () => {
    expect(validateApiKey("not-a-key")).toBeNull();
  });

  it("returns revoked key record (active=false)", () => {
    const { fullKey, record } = createApiKey("revoked", "pro");
    revokeApiKey(record.id);
    const result = validateApiKey(fullKey);
    expect(result).not.toBeNull();
    expect(result!.active).toBe(false);
  });
});

describe("checkUsageLimit", () => {
  it("allows usage under limit", () => {
    const { record } = createApiKey("test", "pro");
    const result = checkUsageLimit(record.id);
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
    expect(result.limit).toBe(6000);
  });

  it("enforces monthly limit for pro keys", () => {
    const { record } = createApiKey("test", "pro");
    // Manually set usage to the limit
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    getDb()
      .prepare(
        "INSERT INTO api_key_usage (api_key_id, month, check_count) VALUES (?, ?, ?)",
      )
      .run(record.id, month, 6000);

    const result = checkUsageLimit(record.id);
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(6000);
  });

  it("enterprise keys have no monthly limit", () => {
    const { record } = createApiKey("test", "enterprise");
    const result = checkUsageLimit(record.id);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(0); // 0 = unlimited
  });
});

describe("incrementUsage", () => {
  it("increments counter", () => {
    const { record } = createApiKey("test", "pro");
    incrementUsage(record.id);
    incrementUsage(record.id);
    const result = checkUsageLimit(record.id);
    expect(result.used).toBe(2);
  });

  it("creates usage row on first increment", () => {
    const { record } = createApiKey("test", "pro");
    incrementUsage(record.id);
    const usage = getApiKeyUsage(record.id);
    expect(usage).toHaveLength(1);
    expect(usage[0].check_count).toBe(1);
  });
});

describe("checkKeyRateLimit", () => {
  it("allows requests under rate limit", () => {
    const { record } = createApiKey("test", "pro");
    expect(checkKeyRateLimit(record)).toBe(true);
  });

  it("blocks requests over rate limit", () => {
    const { record } = createApiKey("test", "pro");
    // Pro default: 200/min
    for (let i = 0; i < 200; i++) {
      checkKeyRateLimit(record);
    }
    expect(checkKeyRateLimit(record)).toBe(false);
  });
});

describe("listApiKeys", () => {
  it("returns all keys without full key", () => {
    createApiKey("key1", "pro");
    createApiKey("key2", "enterprise");
    const keys = listApiKeys();
    expect(keys).toHaveLength(2);
    expect(keys[0].label).toBe("key1");
    expect(keys[1].label).toBe("key2");
    // No full key exposed
    expect((keys[0] as any).key_hash).toBeUndefined();
  });
});

describe("revokeApiKey", () => {
  it("sets active to false", () => {
    const { record } = createApiKey("test", "pro");
    const result = revokeApiKey(record.id);
    expect(result).toBe(true);
    const keys = listApiKeys();
    expect(keys[0].active).toBe(false);
  });

  it("returns false for non-existent key", () => {
    expect(revokeApiKey(999)).toBe(false);
  });
});
