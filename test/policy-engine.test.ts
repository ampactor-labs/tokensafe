import { describe, it, expect } from "vitest";
import {
  DEFAULT_POLICY,
  evaluatePolicy,
  resolveField,
  type Policy,
} from "../src/analysis/policy-engine.js";

describe("DEFAULT_POLICY", () => {
  it("has 8 rules", () => {
    expect(DEFAULT_POLICY.rules).toHaveLength(8);
  });
});

describe("resolveField", () => {
  it("resolves top-level field", () => {
    expect(resolveField({ risk_score: 42 }, "risk_score")).toBe(42);
  });

  it("resolves nested dotpath", () => {
    const obj = { checks: { mint_authority: { status: "ACTIVE" } } };
    expect(resolveField(obj, "checks.mint_authority.status")).toBe("ACTIVE");
  });

  it("returns undefined for missing field", () => {
    expect(resolveField({ a: 1 }, "b.c.d")).toBeUndefined();
  });

  it("returns undefined for null intermediate", () => {
    expect(resolveField({ a: null }, "a.b")).toBeUndefined();
  });

  it("handles array field", () => {
    const obj = { items: [{ name: "PermanentDelegate" }] };
    expect(resolveField(obj, "items")).toEqual([{ name: "PermanentDelegate" }]);
  });
});

describe("evaluatePolicy", () => {
  const cleanToken = {
    risk_score: 5,
    risk_level: "LOW",
    checks: {
      mint_authority: { status: "RENOUNCED", authority: null, risk: "SAFE" },
      freeze_authority: { status: "RENOUNCED", authority: null, risk: "SAFE" },
      liquidity: { has_liquidity: true, liquidity_rating: "DEEP" },
      honeypot: { can_sell: true, status: "OK" },
      is_token_2022: false,
      token_2022_extensions: null,
    },
    score_breakdown: {},
  };

  it("returns empty for clean token", () => {
    const violations = evaluatePolicy(cleanToken);
    expect(violations).toEqual([]);
  });

  it("extreme_risk rule blocks score > 80", () => {
    const result = { ...cleanToken, risk_score: 85 };
    const violations = evaluatePolicy(result);
    const extreme = violations.find((v) => v.rule_id === "extreme_risk");
    expect(extreme).toBeDefined();
    expect(extreme!.action).toBe("block");
    expect(extreme!.actual_value).toBe(85);
  });

  it("high_risk rule warns score > 60", () => {
    const result = { ...cleanToken, risk_score: 65 };
    const violations = evaluatePolicy(result);
    const high = violations.find((v) => v.rule_id === "high_risk");
    expect(high).toBeDefined();
    expect(high!.action).toBe("warn");
  });

  it("no_liquidity rule blocks when has_liquidity is false", () => {
    const result = {
      ...cleanToken,
      checks: {
        ...cleanToken.checks,
        liquidity: { has_liquidity: false },
      },
    };
    const violations = evaluatePolicy(result);
    const noLiq = violations.find((v) => v.rule_id === "no_liquidity");
    expect(noLiq).toBeDefined();
    expect(noLiq!.action).toBe("block");
  });

  it("honeypot rule blocks can_sell=false", () => {
    const result = {
      ...cleanToken,
      checks: {
        ...cleanToken.checks,
        honeypot: { can_sell: false, status: "OK" },
      },
    };
    const violations = evaluatePolicy(result);
    const hp = violations.find((v) => v.rule_id === "honeypot");
    expect(hp).toBeDefined();
    expect(hp!.action).toBe("block");
  });

  it("active_mint_authority warns", () => {
    const result = {
      ...cleanToken,
      checks: {
        ...cleanToken.checks,
        mint_authority: {
          status: "ACTIVE",
          authority: "SomeKey",
          risk: "DANGEROUS",
        },
      },
    };
    const violations = evaluatePolicy(result);
    const ma = violations.find((v) => v.rule_id === "active_mint_authority");
    expect(ma).toBeDefined();
    expect(ma!.action).toBe("warn");
  });

  it("permanent_delegate blocks", () => {
    const result = {
      ...cleanToken,
      checks: {
        ...cleanToken.checks,
        token_2022_extensions: [
          { name: "PermanentDelegate", permanent_delegate: "SomeAddr" },
        ],
      },
    };
    const violations = evaluatePolicy(result);
    const pd = violations.find((v) => v.rule_id === "permanent_delegate");
    expect(pd).toBeDefined();
    expect(pd!.action).toBe("block");
  });

  it("custom policy overrides default", () => {
    const customPolicy: Policy = {
      name: "strict",
      rules: [
        {
          id: "ultra_strict",
          field: "risk_score",
          operator: "gt",
          value: 10,
          action: "block",
          message: "Too risky for us",
        },
      ],
    };
    const result = { ...cleanToken, risk_score: 15 };
    const violations = evaluatePolicy(result, customPolicy);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule_id).toBe("ultra_strict");
  });

  it("returns multiple violations from one token", () => {
    const result = {
      ...cleanToken,
      risk_score: 90,
      checks: {
        ...cleanToken.checks,
        mint_authority: {
          status: "ACTIVE",
          authority: "Key",
          risk: "DANGEROUS",
        },
        liquidity: { has_liquidity: false },
      },
    };
    const violations = evaluatePolicy(result);
    expect(violations.length).toBeGreaterThan(2);
  });

  it("high_transfer_fee warns when score_breakdown has transfer_fee", () => {
    const result = {
      ...cleanToken,
      score_breakdown: { transfer_fee: 10 },
    };
    const violations = evaluatePolicy(result);
    const tf = violations.find((v) => v.rule_id === "high_transfer_fee");
    expect(tf).toBeDefined();
    expect(tf!.action).toBe("warn");
  });
});
