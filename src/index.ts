import { app } from "./app.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { getConnection, initBackupRpc } from "./solana/rpc.js";
import { startMonitorJob, stopMonitorJob } from "./utils/monitor-job.js";
import { getDb, closeDb } from "./utils/db.js";
import { checkToken } from "./analysis/token-checker.js";

// Initialize backup RPC if configured
initBackupRpc();

// Eagerly initialize database — fail at boot, not on first user request
try {
  getDb();
} catch (err) {
  logger.error({ err }, "Database initialization failed");
  process.exit(1);
}

// Pre-flight health check (non-blocking — degraded is better than no-start)
getConnection()
  .getSlot()
  .then((slot) => logger.info({ slot }, "RPC connectivity verified"))
  .catch((err) =>
    logger.warn(
      { err },
      "RPC pre-flight check failed — starting in degraded mode",
    ),
  );

let monitorTimer: NodeJS.Timeout | undefined;

const WARM_TOKENS = [
  "So11111111111111111111111111111111111111112",   // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",  // JUP
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
];

const server = app.listen(config.port, () => {
  monitorTimer = startMonitorJob();
  logger.info(
    { port: config.port, network: config.solanaNetwork },
    "TokenSafe started",
  );

  // Fire-and-forget cache warming — server accepts requests immediately
  if (config.solanaNetwork === "mainnet") {
    Promise.allSettled(WARM_TOKENS.map((m) => checkToken(m)))
      .then((results) => {
        const ok = results.filter((r) => r.status === "fulfilled").length;
        logger.info(
          { warmed: ok, total: WARM_TOKENS.length },
          "Cache warm complete",
        );
      })
      .catch((err) => logger.error({ err }, "Cache warm failed"));
  }
});

let dbClosed = false;
function safeCloseDb() {
  if (!dbClosed) {
    dbClosed = true;
    closeDb();
  }
}

function shutdown(signal: string) {
  logger.info({ signal }, "Shutdown signal received, draining connections");
  if (monitorTimer) stopMonitorJob(monitorTimer);
  server.close(() => {
    safeCloseDb();
    logger.info("Database closed, exiting");
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn("Hard shutdown timeout reached");
    safeCloseDb();
    process.exit(1);
  }, 20_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
