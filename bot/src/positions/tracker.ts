import type { Address, Hex } from "viem";
import { publicClient } from "../clients.js";
import { morphoAbi, oracleAbi, irmAbi } from "../utils/abis.js";
import { MORPHO_BLUE } from "../markets/constants.js";
import type { TrackedMarket, LiquidationOpportunity } from "../markets/types.js";
import { isUnhealthy, sharesToAssetsUp, computeLTV, accrueInterest } from "./health.js";
import { log, logError } from "../utils/logger.js";

/**
 * Check all borrowers in a market for liquidation opportunities.
 * Uses multicall to batch position reads for efficiency.
 * Accrues interest off-chain via IRM.borrowRateView for accurate health checks.
 */
export async function checkMarketPositions(
  market: TrackedMarket,
  borrowers: Set<Address>,
): Promise<LiquidationOpportunity[]> {
  if (borrowers.size === 0) return [];

  // Fetch oracle price + market state in parallel
  const [oraclePrice, marketState] = await Promise.all([
    publicClient.readContract({
      address: market.params.oracle,
      abi: oracleAbi,
      functionName: "price",
    }),
    publicClient.readContract({
      address: MORPHO_BLUE,
      abi: morphoAbi,
      functionName: "market",
      args: [market.id as `0x${string}`],
    }),
  ]);

  const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = marketState;

  if (totalBorrowShares === 0n) return [];

  // Accrue interest off-chain for accurate shares→assets conversion
  let accruedTotalBorrowAssets = BigInt(totalBorrowAssets);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const elapsed = nowSec - BigInt(lastUpdate);

  if (elapsed > 0n && market.params.irm !== "0x0000000000000000000000000000000000000000") {
    try {
      const borrowRate = await publicClient.readContract({
        address: market.params.irm,
        abi: irmAbi,
        functionName: "borrowRateView",
        args: [
          market.params,
          {
            totalSupplyAssets,
            totalSupplyShares,
            totalBorrowAssets,
            totalBorrowShares,
            lastUpdate,
            fee,
          },
        ],
      });

      accruedTotalBorrowAssets = accrueInterest(
        BigInt(totalBorrowAssets),
        borrowRate,
        elapsed,
      );
    } catch (err) {
      // IRM call failed — use on-chain state as-is (conservative: may miss borderline positions)
      logError(`IRM.borrowRateView failed for ${market.label}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Multicall all positions in one RPC call
  const borrowerArray = [...borrowers];
  const positionCalls = borrowerArray.map((b) => ({
    address: MORPHO_BLUE as Address,
    abi: morphoAbi,
    functionName: "position" as const,
    args: [market.id as `0x${string}`, b] as const,
  }));

  const results = await publicClient.multicall({
    contracts: positionCalls,
    allowFailure: true,
  });

  const opportunities: LiquidationOpportunity[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status !== "success") continue;

    const [, borrowShares, collateral] = result.result;

    if (borrowShares === 0n || collateral === 0n) continue;

    // Use accrued totalBorrowAssets for accurate debt calculation
    const borrowAssets = sharesToAssetsUp(
      BigInt(borrowShares),
      accruedTotalBorrowAssets,
      BigInt(totalBorrowShares),
    );

    if (!isUnhealthy(borrowAssets, BigInt(collateral), oraclePrice, market.params.lltv)) continue;

    const ltvPct = computeLTV(borrowAssets, BigInt(collateral), oraclePrice);

    log(
      `LIQUIDATABLE: ${borrowerArray[i]} in ${market.label} | LTV=${ltvPct.toFixed(2)}% | collateral=${collateral} borrowAssets=${borrowAssets}`,
    );

    opportunities.push({
      market,
      borrower: borrowerArray[i],
      collateral: BigInt(collateral),
      borrowAssets,
      oraclePrice,
      estimatedProfitUsd: 0, // Calculated later in execution pipeline
    });
  }

  return opportunities;
}
