import { describe, it, expect, vi } from "vitest";
import { generateMarkdownReport } from "../src/utils/audit-report.js";
import type { AuditResultRow } from "../src/utils/db.js";

// Mock response-signer to avoid key generation in tests
vi.mock("../src/utils/response-signer.js", () => ({
  getSignerPubkey: () => "abc123deadbeef",
}));

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function makeAuditRow(overrides?: Partial<AuditResultRow>): AuditResultRow {
  const results = [
    {
      mint: WSOL,
      name: "Wrapped SOL",
      symbol: "SOL",
      risk_score: 15,
      risk_level: "LOW",
      checks: {
        mint_authority: { status: "RENOUNCED" },
        freeze_authority: { status: "RENOUNCED" },
        liquidity: { has_liquidity: true, liquidity_rating: "DEEP" },
        honeypot: { can_sell: true },
        is_token_2022: false,
      },
    },
  ];

  return {
    id: "test-audit-id-1234",
    api_key_id: 1,
    mints_json: JSON.stringify([WSOL]),
    policy_json: JSON.stringify({ name: "default", rules: [] }),
    results_json: JSON.stringify(results),
    violations_json: JSON.stringify([]),
    aggregate_risk_score: 15,
    attestation_hash: "hash123",
    attestation_signature: "sig456",
    created_at: "2026-03-01T00:00:00Z",
    expires_at: "2026-05-30T00:00:00Z",
    ...overrides,
  };
}

describe("generateMarkdownReport", () => {
  it("includes header with audit ID and dates", () => {
    const md = generateMarkdownReport(makeAuditRow());
    expect(md).toContain("# TokenSafe Compliance Report");
    expect(md).toContain("test-audit-id-1234");
    expect(md).toContain("2026-03-01T00:00:00Z");
    expect(md).toContain("2026-05-30T00:00:00Z");
  });

  it("includes executive summary with correct counts", () => {
    const md = generateMarkdownReport(makeAuditRow());
    expect(md).toContain("## Executive Summary");
    expect(md).toContain("**Tokens analyzed:** 1");
    expect(md).toContain("**Succeeded:** 1");
    expect(md).toContain("**Failed:** 0");
    expect(md).toContain("**Aggregate risk score:** 15.0");
  });

  it("includes risk distribution table", () => {
    const md = generateMarkdownReport(makeAuditRow());
    expect(md).toContain("## Risk Distribution");
    expect(md).toContain("| LOW | 1 |");
  });

  it("renders multiple risk levels in distribution", () => {
    const results = [
      {
        mint: WSOL,
        name: "SOL",
        symbol: "SOL",
        risk_score: 10,
        risk_level: "LOW",
        checks: {},
      },
      {
        mint: USDC,
        name: "USDC",
        symbol: "USDC",
        risk_score: 50,
        risk_level: "HIGH",
        checks: {},
      },
    ];
    const row = makeAuditRow({
      mints_json: JSON.stringify([WSOL, USDC]),
      results_json: JSON.stringify(results),
      aggregate_risk_score: 30,
    });
    const md = generateMarkdownReport(row);
    expect(md).toContain("| LOW | 1 |");
    expect(md).toContain("| HIGH | 1 |");
  });

  it("shows 0 violations when none exist", () => {
    const md = generateMarkdownReport(makeAuditRow());
    expect(md).toContain("**Policy violations:** 0 (0 block, 0 warn)");
    expect(md).not.toContain("## Policy Violations");
  });

  it("includes policy violations table when present", () => {
    const violations = [
      {
        rule_id: "extreme_risk",
        action: "block",
        message: "Risk score above 80",
        actual_value: 85,
      },
      {
        rule_id: "warn_high",
        action: "warn",
        message: "Risk score above 40",
        actual_value: 85,
      },
    ];
    const row = makeAuditRow({
      violations_json: JSON.stringify(violations),
    });
    const md = generateMarkdownReport(row);
    expect(md).toContain("## Policy Violations");
    expect(md).toContain("| extreme_risk | BLOCK |");
    expect(md).toContain("| warn_high | WARN |");
  });

  it("includes token details with check data", () => {
    const md = generateMarkdownReport(makeAuditRow());
    expect(md).toContain("## Token Details");
    expect(md).toContain(`### ${WSOL}`);
    expect(md).toContain("Wrapped SOL (SOL)");
    expect(md).toContain("**Risk score:** 15");
    expect(md).toContain("**Mint authority:** RENOUNCED");
    expect(md).toContain("**Freeze authority:** RENOUNCED");
    expect(md).toContain("**Liquidity:** Yes (DEEP)");
    expect(md).toContain("**Can sell:** true");
    expect(md).toContain("**Token-2022:** false");
  });

  it("renders error tokens correctly", () => {
    const results = [
      {
        mint: WSOL,
        status: "error" as const,
        error: { code: "TOKEN_NOT_FOUND", message: "Token not found on chain" },
      },
    ];
    const row = makeAuditRow({
      results_json: JSON.stringify(results),
    });
    const md = generateMarkdownReport(row);
    expect(md).toContain(`### ${WSOL}`);
    expect(md).toContain("**Error:** TOKEN_NOT_FOUND");
    expect(md).toContain("Token not found on chain");
  });

  it("includes attestation section", () => {
    const md = generateMarkdownReport(makeAuditRow());
    expect(md).toContain("## Attestation");
    expect(md).toContain("**Hash:** hash123");
    expect(md).toContain("**Signature:** sig456");
    expect(md).toContain("**Signer pubkey:** abc123deadbeef");
  });

  it("includes footer with methodology version", () => {
    const md = generateMarkdownReport(makeAuditRow());
    expect(md).toContain("Generated by TokenSafe v1.0.0");
    expect(md).toContain("informational purposes only");
  });

  it("handles tokens without checks gracefully", () => {
    const results = [
      {
        mint: WSOL,
        name: null,
        symbol: null,
        risk_score: 0,
        risk_level: "LOW",
      },
    ];
    const row = makeAuditRow({
      results_json: JSON.stringify(results),
    });
    const md = generateMarkdownReport(row);
    expect(md).toContain(`### ${WSOL}`);
    expect(md).toContain("**Risk score:** 0");
    expect(md).not.toContain("**Mint authority:**");
  });
});
