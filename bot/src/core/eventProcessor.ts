import type { Address, Hex } from "viem";
import { decodeEventLog } from "viem";
import { publicClient } from "../clients.js";
import { morphoAbi } from "../utils/abis.js";
import { MORPHO_BLUE } from "../markets/constants.js";
import { marketRegistry, borrowerSets } from "../markets/discovery.js";
import { addBorrowerDB } from "../db/database.js";

export interface BlockEventResults {
  /** "marketId:borrower" keys whose on-chain position changed this block */
  dirtyPositions: Set<string>;
  /** Count of newly discovered borrowers */
  newBorrowers: number;
}

export function makeDirtyKey(marketId: Hex, borrower: Address): string {
  return `${marketId}:${borrower}`;
}

export function parseDirtyKey(key: string): {
  marketId: Hex;
  borrower: Address;
} {
  const sep = key.indexOf(":", 3); // skip "0x"
  return {
    marketId: key.slice(0, sep) as Hex,
    borrower: key.slice(sep + 1) as Address,
  };
}

/**
 * Fetch all Morpho Blue events in [fromBlock, toBlock], decode them,
 * update borrower tracking, and return the set of dirty positions.
 *
 * Single RPC call: getLogs for the MORPHO_BLUE address (all event types).
 * Unknown events (Supply, Withdraw, AccrueInterest, etc.) are silently ignored.
 */
export async function processBlockEvents(
  fromBlock: bigint,
  toBlock: bigint,
): Promise<BlockEventResults> {
  const dirtyPositions = new Set<string>();
  let newBorrowers = 0;

  if (fromBlock > toBlock) return { dirtyPositions, newBorrowers };

  const rawLogs = await publicClient.getLogs({
    address: MORPHO_BLUE,
    fromBlock,
    toBlock,
  });

  for (const rawLog of rawLogs) {
    if (rawLog.topics.length === 0) continue;

    let decoded: any;
    try {
      decoded = decodeEventLog({
        abi: morphoAbi,
        data: rawLog.data,
        topics: rawLog.topics,
      });
    } catch {
      // Event signature not in our ABI (Supply, Withdraw, AccrueInterest, etc.)
      continue;
    }

    const args = decoded.args;

    switch (decoded.eventName) {
      case "Borrow": {
        const id = args.id as Hex;
        if (!marketRegistry.has(id)) break;
        if (trackBorrower(id, args.onBehalf, rawLog.blockNumber))
          newBorrowers++;
        dirtyPositions.add(makeDirtyKey(id, args.onBehalf));
        break;
      }
      case "Repay": {
        const id = args.id as Hex;
        if (!marketRegistry.has(id)) break;
        dirtyPositions.add(makeDirtyKey(id, args.onBehalf));
        break;
      }
      case "SupplyCollateral": {
        const id = args.id as Hex;
        if (!marketRegistry.has(id)) break;
        if (trackBorrower(id, args.onBehalf, rawLog.blockNumber))
          newBorrowers++;
        dirtyPositions.add(makeDirtyKey(id, args.onBehalf));
        break;
      }
      case "WithdrawCollateral": {
        const id = args.id as Hex;
        if (!marketRegistry.has(id)) break;
        dirtyPositions.add(makeDirtyKey(id, args.onBehalf));
        break;
      }
      case "Liquidate": {
        const id = args.id as Hex;
        if (!marketRegistry.has(id)) break;
        dirtyPositions.add(makeDirtyKey(id, args.borrower));
        break;
      }
    }
  }

  return { dirtyPositions, newBorrowers };
}

/** Add borrower to in-memory set + DB if not already known. Returns true if new. */
function trackBorrower(
  marketId: Hex,
  borrower: Address,
  blockNumber: bigint | null,
): boolean {
  if (!borrowerSets.has(marketId)) borrowerSets.set(marketId, new Set());
  const set = borrowerSets.get(marketId)!;
  if (set.has(borrower)) return false;
  set.add(borrower);
  addBorrowerDB(marketId, borrower, blockNumber ?? 0n);
  return true;
}
