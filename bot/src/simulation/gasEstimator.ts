import { publicClient } from "../clients.js";

interface GasEstimate {
  baseFee: bigint;
  priorityFee: bigint;
  maxFeePerGas: bigint;
}

const PRIORITY_FEE_DEFAULT = 2_000_000_000n; // 2 gwei
const BASE_FEE_BUFFER_PCT = 13n; // 13% buffer (covers EIP-1559 max 12.5% increase)
const HISTORY_SIZE = 5;

let baseFeeHistory: bigint[] = [];
let lastUpdatedBlock = 0n;

/**
 * Update gas estimates from the latest block header.
 * Call once per block from the orchestrator.
 */
export async function updateGasEstimate(blockNumber?: bigint): Promise<void> {
  const num = blockNumber ?? (await publicClient.getBlockNumber());
  if (num <= lastUpdatedBlock) return;

  const block = await publicClient.getBlock({ blockNumber: num });
  if (block.baseFeePerGas != null) {
    baseFeeHistory.push(block.baseFeePerGas);
    if (baseFeeHistory.length > HISTORY_SIZE) {
      baseFeeHistory = baseFeeHistory.slice(-HISTORY_SIZE);
    }
  }

  lastUpdatedBlock = num;
}

/**
 * Get current gas price estimate using recent baseFee trend.
 */
export function getGasEstimate(): GasEstimate {
  let baseFee: bigint;

  if (baseFeeHistory.length === 0) {
    baseFee = 30_000_000_000n; // 30 gwei fallback
  } else {
    // Use max of recent baseFees as conservative estimate
    baseFee = baseFeeHistory.reduce((max, b) => (b > max ? b : max), 0n);
  }

  // Buffer for next-block base fee increase
  const bufferedBaseFee = baseFee + (baseFee * BASE_FEE_BUFFER_PCT) / 100n;

  return {
    baseFee,
    priorityFee: PRIORITY_FEE_DEFAULT,
    maxFeePerGas: bufferedBaseFee + PRIORITY_FEE_DEFAULT,
  };
}

/**
 * Get effective gas price (baseFee + priorityFee) in wei.
 */
export function getCurrentGasPrice(): bigint {
  const est = getGasEstimate();
  return est.baseFee + est.priorityFee;
}
