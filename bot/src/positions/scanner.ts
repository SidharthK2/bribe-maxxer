import type { Address, Hex } from "viem";
import { publicClient } from "../clients.js";
import { morphoAbi } from "../utils/abis.js";
import { MORPHO_BLUE, MORPHO_DEPLOY_BLOCK } from "../markets/constants.js";
import { addBorrowerDB, getLastScannedBlockDB, setLastScannedBlockDB } from "../db/database.js";
import { log } from "../utils/logger.js";

const CHUNK_SIZE = 2000n;

/**
 * Discover borrowers for a specific market by scanning Borrow + SupplyCollateral events.
 * Persists scan progress per-market to resume after crashes.
 */
export async function scanBorrowersForMarket(
  marketId: Hex,
  borrowerSet: Set<Address>,
): Promise<void> {
  const currentBlock = await publicClient.getBlockNumber();
  const lastScanned = getLastScannedBlockDB(marketId) ?? MORPHO_DEPLOY_BLOCK;

  if (currentBlock <= lastScanned) return;

  for (let from = lastScanned + 1n; from <= currentBlock; from += CHUNK_SIZE) {
    const to = from + CHUNK_SIZE - 1n > currentBlock ? currentBlock : from + CHUNK_SIZE - 1n;

    // Scan Borrow events
    const borrowLogs = await publicClient.getLogs({
      address: MORPHO_BLUE,
      event: {
        name: "Borrow",
        type: "event",
        inputs: [
          { name: "id", type: "bytes32", indexed: true },
          { name: "caller", type: "address", indexed: false },
          { name: "onBehalf", type: "address", indexed: true },
          { name: "receiver", type: "address", indexed: true },
          { name: "assets", type: "uint256", indexed: false },
          { name: "shares", type: "uint256", indexed: false },
        ],
      },
      args: { id: marketId },
      fromBlock: from,
      toBlock: to,
    });

    for (const entry of borrowLogs) {
      const onBehalf = entry.args.onBehalf;
      if (onBehalf && !borrowerSet.has(onBehalf)) {
        borrowerSet.add(onBehalf);
        addBorrowerDB(marketId, onBehalf, entry.blockNumber);
      }
    }

    // Scan SupplyCollateral events (positions that have collateral but might borrow later)
    const collateralLogs = await publicClient.getLogs({
      address: MORPHO_BLUE,
      event: {
        name: "SupplyCollateral",
        type: "event",
        inputs: [
          { name: "id", type: "bytes32", indexed: true },
          { name: "caller", type: "address", indexed: true },
          { name: "onBehalf", type: "address", indexed: true },
          { name: "assets", type: "uint256", indexed: false },
        ],
      },
      args: { id: marketId },
      fromBlock: from,
      toBlock: to,
    });

    for (const entry of collateralLogs) {
      const onBehalf = entry.args.onBehalf;
      if (onBehalf && !borrowerSet.has(onBehalf)) {
        borrowerSet.add(onBehalf);
        addBorrowerDB(marketId, onBehalf, entry.blockNumber);
      }
    }

    setLastScannedBlockDB(marketId, to);
  }

  log(`[${marketId.slice(0, 10)}] Scanned to block ${currentBlock}. Borrowers: ${borrowerSet.size}`);
}
