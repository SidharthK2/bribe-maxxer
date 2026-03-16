import type { Address, Hex } from "viem";

export interface CachedPosition {
  borrowShares: bigint;
  collateral: bigint;
}

export interface CachedMarketSnapshot {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
  oraclePrice: bigint;
}

/** Per-market → per-borrower position data */
const positions = new Map<Hex, Map<Address, CachedPosition>>();

/** Per-market aggregated state + oracle price */
const snapshots = new Map<Hex, CachedMarketSnapshot>();

// ── Position CRUD ──────────────────────────────────────

export function setPosition(
  marketId: Hex,
  borrower: Address,
  pos: CachedPosition,
): void {
  if (!positions.has(marketId)) positions.set(marketId, new Map());
  positions.get(marketId)!.set(borrower, pos);
}

export function getPosition(
  marketId: Hex,
  borrower: Address,
): CachedPosition | undefined {
  return positions.get(marketId)?.get(borrower);
}

export function getMarketPositions(
  marketId: Hex,
): Map<Address, CachedPosition> {
  return positions.get(marketId) ?? new Map();
}

// ── Market Snapshot CRUD ───────────────────────────────

export function setSnapshot(
  marketId: Hex,
  snap: CachedMarketSnapshot,
): void {
  snapshots.set(marketId, snap);
}

export function getSnapshot(
  marketId: Hex,
): CachedMarketSnapshot | undefined {
  return snapshots.get(marketId);
}

// ── Stats ──────────────────────────────────────────────

export function getPositionCount(): number {
  let count = 0;
  for (const m of positions.values()) count += m.size;
  return count;
}
