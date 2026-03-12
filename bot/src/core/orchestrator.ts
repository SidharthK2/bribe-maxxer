import type { Address, Hex } from "viem";
import pLimit from "p-limit";
import { publicClient, wsClient } from "../clients.js";
import { config } from "../config.js";
import { discoverMarkets, marketRegistry, borrowerSets } from "../markets/discovery.js";
import { scanBorrowersForMarket } from "../positions/scanner.js";
import { checkMarketPositions } from "../positions/tracker.js";
import { executeLiquidation } from "../execution/executor.js";
import { updateMonitoringState } from "../monitoring/server.js";
import { updateGasEstimate } from "../simulation/gasEstimator.js";
import { log, logError } from "../utils/logger.js";

const limit = pLimit(config.maxConcurrentMarkets);

/**
 * Process a single block: update gas, scan events, check health, execute liquidations.
 */
async function processBlock(blockNumber: bigint): Promise<void> {
  updateMonitoringState(blockNumber);

  // Update gas estimate from this block's header
  await updateGasEstimate(blockNumber).catch((err) =>
    logError(`Gas estimate update failed: ${err}`),
  );

  // Scan each market in parallel (bounded concurrency)
  const tasks = [...marketRegistry.entries()].map(([id, market]) =>
    limit(async () => {
      try {
        // Get or create borrower set for this market
        if (!borrowerSets.has(id)) {
          borrowerSets.set(id, new Set());
        }
        const borrowers = borrowerSets.get(id)!;

        // Scan new events
        await scanBorrowersForMarket(id, borrowers);

        // Check all positions for liquidation opportunities
        const opportunities = await checkMarketPositions(market, borrowers);

        // Execute profitable liquidations sequentially (nonce management)
        for (const opp of opportunities) {
          await executeLiquidation(opp);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logError(`Error processing market ${market.label}: ${errMsg}`);
      }
    }),
  );

  await Promise.all(tasks);
}

/**
 * Main orchestrator: discovers markets, subscribes to blocks, runs the liquidation pipeline.
 */
export async function startOrchestrator(): Promise<void> {
  // 1. Bootstrap markets
  await discoverMarkets();

  // 2. Initial borrower scan for all markets
  log("Running initial borrower scan...");
  for (const [id, market] of marketRegistry) {
    if (!borrowerSets.has(id)) {
      borrowerSets.set(id, new Set());
    }
    try {
      await scanBorrowersForMarket(id, borrowerSets.get(id)!);
    } catch (err) {
      logError(`Initial scan failed for ${market.label}: ${err}`);
    }
  }

  const totalBorrowers = [...borrowerSets.values()].reduce((sum, s) => sum + s.size, 0);
  log(`Initial scan complete. Tracking ${totalBorrowers} borrowers across ${marketRegistry.size} markets`);

  // 3. Subscribe to new blocks via WebSocket
  let wsActive = true;

  try {
    const unwatch = wsClient.watchBlockNumber({
      onBlockNumber: async (blockNumber) => {
        try {
          await processBlock(blockNumber);
        } catch (err) {
          logError(`Block ${blockNumber} processing error: ${err}`);
        }
      },
      onError: (err) => {
        logError(`WebSocket error: ${err}`);
        wsActive = false;
      },
    });

    log("WebSocket block subscription active");

    // 4. Fallback polling loop (if WebSocket drops)
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 30_000));

      if (!wsActive) {
        log("WebSocket inactive, falling back to HTTP polling...");
        try {
          const blockNumber = await publicClient.getBlockNumber();
          await processBlock(blockNumber);
          wsActive = true; // Try to recover
        } catch (err) {
          logError(`Polling fallback error: ${err}`);
        }
      }
    }
  } catch (err) {
    logError(`Orchestrator fatal error: ${err}`);
    throw err;
  }
}
