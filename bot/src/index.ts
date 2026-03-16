import { config } from "./config.js";
import { account } from "./clients.js";
import { db } from "./db/database.js";
import { startHealthServer } from "./monitoring/server.js";
import { startOrchestrator } from "./core/orchestrator.js";
import { log, logError } from "./utils/logger.js";

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("Shutting down gracefully (waiting 5s for in-flight operations)...");
  // Give in-flight liquidations a few seconds to complete
  setTimeout(() => {
    db.close();
    log("Database closed. Exiting.");
    process.exit(0);
  }, 5_000);
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
  log(`Bribe: ${(config.bridePercentage * 100).toFixed(0)}%`);
  log(`Max gas: ${config.maxGasPriceGwei} gwei`);
  log(`Bundle retries: ${config.bundleMaxRetries}`);
  log(`Dry run: ${config.dryRun}`);
  log("");

  startHealthServer();
  await startOrchestrator();
}

main().catch((err) => {
  logError(`Fatal: ${err}`);
  process.exit(1);
});
