import { WAD, ORACLE_PRICE_SCALE, LIQUIDATION_CURSOR, MAX_LIQUIDATION_INCENTIVE_FACTOR } from "../markets/constants.js";

/**
 * Check if a position is unhealthy (liquidatable).
 * borrowAssets * ORACLE_PRICE_SCALE > collateral * oraclePrice * lltv / WAD
 */
export function isUnhealthy(
  borrowAssets: bigint,
  collateral: bigint,
  oraclePrice: bigint,
  lltv: bigint,
): boolean {
  if (borrowAssets === 0n || collateral === 0n) return false;
  return borrowAssets * ORACLE_PRICE_SCALE > (collateral * oraclePrice * lltv) / WAD;
}

/**
 * Convert borrow shares to borrow assets, rounding up.
 * borrowAssets = (borrowShares * totalBorrowAssets + totalBorrowShares - 1) / totalBorrowShares
 */
export function sharesToAssetsUp(
  shares: bigint,
  totalAssets: bigint,
  totalShares: bigint,
): bigint {
  if (totalShares === 0n) return 0n;
  return (shares * totalAssets + totalShares - 1n) / totalShares;
}

/**
 * Compute the Morpho Blue liquidation incentive factor for a given LLTV.
 * LIF = min(MAX_LIF, WAD / (WAD - CURSOR * (WAD - LLTV)))
 */
export function computeLIF(lltv: bigint): bigint {
  const denominator = WAD - (LIQUIDATION_CURSOR * (WAD - lltv)) / WAD;
  if (denominator <= 0n) return MAX_LIQUIDATION_INCENTIVE_FACTOR;
  const lif = (WAD * WAD) / denominator;
  return lif < MAX_LIQUIDATION_INCENTIVE_FACTOR ? lif : MAX_LIQUIDATION_INCENTIVE_FACTOR;
}

/**
 * Compute current LTV as a percentage (basis points / 100).
 */
export function computeLTV(
  borrowAssets: bigint,
  collateral: bigint,
  oraclePrice: bigint,
): number {
  if (collateral === 0n || oraclePrice === 0n) return 0;
  const ltv = (borrowAssets * ORACLE_PRICE_SCALE * 10000n) / (collateral * oraclePrice);
  return Number(ltv) / 100;
}

/**
 * Morpho Blue's wTaylorCompounded: 3-term Taylor expansion of e^(x*n) - 1.
 * Replicates the exact on-chain math from MathLib.sol.
 *
 *   firstTerm  = x * n
 *   secondTerm = firstTerm^2 / (2 * WAD)
 *   thirdTerm  = secondTerm * firstTerm / (3 * WAD)
 *   return firstTerm + secondTerm + thirdTerm
 */
function wTaylorCompounded(x: bigint, n: bigint): bigint {
  const firstTerm = x * n;
  const secondTerm = (firstTerm * firstTerm) / (2n * WAD);
  const thirdTerm = (secondTerm * firstTerm) / (3n * WAD);
  return firstTerm + secondTerm + thirdTerm;
}

/**
 * Accrue interest off-chain to get the up-to-date totalBorrowAssets.
 * Replicates Morpho Blue's _accrueInterest() without modifying on-chain state.
 *
 * @param totalBorrowAssets - On-chain totalBorrowAssets at lastUpdate
 * @param borrowRate - Rate per second from IRM.borrowRateView() (WAD-scaled)
 * @param elapsed - Seconds since market.lastUpdate
 * @returns Accrued totalBorrowAssets
 */
export function accrueInterest(
  totalBorrowAssets: bigint,
  borrowRate: bigint,
  elapsed: bigint,
): bigint {
  if (elapsed <= 0n || borrowRate === 0n || totalBorrowAssets === 0n) {
    return totalBorrowAssets;
  }

  const compoundFactor = wTaylorCompounded(borrowRate, elapsed);
  // wMulDown: a * b / WAD (rounds down)
  const interest = (totalBorrowAssets * compoundFactor) / WAD;
  return totalBorrowAssets + interest;
}
