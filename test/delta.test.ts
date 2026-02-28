import { describe, it, expect } from "vitest";
import { detectChanges, generateAlerts } from "../src/analysis/delta.js";
import type { TokenCheckResult } from "../src/analysis/token-checker.js";

const WSOL = "So11111111111111111111111111111111111111112";

function makeCheckResult(
  overrides?: Partial<TokenCheckResult>,
): TokenCheckResult {
  return {
    mint: WSOL,
    name: "Wrapped SOL",
    symbol: "SOL",
    checked_at: "2026-02-27T00:00:00.000Z",
    cached_at: null,
    risk_score: 15,
    risk_level: "LOW",
    checks: {
      mint_authority: { status: "RENOUNCED", authority: null, risk: "SAFE" },
      freeze_authority: {
        status: "RENOUNCED",
        authority: null,
        risk: "SAFE",
      },
      supply: { total: "999999999", decimals: 9 },
      top_holders: {
        status: "OK" as const,
        top_10_percentage: 12.5,
        top_1_percentage: 3.2,
        holder_count_estimate: 50000,
        top_holders_detail: null,
        note: null,
        risk: "SAFE",
      },
      liquidity: {
        status: "OK" as const,
        has_liquidity: true,
        primary_pool: "Raydium",
        pool_address: null,
        price_impact_pct: 0.5,
        liquidity_rating: "DEEP",
        lp_locked: true,
        lp_lock_percentage: 95,
        lp_lock_expiry: null,
        lp_mint: null,
        lp_locker: null,
        risk: "SAFE",
      },
      metadata: {
        status: "OK" as const,
        update_authority: null,
        mutable: false,
        has_uri: true,
        uri: "https://example.com/meta.json",
        risk: "SAFE",
      },
      honeypot: {
        status: "OK" as const,
        can_sell: true,
        sell_tax_bps: null,
        note: null,
        risk: "SAFE",
      },
      token_age_hours: 8760,
      token_age_minutes: 525600,
      token_program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      is_token_2022: false,
      token_2022_extensions: null,
    },
    rpc_slot: 300000000,
    methodology_version: "1.0.0",
    risk_factors: [],
    summary: "No risk factors detected",
    degraded: false,
    response_signature: "deadbeef",
    signer_pubkey: "cafebabe",
    ...overrides,
  };
}

describe("detectChanges", () => {
  it("returns null when snapshots are identical", () => {
    const a = makeCheckResult();
    const b = makeCheckResult();
    expect(detectChanges(a, b)).toBeNull();
  });

  it("returns null when only non-tracked fields differ", () => {
    const a = makeCheckResult({ checked_at: "2026-01-01T00:00:00Z" });
    const b = makeCheckResult({
      checked_at: "2026-02-01T00:00:00Z",
      checks: {
        ...makeCheckResult().checks,
        token_age_hours: 9999,
        supply: { total: "1111111111", decimals: 9 },
      },
    });
    expect(detectChanges(a, b)).toBeNull();
  });

  it("detects mint authority RENOUNCED → ACTIVE as CRITICAL", () => {
    const prev = makeCheckResult();
    const curr = makeCheckResult({
      risk_score: 45,
      checks: {
        ...makeCheckResult().checks,
        mint_authority: {
          status: "ACTIVE",
          authority: "SomePubkey111",
          risk: "DANGEROUS",
        },
      },
    });
    const report = detectChanges(prev, curr)!;
    expect(report).not.toBeNull();
    const statusChange = report.changed_fields.find(
      (f) => f.path === "checks.mint_authority.status",
    );
    expect(statusChange).toBeDefined();
    expect(statusChange!.severity).toBe("CRITICAL");
    expect(statusChange!.previous).toBe("RENOUNCED");
    expect(statusChange!.current).toBe("ACTIVE");
  });

  it("detects freeze authority change as CRITICAL", () => {
    const prev = makeCheckResult();
    const curr = makeCheckResult({
      risk_score: 40,
      checks: {
        ...makeCheckResult().checks,
        freeze_authority: {
          status: "ACTIVE",
          authority: "FreezerPubkey",
          risk: "DANGEROUS",
        },
      },
    });
    const report = detectChanges(prev, curr)!;
    expect(report).not.toBeNull();
    const change = report.changed_fields.find(
      (f) => f.path === "checks.freeze_authority.status",
    );
    expect(change!.severity).toBe("CRITICAL");
  });

  it("detects top_10_percentage change > 5 pts as HIGH", () => {
    const prev = makeCheckResult();
    const curr = makeCheckResult({
      checks: {
        ...makeCheckResult().checks,
        top_holders: {
          ...makeCheckResult().checks.top_holders,
          top_10_percentage: 55,
        },
      },
    });
    const report = detectChanges(prev, curr)!;
    expect(report).not.toBeNull();
    const change = report.changed_fields.find(
      (f) => f.path === "checks.top_holders.top_10_percentage",
    );
    expect(change!.severity).toBe("HIGH");
  });

  it("ignores top_10_percentage change <= 5 pts", () => {
    const prev = makeCheckResult();
    const curr = makeCheckResult({
      checks: {
        ...makeCheckResult().checks,
        top_holders: {
          ...makeCheckResult().checks.top_holders,
          top_10_percentage: 16.0, // delta = 3.5 from 12.5
        },
      },
    });
    expect(detectChanges(prev, curr)).toBeNull();
  });

  it("detects liquidity disappearing as CRITICAL", () => {
    const prev = makeCheckResult();
    const curr = makeCheckResult({
      risk_score: 45,
      checks: {
        ...makeCheckResult().checks,
        liquidity: {
          has_liquidity: false,
          primary_pool: null,
          pool_address: null,
          price_impact_pct: null,
          liquidity_rating: null,
          lp_locked: null,
          lp_lock_percentage: null,
          lp_lock_expiry: null,
          lp_mint: null,
          lp_locker: null,
          risk: "CRITICAL",
        },
      },
    });
    const report = detectChanges(prev, curr)!;
    expect(report).not.toBeNull();
    const change = report.changed_fields.find(
      (f) => f.path === "checks.liquidity.has_liquidity",
    );
    expect(change!.severity).toBe("CRITICAL");
  });

  it("does not flag liquidity appearing (false → true)", () => {
    const prev = makeCheckResult({
      checks: {
        ...makeCheckResult().checks,
        liquidity: {
          has_liquidity: false,
          primary_pool: null,
          pool_address: null,
          price_impact_pct: null,
          liquidity_rating: null,
          lp_locked: null,
          lp_lock_percentage: null,
          lp_lock_expiry: null,
          lp_mint: null,
          lp_locker: null,
          risk: "CRITICAL",
        },
      },
    });
    const curr = makeCheckResult(); // has_liquidity = true
    // Liquidity appearing is good — no change flagged for that rule
    const report = detectChanges(prev, curr);
    if (report) {
      const liqChange = report.changed_fields.find(
        (f) => f.path === "checks.liquidity.has_liquidity",
      );
      expect(liqChange).toBeUndefined();
    }
  });

  it("detects honeypot can_sell true → false as CRITICAL", () => {
    const prev = makeCheckResult();
    const curr = makeCheckResult({
      risk_score: 45,
      checks: {
        ...makeCheckResult().checks,
        honeypot: {
          status: "OK" as const,
          can_sell: false,
          sell_tax_bps: null,
          note: null,
          risk: "DANGEROUS",
        },
      },
    });
    const report = detectChanges(prev, curr)!;
    expect(report).not.toBeNull();
    const change = report.changed_fields.find(
      (f) => f.path === "checks.honeypot.can_sell",
    );
    expect(change!.severity).toBe("CRITICAL");
  });

  it("detects sell_tax_bps appearing as HIGH", () => {
    const prev = makeCheckResult();
    const curr = makeCheckResult({
      checks: {
        ...makeCheckResult().checks,
        honeypot: {
          status: "OK" as const,
          can_sell: true,
          sell_tax_bps: 1000,
          note: null,
          risk: "SAFE",
        },
      },
    });
    const report = detectChanges(prev, curr)!;
    expect(report).not.toBeNull();
    const change = report.changed_fields.find(
      (f) => f.path === "checks.honeypot.sell_tax_bps",
    );
    expect(change!.severity).toBe("HIGH");
  });

  it("detects metadata becoming mutable as WARNING", () => {
    const prev = makeCheckResult();
    const curr = makeCheckResult({
      checks: {
        ...makeCheckResult().checks,
        metadata: {
          update_authority: null,
          mutable: true,
          has_uri: true,
          uri: "https://example.com/meta.json",
          risk: "WARNING",
        },
      },
    });
    const report = detectChanges(prev, curr)!;
    expect(report).not.toBeNull();
    const change = report.changed_fields.find(
      (f) => f.path === "checks.metadata.mutable",
    );
    expect(change!.severity).toBe("WARNING");
  });

  it("does not flag metadata becoming immutable (true → false)", () => {
    const prev = makeCheckResult({
      checks: {
        ...makeCheckResult().checks,
        metadata: {
          update_authority: null,
          mutable: true,
          has_uri: true,
          uri: "https://example.com/meta.json",
          risk: "WARNING",
        },
      },
    });
    const curr = makeCheckResult(); // mutable = false
    const report = detectChanges(prev, curr);
    if (report) {
      const metaChange = report.changed_fields.find(
        (f) => f.path === "checks.metadata.mutable",
      );
      expect(metaChange).toBeUndefined();
    }
  });

  it("includes risk_score_delta in report", () => {
    const prev = makeCheckResult({ risk_score: 10 });
    const curr = makeCheckResult({
      risk_score: 45,
      checks: {
        ...makeCheckResult().checks,
        mint_authority: {
          status: "ACTIVE",
          authority: "X",
          risk: "DANGEROUS",
        },
      },
    });
    const report = detectChanges(prev, curr)!;
    expect(report.risk_score_delta).toBe(35);
    expect(report.previous_risk_score).toBe(10);
  });

  it("returns ChangeReport when risk_score_delta > 10 even with no field changes", () => {
    // Simulate a case where risk score changed significantly but no tracked
    // fields triggered — e.g. Token-2022 extension scoring changes
    const prev = makeCheckResult({ risk_score: 10 });
    const curr = makeCheckResult({ risk_score: 25 });
    const report = detectChanges(prev, curr);
    expect(report).not.toBeNull();
    expect(report!.risk_score_delta).toBe(15);
    expect(report!.changed_fields).toHaveLength(0);
  });

  it("returns null when risk_score_delta <= 10 and no field changes", () => {
    const prev = makeCheckResult({ risk_score: 10 });
    const curr = makeCheckResult({ risk_score: 18 });
    expect(detectChanges(prev, curr)).toBeNull();
  });

  // --- LP lock changes ---
  it("detects LP unlock (true → false) as CRITICAL", () => {
    const prev = makeCheckResult();
    const curr = makeCheckResult({
      risk_score: 30,
      checks: {
        ...makeCheckResult().checks,
        liquidity: {
          ...makeCheckResult().checks.liquidity!,
          lp_locked: false,
          lp_lock_percentage: 0,
        },
      },
    });
    const report = detectChanges(prev, curr)!;
    expect(report).not.toBeNull();
    const change = report.changed_fields.find(
      (f) => f.path === "checks.liquidity.lp_locked",
    );
    expect(change).toBeDefined();
    expect(change!.severity).toBe("CRITICAL");
  });

  it("detects LP lock percentage drop > 20 pts as HIGH", () => {
    const prev = makeCheckResult();
    const curr = makeCheckResult({
      checks: {
        ...makeCheckResult().checks,
        liquidity: {
          ...makeCheckResult().checks.liquidity!,
          lp_lock_percentage: 50,
        },
      },
    });
    const report = detectChanges(prev, curr)!;
    expect(report).not.toBeNull();
    const change = report.changed_fields.find(
      (f) => f.path === "checks.liquidity.lp_lock_percentage",
    );
    expect(change).toBeDefined();
    expect(change!.severity).toBe("HIGH");
  });

  it("detects price impact spike > 10 pts as HIGH", () => {
    const prev = makeCheckResult();
    const curr = makeCheckResult({
      checks: {
        ...makeCheckResult().checks,
        liquidity: {
          ...makeCheckResult().checks.liquidity!,
          price_impact_pct: 15,
        },
      },
    });
    const report = detectChanges(prev, curr)!;
    expect(report).not.toBeNull();
    const change = report.changed_fields.find(
      (f) => f.path === "checks.liquidity.price_impact_pct",
    );
    expect(change).toBeDefined();
    expect(change!.severity).toBe("HIGH");
  });

  it("detects liquidity rating degradation as HIGH", () => {
    const prev = makeCheckResult();
    const curr = makeCheckResult({
      checks: {
        ...makeCheckResult().checks,
        liquidity: {
          ...makeCheckResult().checks.liquidity!,
          liquidity_rating: "SHALLOW",
        },
      },
    });
    const report = detectChanges(prev, curr)!;
    expect(report).not.toBeNull();
    const change = report.changed_fields.find(
      (f) => f.path === "checks.liquidity.liquidity_rating",
    );
    expect(change).toBeDefined();
    expect(change!.severity).toBe("HIGH");
  });

  it("ignores small LP lock percentage changes (<= 20 pts)", () => {
    const prev = makeCheckResult();
    const curr = makeCheckResult({
      checks: {
        ...makeCheckResult().checks,
        liquidity: {
          ...makeCheckResult().checks.liquidity!,
          lp_lock_percentage: 80,
        },
      },
    });
    // 95 → 80 = 15 pts drop, should not trigger
    expect(detectChanges(prev, curr)).toBeNull();
  });
});

describe("generateAlerts", () => {
  it("returns empty array when changes is null", () => {
    expect(generateAlerts(WSOL, "SOL", null)).toEqual([]);
  });

  it("generates CRITICAL alert for mint authority change", () => {
    const prev = makeCheckResult();
    const curr = makeCheckResult({
      risk_score: 45,
      checks: {
        ...makeCheckResult().checks,
        mint_authority: {
          status: "ACTIVE",
          authority: "X",
          risk: "DANGEROUS",
        },
      },
    });
    const changes = detectChanges(prev, curr)!;
    const alerts = generateAlerts(WSOL, "SOL", changes);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].severity).toBe("CRITICAL");
    expect(alerts[0].message).toContain("Mint authority");
  });

  it("generates CRITICAL alert for liquidity loss", () => {
    const prev = makeCheckResult();
    const curr = makeCheckResult({
      risk_score: 45,
      checks: {
        ...makeCheckResult().checks,
        liquidity: {
          has_liquidity: false,
          primary_pool: null,
          pool_address: null,
          price_impact_pct: null,
          liquidity_rating: null,
          lp_locked: null,
          lp_lock_percentage: null,
          lp_lock_expiry: null,
          lp_mint: null,
          lp_locker: null,
          risk: "CRITICAL",
        },
      },
    });
    const changes = detectChanges(prev, curr)!;
    const alerts = generateAlerts(WSOL, "SOL", changes);
    const liqAlert = alerts.find((a) => a.message.includes("Liquidity"));
    expect(liqAlert).toBeDefined();
    expect(liqAlert!.severity).toBe("CRITICAL");
  });

  it("generates CRITICAL alert for LP unlock", () => {
    const prev = makeCheckResult();
    const curr = makeCheckResult({
      risk_score: 30,
      checks: {
        ...makeCheckResult().checks,
        liquidity: {
          ...makeCheckResult().checks.liquidity!,
          lp_locked: false,
          lp_lock_percentage: 0,
        },
      },
    });
    const changes = detectChanges(prev, curr)!;
    const alerts = generateAlerts(WSOL, "SOL", changes);
    const lpAlert = alerts.find((a) => a.message.includes("LP unlocked"));
    expect(lpAlert).toBeDefined();
    expect(lpAlert!.severity).toBe("CRITICAL");
  });

  it("generates risk score delta alert when no field changes explain it", () => {
    const prev = makeCheckResult({ risk_score: 10 });
    const curr = makeCheckResult({ risk_score: 25 });
    const changes = detectChanges(prev, curr)!;
    const alerts = generateAlerts(WSOL, "SOL", changes);
    expect(alerts.length).toBe(1);
    expect(alerts[0].message).toContain("Risk score increased");
    expect(alerts[0].message).toContain("10");
    expect(alerts[0].message).toContain("25");
  });

  it("does not generate risk score alert when field changes explain it", () => {
    const prev = makeCheckResult({ risk_score: 15 });
    const curr = makeCheckResult({
      risk_score: 45,
      checks: {
        ...makeCheckResult().checks,
        mint_authority: {
          status: "ACTIVE",
          authority: "X",
          risk: "DANGEROUS",
        },
      },
    });
    const changes = detectChanges(prev, curr)!;
    const alerts = generateAlerts(WSOL, "SOL", changes);
    // Should have alerts for authority changes but NOT a generic risk score alert
    const riskAlert = alerts.find((a) => a.message.includes("Risk score"));
    expect(riskAlert).toBeUndefined();
  });

  it("sorts alerts CRITICAL first", () => {
    const prev = makeCheckResult();
    const curr = makeCheckResult({
      risk_score: 80,
      checks: {
        ...makeCheckResult().checks,
        mint_authority: {
          status: "ACTIVE",
          authority: "X",
          risk: "DANGEROUS",
        },
        top_holders: {
          ...makeCheckResult().checks.top_holders,
          top_10_percentage: 60,
        },
      },
    });
    const changes = detectChanges(prev, curr)!;
    const alerts = generateAlerts(WSOL, "SOL", changes);
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    // First alert should be CRITICAL (authority), not HIGH (holders)
    expect(alerts[0].severity).toBe("CRITICAL");
  });
});
