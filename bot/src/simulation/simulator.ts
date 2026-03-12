import type { Address, Hex, encodeFunctionData } from "viem";
import { encodeFunctionData as encode } from "viem";
import { publicClient, account } from "../clients.js";
import { morphoLiquidatorAbi } from "../utils/abis.js";
import { config } from "../config.js";
import type { TrackedMarket, LiquidationOpportunity } from "../markets/types.js";
import { logError } from "../utils/logger.js";

export interface SwapStep {
  target: Address;
  callData: Hex;
}

export interface SimulationResult {
  success: boolean;
  seized: bigint;
  repaid: bigint;
  gasEstimate: bigint;
  error?: string;
}

/**
 * Simulate a liquidation via eth_call to verify it will succeed and extract return values.
 */
export async function simulateLiquidation(
  opportunity: LiquidationOpportunity,
  swaps: SwapStep[],
  minProfit: bigint = 0n,
): Promise<SimulationResult> {
  try {
    const { request, result } = await publicClient.simulateContract({
      address: config.flashLiquidator,
      abi: morphoLiquidatorAbi,
      functionName: "liquidate",
      args: [
        opportunity.market.params,
        opportunity.borrower,
        opportunity.collateral,
        0n, // repaidShares = 0, use seizedAssets
        minProfit,
        swaps,
      ],
      account: account.address,
    });

    const [seized, repaid] = result;

    // Estimate gas
    const gasEstimate = await publicClient.estimateGas({
      to: config.flashLiquidator,
      data: encode({
        abi: morphoLiquidatorAbi,
        functionName: "liquidate",
        args: [
          opportunity.market.params,
          opportunity.borrower,
          opportunity.collateral,
          0n,
          minProfit,
          swaps,
        ],
      }),
      account: account.address,
    });

    return {
      success: true,
      seized,
      repaid,
      gasEstimate,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logError(`Simulation failed for ${opportunity.borrower}: ${errMsg}`);
    return {
      success: false,
      seized: 0n,
      repaid: 0n,
      gasEstimate: 0n,
      error: errMsg,
    };
  }
}
