import client from "prom-client";

// Dedicated registry — avoids global state pollution in tests
export const registry = new client.Registry();

client.collectDefaultMetrics({ register: registry, prefix: "tokensafe_" });

export const httpRequestDuration = new client.Histogram({
  name: "tokensafe_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestsTotal = new client.Counter({
  name: "tokensafe_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [registry],
});

export const tokenChecksTotal = new client.Counter({
  name: "tokensafe_token_checks_total",
  help: "Total token safety checks by tier",
  labelNames: ["tier"] as const,
  registers: [registry],
});

export const apiKeyRequestsTotal = new client.Counter({
  name: "tokensafe_api_key_requests_total",
  help: "Total requests authenticated via API key",
  labelNames: ["key_tier"] as const,
  registers: [registry],
});
