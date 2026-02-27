import { app } from "./app.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";

app.listen(config.port, () => {
  logger.info(
    { port: config.port, network: config.solanaNetwork },
    "TokenSafe server started",
  );
});
