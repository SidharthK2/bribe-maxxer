import type { Address, Hex } from "viem";
import { encodePacked, encodeFunctionData } from "viem";
import { publicClient } from "../clients.js";
import { uniswapQuoterAbi } from "../utils/abis.js";
import { UNISWAP_V3_QUOTER, UNISWAP_V3_ROUTER, WETH } from "../markets/constants.js";
import type { SwapStep } from "./simulator.js";
import { logError } from "../utils/logger.js";

/** Fee tiers to try for Uniswap V3 pools. */
const FEE_TIERS = [100, 500, 3000, 10000] as const;

interface QuoteResult {
  amountOut: bigint;
  path: Hex;
  feeTier: number;
  isMultiHop: boolean;
}

/**
 * Get the best Uniswap V3 quote for swapping tokenIn → tokenOut.
 * Tries direct single-hop first, then multi-hop via WETH.
 */
export async function getBestQuote(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<QuoteResult | null> {
  const quotes: QuoteResult[] = [];

  // Try direct single-hop for each fee tier
  for (const fee of FEE_TIERS) {
    try {
      const result = await publicClient.simulateContract({
        address: UNISWAP_V3_QUOTER,
        abi: uniswapQuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn,
            tokenOut,
            amountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });

      const [amountOut] = result.result;
      if (amountOut > 0n) {
        quotes.push({
          amountOut,
          path: encodePacked(["address", "uint24", "address"], [tokenIn, fee, tokenOut]),
          feeTier: fee,
          isMultiHop: false,
        });
      }
    } catch {
      // Pool doesn't exist or has no liquidity for this fee tier
    }
  }

  // Try multi-hop via WETH if tokenIn and tokenOut are not WETH
  if (tokenIn !== WETH && tokenOut !== WETH) {
    for (const fee1 of [100, 500, 3000] as const) {
      for (const fee2 of [500, 3000] as const) {
        try {
          const path = encodePacked(
            ["address", "uint24", "address", "uint24", "address"],
            [tokenIn, fee1, WETH, fee2, tokenOut],
          );

          const result = await publicClient.simulateContract({
            address: UNISWAP_V3_QUOTER,
            abi: uniswapQuoterAbi,
            functionName: "quoteExactInput",
            args: [path, amountIn],
          });

          const [amountOut] = result.result;
          if (amountOut > 0n) {
            quotes.push({
              amountOut,
              path,
              feeTier: fee1 * 10000 + fee2, // composite for identification
              isMultiHop: true,
            });
          }
        } catch {
          // No liquidity for this path
        }
      }
    }
  }

  if (quotes.length === 0) return null;

  // Return the best quote (highest amountOut)
  quotes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1));
  return quotes[0];
}

/**
 * Build the on-chain SwapStep for the MorphoLiquidator callback.
 * Uses the Uniswap V3 SwapRouter02 exactInput or exactInputSingle.
 */
export function buildSwapStep(
  quote: QuoteResult,
  liquidatorAddress: Address,
  amountIn: bigint,
): SwapStep {
  let callData: Hex;

  if (quote.isMultiHop) {
    // exactInput for multi-hop
    callData = encodeFunctionData({
      abi: [
        {
          name: "exactInput",
          type: "function",
          stateMutability: "payable",
          inputs: [
            {
              name: "params",
              type: "tuple",
              components: [
                { name: "path", type: "bytes" },
                { name: "recipient", type: "address" },
                { name: "amountIn", type: "uint256" },
                { name: "amountOutMinimum", type: "uint256" },
              ],
            },
          ],
          outputs: [{ name: "amountOut", type: "uint256" }],
        },
      ],
      functionName: "exactInput",
      args: [
        {
          path: quote.path,
          recipient: liquidatorAddress,
          amountIn,
          amountOutMinimum: 0n, // Enforced by minProfit in the contract
        },
      ],
    });
  } else {
    // Decode path to get tokenIn, fee, tokenOut for single-hop
    // Path format: address (20) + fee (3) + address (20) = 43 bytes
    const tokenIn = `0x${quote.path.slice(2, 42)}` as Address;
    const fee = parseInt(quote.path.slice(42, 48), 16);
    const tokenOut = `0x${quote.path.slice(48, 88)}` as Address;

    callData = encodeFunctionData({
      abi: [
        {
          name: "exactInputSingle",
          type: "function",
          stateMutability: "payable",
          inputs: [
            {
              name: "params",
              type: "tuple",
              components: [
                { name: "tokenIn", type: "address" },
                { name: "tokenOut", type: "address" },
                { name: "fee", type: "uint24" },
                { name: "recipient", type: "address" },
                { name: "amountIn", type: "uint256" },
                { name: "amountOutMinimum", type: "uint256" },
                { name: "sqrtPriceLimitX96", type: "uint160" },
              ],
            },
          ],
          outputs: [{ name: "amountOut", type: "uint256" }],
        },
      ],
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee,
          recipient: liquidatorAddress,
          amountIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
  }

  return {
    target: UNISWAP_V3_ROUTER,
    callData,
  };
}
