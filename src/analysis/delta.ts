import type { TokenCheckResult } from "./token-checker.js";

export type ChangeSeverity = "INFO" | "WARNING" | "HIGH" | "CRITICAL";

export interface FieldChange {
  path: string;
  previous: unknown;
  current: unknown;
  severity: ChangeSeverity;
}

export interface ChangeReport {
  previous_checked_at: string;
  risk_score_delta: number;
  previous_risk_score: number;
  previous_risk_level: string;
  changed_fields: FieldChange[];
}

export interface MonitorAlert {
  mint: string;
  symbol: string | null;
  severity: ChangeSeverity;
  message: string;
}

interface ChangeRule {
  path: string;
  extract: (r: TokenCheckResult) => unknown;
  isSignificant: (prev: unknown, curr: unknown) => boolean;
  severity: ChangeSeverity;
}

const RISK_ORDER = ["SAFE", "HIGH", "CRITICAL"];

function riskWorsened(prev: string, curr: string): boolean {
  return RISK_ORDER.indexOf(curr) > RISK_ORDER.indexOf(prev);
}

const CHANGE_RULES: ChangeRule[] = [
  // Authority changes — highest severity
  {
    path: "checks.mint_authority.status",
    extract: (r) => r.checks.mint_authority.status,
    isSignificant: (p, c) => p !== c,
    severity: "CRITICAL",
  },
  {
    path: "checks.mint_authority.authority",
    extract: (r) => r.checks.mint_authority.authority,
    isSignificant: (p, c) => p !== c,
    severity: "CRITICAL",
  },
  {
    path: "checks.freeze_authority.status",
    extract: (r) => r.checks.freeze_authority.status,
    isSignificant: (p, c) => p !== c,
    severity: "CRITICAL",
  },
  {
    path: "checks.freeze_authority.authority",
    extract: (r) => r.checks.freeze_authority.authority,
    isSignificant: (p, c) => p !== c,
    severity: "CRITICAL",
  },

  // Holder concentration — absolute delta > 5 percentage points
  {
    path: "checks.top_holders.top_10_percentage",
    extract: (r) => r.checks.top_holders.top_10_percentage,
    isSignificant: (p, c) =>
      typeof p === "number" &&
      typeof c === "number" &&
      Math.abs(c - p) > 5.0,
    severity: "HIGH",
  },
  {
    path: "checks.top_holders.top_1_percentage",
    extract: (r) => r.checks.top_holders.top_1_percentage,
    isSignificant: (p, c) =>
      typeof p === "number" &&
      typeof c === "number" &&
      Math.abs(c - p) > 5.0,
    severity: "HIGH",
  },
  {
    path: "checks.top_holders.risk",
    extract: (r) => r.checks.top_holders.risk,
    isSignificant: (p, c) =>
      typeof p === "string" &&
      typeof c === "string" &&
      p !== c &&
      riskWorsened(p, c),
    severity: "WARNING",
  },

  // Liquidity — loss is critical
  {
    path: "checks.liquidity.has_liquidity",
    extract: (r) => r.checks.liquidity?.has_liquidity ?? null,
    isSignificant: (p, c) => p === true && c === false,
    severity: "CRITICAL",
  },
  // LP lock removed — rug vector
  {
    path: "checks.liquidity.lp_locked",
    extract: (r) => r.checks.liquidity?.lp_locked ?? null,
    isSignificant: (p, c) => p === true && c === false,
    severity: "CRITICAL",
  },
  // LP lock percentage dropped significantly
  {
    path: "checks.liquidity.lp_lock_percentage",
    extract: (r) => r.checks.liquidity?.lp_lock_percentage ?? null,
    isSignificant: (p, c) =>
      typeof p === "number" &&
      typeof c === "number" &&
      p - c > 20,
    severity: "HIGH",
  },
  // Price impact spike — liquidity draining
  {
    path: "checks.liquidity.price_impact_pct",
    extract: (r) => r.checks.liquidity?.price_impact_pct ?? null,
    isSignificant: (p, c) =>
      typeof p === "number" &&
      typeof c === "number" &&
      c - p > 10,
    severity: "HIGH",
  },
  // Liquidity rating degradation
  {
    path: "checks.liquidity.liquidity_rating",
    extract: (r) => r.checks.liquidity?.liquidity_rating ?? null,
    isSignificant: (p, c) => {
      const order = ["DEEP", "MODERATE", "SHALLOW", "NONE"];
      if (typeof p !== "string" || typeof c !== "string") return false;
      return order.indexOf(c) > order.indexOf(p) && order.indexOf(p) >= 0;
    },
    severity: "HIGH",
  },

  // Metadata mutability — becoming mutable is a warning
  {
    path: "checks.metadata.mutable",
    extract: (r) => r.checks.metadata?.mutable ?? null,
    isSignificant: (p, c) => p === false && c === true,
    severity: "WARNING",
  },

  // Honeypot — becoming unsellable is critical
  {
    path: "checks.honeypot.can_sell",
    extract: (r) => r.checks.honeypot?.can_sell ?? null,
    isSignificant: (p, c) => p === true && c === false,
    severity: "CRITICAL",
  },
  {
    path: "checks.honeypot.sell_tax_bps",
    extract: (r) => r.checks.honeypot?.sell_tax_bps ?? null,
    isSignificant: (p, c) => {
      if (p === null && c !== null && (c as number) > 0) return true;
      if (
        typeof p === "number" &&
        typeof c === "number" &&
        c - p > 500
      )
        return true;
      return false;
    },
    severity: "HIGH",
  },
];

export function detectChanges(
  previous: TokenCheckResult,
  current: TokenCheckResult,
): ChangeReport | null {
  const changedFields: FieldChange[] = [];

  for (const rule of CHANGE_RULES) {
    const prevVal = rule.extract(previous);
    const currVal = rule.extract(current);

    if (rule.isSignificant(prevVal, currVal)) {
      changedFields.push({
        path: rule.path,
        previous: prevVal,
        current: currVal,
        severity: rule.severity,
      });
    }
  }

  const riskDelta = current.risk_score - previous.risk_score;

  // No field changes and risk delta is small — nothing to report
  if (changedFields.length === 0 && Math.abs(riskDelta) <= 10) {
    return null;
  }

  return {
    previous_checked_at: previous.checked_at,
    risk_score_delta: riskDelta,
    previous_risk_score: previous.risk_score,
    previous_risk_level: previous.risk_level,
    changed_fields: changedFields,
  };
}

function formatBps(val: unknown): string {
  if (val === null || val === undefined) return "none";
  return `${((val as number) / 100).toFixed(1)}%`;
}

function formatChangeMessage(change: FieldChange): string {
  switch (change.path) {
    case "checks.mint_authority.status":
      return `Mint authority changed from ${change.previous} to ${change.current}`;
    case "checks.mint_authority.authority":
      return `Mint authority address changed`;
    case "checks.freeze_authority.status":
      return `Freeze authority changed from ${change.previous} to ${change.current}`;
    case "checks.freeze_authority.authority":
      return `Freeze authority address changed`;
    case "checks.liquidity.has_liquidity":
      return "Liquidity lost — token may no longer be sellable";
    case "checks.liquidity.lp_locked":
      return "LP unlocked — liquidity can now be pulled";
    case "checks.liquidity.lp_lock_percentage":
      return `LP lock dropped from ${change.previous}% to ${change.current}%`;
    case "checks.liquidity.price_impact_pct":
      return `Liquidity depth degraded — price impact went from ${change.previous}% to ${change.current}%`;
    case "checks.liquidity.liquidity_rating":
      return `Liquidity rating degraded from ${change.previous} to ${change.current}`;
    case "checks.honeypot.can_sell":
      return "Token is no longer sellable (honeypot detected)";
    case "checks.top_holders.top_1_percentage":
      return `Top holder concentration changed from ${change.previous}% to ${change.current}%`;
    case "checks.top_holders.top_10_percentage":
      return `Top 10 holder concentration changed from ${change.previous}% to ${change.current}%`;
    case "checks.honeypot.sell_tax_bps":
      return `Sell tax changed from ${formatBps(change.previous)} to ${formatBps(change.current)}`;
    case "checks.metadata.mutable":
      return "Metadata became mutable — token name/image can now be changed";
    default: {
      const fieldName = change.path.split(".").pop() ?? change.path;
      return `${fieldName} changed from ${JSON.stringify(change.previous)} to ${JSON.stringify(change.current)}`;
    }
  }
}

const SEVERITY_ORDER: ChangeSeverity[] = [
  "CRITICAL",
  "HIGH",
  "WARNING",
  "INFO",
];

export function generateAlerts(
  mint: string,
  symbol: string | null,
  changes: ChangeReport | null,
): MonitorAlert[] {
  if (!changes) return [];

  const alerts: MonitorAlert[] = [];

  for (const change of changes.changed_fields) {
    if (change.severity === "CRITICAL" || change.severity === "HIGH") {
      alerts.push({
        mint,
        symbol,
        severity: change.severity,
        message: formatChangeMessage(change),
      });
    }
  }

  // Risk score delta alert if significant and not already explained by field changes
  if (Math.abs(changes.risk_score_delta) > 10 && changes.changed_fields.length === 0) {
    const direction =
      changes.risk_score_delta > 0 ? "increased" : "decreased";
    const newScore =
      changes.previous_risk_score + changes.risk_score_delta;
    alerts.push({
      mint,
      symbol,
      severity: changes.risk_score_delta > 0 ? "HIGH" : "INFO",
      message: `Risk score ${direction} from ${changes.previous_risk_score} to ${newScore}`,
    });
  }

  // Sort by severity: CRITICAL first
  alerts.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) -
      SEVERITY_ORDER.indexOf(b.severity),
  );

  return alerts;
}
