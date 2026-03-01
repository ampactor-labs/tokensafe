import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import {
  initTestDb,
  closeDb,
  createSubscription,
  createDelivery,
  updateSubscription,
} from "../src/utils/db.js";
import {
  deliverWebhook,
  processDeliveryQueue,
} from "../src/utils/webhook-delivery.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const WSOL = "So11111111111111111111111111111111111111112";
const HMAC_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(() => {
  closeDb();
  initTestDb();
  mockFetch.mockReset();
});

describe("deliverWebhook", () => {
  function makeSub() {
    return createSubscription("https://example.com/hook", [WSOL], 50, HMAC_KEY);
  }

  function makeDelivery(sub: ReturnType<typeof makeSub>) {
    return createDelivery(
      sub.id,
      WSOL,
      JSON.stringify({ mint: WSOL, risk_score: 75 }),
    );
  }

  it("sends POST with correct HMAC-SHA256 signature", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const sub = makeSub();
    const delivery = makeDelivery(sub);

    await deliverWebhook(delivery, sub);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://example.com/hook");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.headers["X-TokenSafe-Event"]).toBe("token.alert");

    const expectedHmac = crypto
      .createHmac("sha256", HMAC_KEY)
      .update(delivery.payload_json)
      .digest("hex");
    expect(options.headers["X-TokenSafe-Signature"]).toBe(
      `sha256=${expectedHmac}`,
    );
  });

  it("returns true on 2xx response", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const sub = makeSub();
    const delivery = makeDelivery(sub);

    const result = await deliverWebhook(delivery, sub);
    expect(result).toBe(true);
  });

  it("returns false on non-2xx response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const sub = makeSub();
    const delivery = makeDelivery(sub);

    const result = await deliverWebhook(delivery, sub);
    expect(result).toBe(false);
  });

  it("returns false on network error", async () => {
    mockFetch.mockRejectedValue(new Error("Connection refused"));
    const sub = makeSub();
    const delivery = makeDelivery(sub);

    const result = await deliverWebhook(delivery, sub);
    expect(result).toBe(false);
  });

  it("sends payload_json as request body", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const sub = makeSub();
    const delivery = makeDelivery(sub);

    await deliverWebhook(delivery, sub);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.body).toBe(delivery.payload_json);
  });
});

describe("processDeliveryQueue", () => {
  it("delivers pending items and returns counts", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const sub = createSubscription(
      "https://example.com/hook",
      [WSOL],
      50,
      HMAC_KEY,
    );
    createDelivery(sub.id, WSOL, '{"test": true}');

    const { delivered, failed } = await processDeliveryQueue();
    expect(delivered).toBe(1);
    expect(failed).toBe(0);
  });

  it("marks delivery failed for inactive subscription", async () => {
    const sub = createSubscription(
      "https://example.com/hook",
      [WSOL],
      50,
      HMAC_KEY,
    );
    createDelivery(sub.id, WSOL, '{"test": true}');
    updateSubscription(sub.id, { active: false });

    const { delivered, failed } = await processDeliveryQueue();
    expect(delivered).toBe(0);
    expect(failed).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns zero counts when queue is empty", async () => {
    const { delivered, failed } = await processDeliveryQueue();
    expect(delivered).toBe(0);
    expect(failed).toBe(0);
  });

  it("processes multiple deliveries", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const sub = createSubscription(
      "https://example.com/hook",
      [WSOL],
      50,
      HMAC_KEY,
    );
    createDelivery(sub.id, WSOL, '{"a": 1}');
    createDelivery(sub.id, WSOL, '{"b": 2}');

    const { delivered, failed } = await processDeliveryQueue();
    expect(delivered).toBe(2);
    expect(failed).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("counts failed deliveries separately from successful", async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      return callCount === 1
        ? { ok: true, status: 200 }
        : { ok: false, status: 503 };
    });
    const sub = createSubscription(
      "https://example.com/hook",
      [WSOL],
      50,
      HMAC_KEY,
    );
    createDelivery(sub.id, WSOL, '{"a": 1}');
    createDelivery(sub.id, WSOL, '{"b": 2}');

    const { delivered, failed } = await processDeliveryQueue();
    expect(delivered).toBe(1);
    expect(failed).toBe(1);
  });
});
