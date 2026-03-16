import type { Address } from "viem";
import { publicClient } from "../clients.js";
import { chainlinkAbi, uniswapQuoterAbi } from "../utils/abis.js";
import {
  WAD,
  WETH,
  USDC,
  USDT,
  DAI,
  CHAINLINK_ETH_USD,
  UNISWAP_V3_QUOTER,
} from "../markets/constants.js";
import { getTokenInfo, tokenToFloat } from "../utils/tokenInfo.js";
import { logError } from "../utils/logger.js";

export interface ProfitEstimate {
  grossProfitLoanToken: bigint;
  grossProfitEth: bigint;
  gasCostEth: bigint;
  bribeEth: bigint;
  netProfitEth: bigint;
  netProfitUsd: number;
  isProfitable: boolean;
}

// ── ETH/USD price cache ─────────────────────────────────────
let cachedEthPriceUsd = 0; // USD with 2 decimal precision
let ethPriceCacheBlock = 0n;

const MAX_CHAINLINK_STALENESS = 3600; // 1 hour — ETH/USD heartbeat is 1h

/**
 * Get ETH price in USD from Chainlink ETH/USD feed.
 * Cached per block to avoid redundant RPC calls.
 * Validates staleness: rejects prices older than MAX_CHAINLINK_STALENESS.
 */
async function getEthPriceUsd(): Promise<number> {
  const currentBlock = await publicClient.getBlockNumber();
  if (cachedEthPriceUsd > 0 && currentBlock <= ethPriceCacheBlock + 5n) {
    return cachedEthPriceUsd;
  }

  try {
    const result = await publicClient.readContract({
      address: CHAINLINK_ETH_USD,
      abi: chainlinkAbi,
      functionName: "latestRoundData",
    });

    // Chainlink ETH/USD returns 8 decimals
    const [, answer, , updatedAt] = result;

    // Staleness check: reject prices older than 1 hour
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now - updatedAt > BigInt(MAX_CHAINLINK_STALENESS)) {
      logError(`Chainlink ETH/USD stale: updatedAt=${updatedAt}, now=${now}`);
      return cachedEthPriceUsd > 0 ? cachedEthPriceUsd : 0;
    }

    // Sanity check: price must be positive
    if (answer <= 0n) {
      logError(`Chainlink ETH/USD returned non-positive: ${answer}`);
      return cachedEthPriceUsd > 0 ? cachedEthPriceUsd : 0;
    }

    cachedEthPriceUsd = Number(answer) / 1e8;
    ethPriceCacheBlock = currentBlock;
    return cachedEthPriceUsd;
  } catch {
    // Fallback: use cached value only, return 0 if no cache (will make profit calc reject)
    return cachedEthPriceUsd > 0 ? cachedEthPriceUsd : 0;
  }
}

const STABLECOINS = new Set([
  USDC.toLowerCase(),
  USDT.toLowerCase(),
  DAI.toLowerCase(),
]);

/**
 * Convert a loan token amount to ETH value.
 *
 * - WETH: 1:1
 * - Stablecoins (USDC/USDT/DAI): use Chainlink ETH/USD price
 * - Other tokens: Uniswap V3 quote to WETH
 */
async function loanTokenToEth(
  loanToken: Address,
  amount: bigint,
): Promise<bigint> {
  if (amount === 0n) return 0n;

  // WETH → direct
  if (loanToken.toLowerCase() === WETH.toLowerCase()) {
    return amount;
  }

  const { decimals } = await getTokenInfo(loanToken);

  // Stablecoins → use ETH/USD price
  if (STABLECOINS.has(loanToken.toLowerCase())) {
    const ethPriceUsd = await getEthPriceUsd();
    if (ethPriceUsd <= 0) return 0n;

    // usdValue = amount / 10^decimals
    // ethValue = usdValue / ethPriceUsd * 10^18
    // Combined: amount * 10^18 / (10^decimals * ethPriceUsd)
    // To avoid precision loss: amount * 10^18 * 100 / (10^decimals * ethPriceUsd * 100)
    const ethPriceCents = BigInt(Math.round(ethPriceUsd * 100));
    return (amount * WAD * 100n) / (10n ** BigInt(decimals) * ethPriceCents);
  }

  // Other tokens → Uniswap V3 quote to WETH
  try {
    const result = await publicClient.simulateContract({
      address: UNISWAP_V3_QUOTER,
      abi: uniswapQuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: loanToken,
          tokenOut: WETH,
          amountIn: amount,
          fee: 3000,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    const [amountOut] = result.result;
    return amountOut;
  } catch {
    // Try 500 fee tier
    try {
      const result = await publicClient.simulateContract({
        address: UNISWAP_V3_QUOTER,
        abi: uniswapQuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn: loanToken,
            tokenOut: WETH,
            amountIn: amount,
            fee: 500,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });

      const [amountOut] = result.result;
      return amountOut;
    } catch {
      logError(`Cannot price ${loanToken} in ETH — no Uniswap route`);
      return 0n;
    }
  }
}

/**
 * Estimate net profit from a liquidation in ETH and USD.
 *
 * grossProfit = swapOutput - repaidAssets (loan token units)
 * grossProfitEth = convert grossProfit to ETH
 * gasCostEth = gasEstimate * gasPrice
 * bribeEth = grossProfitEth * bridePercentage
 * netProfitEth = grossProfitEth - gasCostEth - bribeEth
 */
export async function estimateProfit(
  loanToken: Address,
  swapOutput: bigint,
  repaidAssets: bigint,
  gasEstimate: bigint,
  gasPrice: bigint,
  minProfitUsd: number,
  bridePercentage: number = 0.7,
): Promise<ProfitEstimate> {
  const grossProfitLoanToken = swapOutput > repaidAssets ? swapOutput - repaidAssets : 0n;

  if (grossProfitLoanToken === 0n) {
    return {
      grossProfitLoanToken: 0n,
      grossProfitEth: 0n,
      gasCostEth: 0n,
      bribeEth: 0n,
      netProfitEth: 0n,
      netProfitUsd: 0,
      isProfitable: false,
    };
  }

  // Convert gross profit to ETH
  const grossProfitEth = await loanTokenToEth(loanToken, grossProfitLoanToken);
  const gasCostEth = gasEstimate * gasPrice;
  const bribeEth = (grossProfitEth * BigInt(Math.floor(bridePercentage * 1000))) / 1000n;
  const netProfitEth = grossProfitEth - gasCostEth - bribeEth;

  // Convert to USD for threshold comparison
  const ethPriceUsd = await getEthPriceUsd();
  const netProfitUsd = (Number(netProfitEth) / 1e18) * ethPriceUsd;

  return {
    grossProfitLoanToken,
    grossProfitEth,
    gasCostEth,
    bribeEth,
    netProfitEth,
    netProfitUsd,
    isProfitable: netProfitEth > 0n && netProfitUsd >= minProfitUsd,
  };
}

/**
 * Compute the builder bribe as a priority fee per gas unit (for Flashbots bundles).
 * bribePerGas = (netProfitEth * bridePercentage) / gasEstimate
 */
export function computeBribe(
  expectedProfitEth: bigint,
  gasEstimate: bigint,
  bridePercentage: number = 0.7,
): bigint {
  if (gasEstimate === 0n) return 0n;
  const bribeTotal = (expectedProfitEth * BigInt(Math.floor(bridePercentage * 1000))) / 1000n;
  return bribeTotal / gasEstimate;
}
