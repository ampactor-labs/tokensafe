import pino from "pino";

const nodeEnv = process.env.NODE_ENV || "development";
const isDev = nodeEnv === "development";

export const logger = pino(
  { level: isDev ? "debug" : "info" },
  isDev
    ? pino.transport({ target: "pino-pretty", options: { colorize: true } })
    : undefined,
);
