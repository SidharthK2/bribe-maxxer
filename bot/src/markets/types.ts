import type { Address, Hex } from "viem";

export interface MarketParams {
  readonly loanToken: Address;
  readonly collateralToken: Address;
  readonly oracle: Address;
  readonly irm: Address;
  readonly lltv: bigint;
}

export interface TrackedMarket {
  readonly id: Hex;
  readonly params: MarketParams;
  readonly label: string;
  readonly liquidationIncentiveFactor: bigint;
}

export interface MarketState {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
}

export interface PositionState {
  supplyShares: bigint;
  borrowShares: bigint;
  collateral: bigint;
}

export interface LiquidationOpportunity {
  market: TrackedMarket;
  borrower: Address;
  collateral: bigint;
  borrowAssets: bigint;
  oraclePrice: bigint;
  estimatedProfitUsd: number;
}
