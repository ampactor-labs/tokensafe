import { Connection } from "@solana/web3.js";
import { config } from "../config.js";

let connection: Connection | null = null;

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(config.heliusRpcUrl, {
      commitment: "confirmed",
    });
  }
  return connection;
}
