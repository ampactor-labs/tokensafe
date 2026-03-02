// ─── Types ───────────────────────────────────────────────────────────────────

export interface PolicyRule {
  id: string;
  field: string; // dotpath into TokenCheckResult
  operator: "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "in" | "contains";
  value: number | string | boolean | string[];
  action: "block" | "warn";
  message: string;
}

export interface Policy {
  name?: string;
  rules: PolicyRule[];
}

export interface PolicyViolation {
  rule_id: string;
  action: "block" | "warn";
  message: string;
  actual_value: unknown;
}

// ─── Default Policy ──────────────────────────────────────────────────────────

export const DEFAULT_POLICY: Policy = {
  name: "TokenSafe Default Policy",
  rules: [
    {
      id: "extreme_risk",
      field: "risk_score",
      operator: "gt",
      value: 80,
      action: "block",
      message: "Extreme risk score — likely scam or rug pull",
    },
    {
      id: "high_risk",
      field: "risk_score",
      operator: "gt",
      value: 60,
      action: "warn",
      message: "High risk score — proceed with caution",
    },
    {
      id: "no_liquidity",
      field: "checks.liquidity.has_liquidity",
      operator: "eq",
      value: false,
      action: "block",
      message: "No liquidity detected — cannot sell",
    },
    {
      id: "honeypot",
      field: "checks.honeypot.can_sell",
      operator: "eq",
      value: false,
      action: "block",
      message: "Honeypot detected — token cannot be sold",
    },
    {
      id: "active_mint_authority",
      field: "checks.mint_authority.status",
      operator: "eq",
      value: "ACTIVE",
      action: "warn",
      message: "Mint authority is active — supply can be inflated",
    },
    {
      id: "active_freeze_authority",
      field: "checks.freeze_authority.status",
      operator: "eq",
      value: "ACTIVE",
      action: "warn",
      message: "Freeze authority is active — tokens can be frozen",
    },
    {
      id: "permanent_delegate",
      field: "checks.token_2022_extensions",
      operator: "contains",
      value: "PermanentDelegate",
      action: "block",
      message:
        "PermanentDelegate extension present — tokens can be seized or burned",
    },
    {
      id: "high_transfer_fee",
      field: "score_breakdown.transfer_fee",
      operator: "gt",
      value: 0,
      action: "warn",
      message: "Transfer fee detected — hidden tax on every transfer",
    },
  ],
};

// ─── Field Resolution ────────────────────────────────────────────────────────

export function resolveField(obj: unknown, dotpath: string): unknown {
  const parts = dotpath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

function compare(
  actual: unknown,
  operator: PolicyRule["operator"],
  expected: PolicyRule["value"],
): boolean {
  if (actual === undefined || actual === null) return false;

  switch (operator) {
    case "gt":
      return typeof actual === "number" && actual > (expected as number);
    case "gte":
      return typeof actual === "number" && actual >= (expected as number);
    case "lt":
      return typeof actual === "number" && actual < (expected as number);
    case "lte":
      return typeof actual === "number" && actual <= (expected as number);
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual as string);
    case "contains": {
      if (Array.isArray(actual)) {
        // Check if any element's `name` field matches, or the element itself matches
        return actual.some(
          (item) =>
            item === expected ||
            (typeof item === "object" &&
              item !== null &&
              item.name === expected),
        );
      }
      if (typeof actual === "string") {
        return actual.includes(expected as string);
      }
      return false;
    }
  }
}

export function evaluatePolicy(
  result: unknown,
  policy: Policy = DEFAULT_POLICY,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  for (const rule of policy.rules) {
    const actual = resolveField(result, rule.field);
    if (compare(actual, rule.operator, rule.value)) {
      violations.push({
        rule_id: rule.id,
        action: rule.action,
        message: rule.message,
        actual_value: actual,
      });
    }
  }
  return violations;
}
