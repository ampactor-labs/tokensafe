import { app } from "./app.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { getConnection, initBackupRpc } from "./solana/rpc.js";
import { startMonitorJob, stopMonitorJob } from "./utils/monitor-job.js";
import { getDb, closeDb } from "./utils/db.js";

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

const server = app.listen(config.port, () => {
  monitorTimer = startMonitorJob();
  logger.info(
    { port: config.port, network: config.solanaNetwork },
    "TokenSafe started",
  );
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, draining connections");
  if (monitorTimer) stopMonitorJob(monitorTimer);
  server.close(() => {
    closeDb();
    logger.info("Database closed, exiting");
    process.exit(0);
  });
  setTimeout(() => {
    closeDb();
    process.exit(1);
  }, 20_000);
});
