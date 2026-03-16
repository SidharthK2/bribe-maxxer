import { encodeFunctionData, keccak256, type Hex, type Address } from "viem";
import { account } from "../clients.js";
import { morphoLiquidatorAbi } from "../utils/abis.js";
import { config } from "../config.js";
import type { MarketParams } from "../markets/types.js";
import type { SwapStep } from "../simulation/simulator.js";

export interface SignedBundle {
  signedTx: Hex;
  txHash: Hex;
}

/**
 * Sign a liquidation transaction for Flashbots bundle submission.
 * Returns RLP-encoded signed tx + its hash.
 * Nonce MUST be provided (from nonceManager.acquireNonce).
 */
export async function signLiquidationTx(params: {
  marketParams: MarketParams;
  borrower: Address;
  seizedAssets: bigint;
  swaps: SwapStep[];
  minProfit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
  nonce: number;
}): Promise<SignedBundle> {
  const data = encodeFunctionData({
    abi: morphoLiquidatorAbi,
    functionName: "liquidate",
    args: [
      params.marketParams,
      params.borrower,
      params.seizedAssets,
      0n,
      params.minProfit,
      params.swaps,
    ],
  });

  const signedTx = await account.signTransaction({
    to: config.flashLiquidator,
    data,
    nonce: params.nonce,
    maxFeePerGas: params.maxFeePerGas,
    maxPriorityFeePerGas: params.maxPriorityFeePerGas,
    gas: params.gasLimit,
    chainId: 1,
    type: "eip1559",
  });

  return { signedTx, txHash: keccak256(signedTx) };
}
