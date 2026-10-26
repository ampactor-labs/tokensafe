import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  initTestDb,
  closeDb,
  getDb,
  migrate,
  createSubscription,
  createDelivery,
  updateSubscription,
  getPendingDeliveries,
  getAlertedLevel,
  touchSubscriptionCheckedAt,
} from "../src/utils/db.js";

vi.mock("../src/analysis/token-checker.js", () => ({
  checkTokenLite: vi.fn(),
}));
vi.mock("../src/utils/webhook-delivery.js", () => ({
  processDeliveryQueue: vi.fn(),
}));

import { checkTokenLite } from "../src/analysis/token-checker.js";
import { decideAlert, runMonitorCycle } from "../src/utils/monitor-job.js";

const mockCheck = vi.mocked(checkTokenLite);

const A = "So11111111111111111111111111111111111111112";
const B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const HMAC_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** The next poll sees these [score, level] pairs; a missing mint fails its check. */
function poll(scores: Record<string, [number, string]>) {
  mockCheck.mockImplementation(async (mint: string) => {
    const s = scores[mint];
    if (!s) throw new Error("rpc unavailable");
    return {
      result: { mint, risk_score: s[0], risk_level: s[1], summary: "test" },
      fromCache: false,
    } as unknown as Awaited<ReturnType<typeof checkTokenLite>>;
  });
  return runMonitorCycle();
}

function sent() {
  return getPendingDeliveries().map((d) => ({
    sub: d.subscription_id,
    mint: d.mint,
    ...(JSON.parse(d.payload_json) as {
      reason: string;
      risk_level: string;
      threshold: number;
    }),
  }));
}

function subscribe(mints: string[], threshold: number) {
  return createSubscription("https://example.com/hook", mints, threshold, HMAC_KEY);
}

beforeEach(() => {
  closeDb();
  initTestDb();
  mockCheck.mockReset();
});

describe("decideAlert", () => {
  it("does nothing below the threshold and clears any state", () => {
    expect(decideAlert("HIGH", 49, "HIGH", 50)).toEqual({ reason: null, nextLevel: null });
  });

  it("alerts when the score reaches the threshold", () => {
    expect(decideAlert(null, 50, "HIGH", 50)).toEqual({ reason: "crossed", nextLevel: "HIGH" });
  });

  it("stays quiet at the level already reported", () => {
    expect(decideAlert("HIGH", 55, "HIGH", 50)).toEqual({ reason: null, nextLevel: "HIGH" });
  });

  it("alerts when the level climbs past the worst reported", () => {
    expect(decideAlert("HIGH", 70, "CRITICAL", 50)).toEqual({
      reason: "escalated",
      nextLevel: "CRITICAL",
    });
  });

  it("keeps the worst level when the level eases while still above", () => {
    expect(decideAlert("CRITICAL", 55, "HIGH", 50)).toEqual({
      reason: null,
      nextLevel: "CRITICAL",
    });
  });
});

describe("runMonitorCycle", () => {
  it("alerts once when a score sits at the threshold, not on every poll", async () => {
    subscribe([A], 50);
    await poll({ [A]: [50, "HIGH"] });
    await poll({ [A]: [50, "HIGH"] });
    await poll({ [A]: [50, "HIGH"] });

    const d = sent();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ mint: A, reason: "crossed", risk_level: "HIGH", threshold: 50 });
  });

  it("re-alerts only when the level climbs past the worst reported", async () => {
    subscribe([A], 50);
    await poll({ [A]: [55, "HIGH"] });
    await poll({ [A]: [70, "CRITICAL"] });
    await poll({ [A]: [55, "HIGH"] });
    await poll({ [A]: [70, "CRITICAL"] });

    expect(sent().map((d) => [d.reason, d.risk_level])).toEqual([
      ["crossed", "HIGH"],
      ["escalated", "CRITICAL"],
    ]);
  });

  it("re-arms once the score drops below the threshold", async () => {
    const sub = subscribe([A], 50);
    await poll({ [A]: [60, "HIGH"] });
    await poll({ [A]: [30, "MODERATE"] });
    expect(getAlertedLevel(sub.id, A)).toBeNull();
    await poll({ [A]: [60, "HIGH"] });

    expect(sent().map((d) => d.reason)).toEqual(["crossed", "crossed"]);
  });

  it("keeps its state through a failed check", async () => {
    subscribe([A], 50);
    await poll({ [A]: [60, "HIGH"] });
    await poll({});
    await poll({ [A]: [60, "HIGH"] });

    expect(sent()).toHaveLength(1);
  });

  it("tracks each mint of a subscription separately", async () => {
    subscribe([A, B], 50);
    await poll({ [A]: [60, "HIGH"], [B]: [10, "LOW"] });
    await poll({ [A]: [60, "HIGH"], [B]: [60, "HIGH"] });

    expect(sent().map((d) => [d.mint, d.reason])).toEqual([
      [A, "crossed"],
      [B, "crossed"],
    ]);
  });

  it("tracks subscriptions on the same mint separately", async () => {
    const low = subscribe([A], 50);
    const high = subscribe([A], 70);
    await poll({ [A]: [60, "HIGH"] });
    await poll({ [A]: [75, "CRITICAL"] });

    expect(sent().map((d) => [d.sub, d.reason])).toEqual([
      [low.id, "crossed"],
      [low.id, "escalated"],
      [high.id, "crossed"],
    ]);
  });

  it("re-arms on a threshold, mint or pause change, but not a callback change", async () => {
    const sub = subscribe([A], 50);
    const above = { [A]: [60, "HIGH"] as [number, string] };
    await poll(above);
    expect(sent()).toHaveLength(1);

    updateSubscription(sub.id, { callback_url: "https://example.com/other" });
    await poll(above);
    expect(sent()).toHaveLength(1);

    updateSubscription(sub.id, { threshold: 50 }); // unchanged value
    await poll(above);
    expect(sent()).toHaveLength(1);

    updateSubscription(sub.id, { threshold: 55 });
    await poll(above);
    expect(sent()).toHaveLength(2);

    updateSubscription(sub.id, { mints: [A, B] });
    await poll({ ...above, [B]: [10, "LOW"] });
    expect(sent()).toHaveLength(3);

    updateSubscription(sub.id, { active: false });
    await poll(above);
    expect(sent()).toHaveLength(3); // paused subscriptions aren't polled
    updateSubscription(sub.id, { active: true });
    await poll(above);
    expect(sent()).toHaveLength(4);
  });
});

describe("migrate", () => {
  function deliver(subId: number, mint: string, level: string, age: string | null) {
    const d = createDelivery(subId, mint, JSON.stringify({ mint, risk_level: level }));
    if (age) {
      getDb()
        .prepare("UPDATE webhook_deliveries SET delivered_at = datetime('now', ?) WHERE id = ?")
        .run(age, d.id);
    }
  }

  it("seeds pairs whose latest delivery came from the latest poll, once", async () => {
    const current = subscribe([A], 50); // alerted on its last poll
    const stale = subscribe([B], 50); // last alerted a month ago
    deliver(current.id, A, "HIGH", "-1 hour"); // an earlier poll
    deliver(current.id, A, "HIGH", null); // its latest poll
    deliver(stale.id, B, "HIGH", "-30 days");
    touchSubscriptionCheckedAt(current.id);
    touchSubscriptionCheckedAt(stale.id);
    // History, not news: keep it out of sent().
    getDb().exec("UPDATE webhook_deliveries SET status = 'delivered'");

    getDb().pragma("user_version = 0");
    migrate(getDb());

    expect(getAlertedLevel(current.id, A)).toBe("HIGH");
    expect(getAlertedLevel(stale.id, B)).toBeNull();

    // Both are above now: only the stale one is news.
    await poll({ [A]: [50, "HIGH"], [B]: [60, "HIGH"] });
    expect(sent().map((d) => [d.sub, d.reason])).toEqual([[stale.id, "crossed"]]);

    // Once a seeded pair re-arms, a later migrate() must not seed it again.
    await poll({ [A]: [10, "LOW"], [B]: [60, "HIGH"] });
    migrate(getDb());
    expect(getAlertedLevel(current.id, A)).toBeNull();
  });

  it("skips mints the subscription no longer watches", () => {
    const sub = subscribe([A, B], 50);
    deliver(sub.id, B, "HIGH", null);
    touchSubscriptionCheckedAt(sub.id);
    getDb()
      .prepare("UPDATE webhook_subscriptions SET mints_json = ? WHERE id = ?")
      .run(JSON.stringify([A]), sub.id);

    getDb().pragma("user_version = 0");
    migrate(getDb());

    expect(getAlertedLevel(sub.id, B)).toBeNull();
  });
});
