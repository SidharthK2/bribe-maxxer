import { config } from "./config.js";
import { account } from "./clients.js";
import { db } from "./db/database.js";
import { startHealthServer } from "./monitoring/server.js";
import { startOrchestrator } from "./core/orchestrator.js";
import { log, logError } from "./utils/logger.js";

function shutdown() {
  log("Shutting down...");
  db.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function main() {
  log("=== bribe-maxxer ===");
  log(`Bot address: ${account.address}`);
  log(`HTTP RPC: ${config.httpRpcUrl}`);
  log(`WS RPC: ${config.wsRpcUrl}`);
  log(`Flash Liquidator: ${config.flashLiquidator}`);
  log(`Min profit: $${config.minProfitUsd}`);
  log(`Min market borrow: $${config.minMarketBorrowUsd}`);
  log(`Dry run: ${config.dryRun}`);
  log("");

  startHealthServer();
  await startOrchestrator();
}

main().catch((err) => {
  logError(`Fatal: ${err}`);
  process.exit(1);
});
