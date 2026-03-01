// Set env vars before any src module loads (config.ts throws on missing required vars)
process.env.TREASURY_WALLET_ADDRESS = "11111111111111111111111111111111";
process.env.HELIUS_API_KEY = "test-key";
process.env.NODE_ENV = "test";
process.env.RATE_LIMIT_PER_MINUTE = "200";
process.env.DB_PATH = ":memory:";
process.env.WEBHOOK_ADMIN_BEARER = "test-webhook-bearer";
