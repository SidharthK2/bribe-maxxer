import type { Address, Hex } from "viem";
import { publicClient, wsClient } from "../clients.js";
import { config } from "../config.js";
import { discoverMarkets, marketRegistry, borrowerSets } from "../markets/discovery.js";
import { scanBorrowersForMarket } from "../positions/scanner.js";
import { executeLiquidation } from "../execution/executor.js";
import { updateMonitoringState } from "../monitoring/server.js";
import { updateGasEstimate } from "../simulation/gasEstimator.js";
import { resetNonce } from "../execution/nonceManager.js";
import { morphoAbi, oracleAbi, irmAbi } from "../utils/abis.js";
import { MORPHO_BLUE } from "../markets/constants.js";
import {
  isUnhealthy,
  sharesToAssetsUp,
  computeLTV,
  accrueInterest,
} from "../positions/health.js";
import {
  setPosition,
  getMarketPositions,
  setSnapshot,
  getSnapshot,
  getPositionCount,
  type CachedPosition,
  type CachedMarketSnapshot,
} from "./positionCache.js";
import {
  processBlockEvents,
  parseDirtyKey,
} from "./eventProcessor.js";
import type { TrackedMarket, LiquidationOpportunity } from "../markets/types.js";
import { log, logError } from "../utils/logger.js";

let lastProcessedBlock = 0n;
let lastEventBlock = 0n;
let lastFullRefreshBlock = 0n;
let processing = false;

const FULL_REFRESH_INTERVAL = 100n;

// ── Startup: cache initialization ─────────────────────

/**
 * Multicall all known borrower positions into the in-memory cache.
 * Called on startup and every FULL_REFRESH_INTERVAL blocks as a safety net.
 */
async function loadAllPositions(): Promise<void> {
  for (const [id, market] of marketRegistry) {
    const borrowers = borrowerSets.get(id);
    if (!borrowers || borrowers.size === 0) continue;

    const borrowerArray = [...borrowers];
    const calls = borrowerArray.map((b) => ({
      address: MORPHO_BLUE as Address,
      abi: morphoAbi,
      functionName: "position" as const,
      args: [id as `0x${string}`, b] as const,
    }));

    try {
      const results = await publicClient.multicall({
        contracts: calls,
        allowFailure: true,
      });

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status !== "success") continue;
        const [, borrowShares, collateral] = r.result;
        if (borrowShares > 0n || collateral > 0n) {
          setPosition(id, borrowerArray[i], {
            borrowShares: BigInt(borrowShares),
            collateral: BigInt(collateral),
          });
        }
      }
    } catch (err) {
      logError(`Failed to load positions for ${market.label}: ${err}`);
    }
  }
}

/**
 * Fetch oracle prices + market states for all markets (2 multicalls).
 * Returns the set of market IDs whose oracle price changed since last snapshot.
 */
async function refreshMarketSnapshots(): Promise<Set<Hex>> {
  const entries = [...marketRegistry.entries()];
  const changedMarkets = new Set<Hex>();

  const oracleCalls = entries.map(([, m]) => ({
    address: m.params.oracle,
    abi: oracleAbi,
    functionName: "price" as const,
    args: [] as const,
  }));

  const stateCalls = entries.map(([id]) => ({
    address: MORPHO_BLUE as Address,
    abi: morphoAbi,
    functionName: "market" as const,
    args: [id as `0x${string}`] as const,
  }));

  const [oracleResults, stateResults] = await Promise.all([
    publicClient.multicall({ contracts: oracleCalls, allowFailure: true }),
    publicClient.multicall({ contracts: stateCalls, allowFailure: true }),
  ]);

  for (let i = 0; i < entries.length; i++) {
    const [id] = entries[i];
    if (
      oracleResults[i].status !== "success" ||
      stateResults[i].status !== "success"
    )
      continue;

    const oraclePrice = oracleResults[i].result as bigint;
    const [
      totalSupplyAssets,
      totalSupplyShares,
      totalBorrowAssets,
      totalBorrowShares,
      lastUpdate,
      fee,
    ] = stateResults[i].result as [bigint, bigint, bigint, bigint, bigint, bigint];

    const prev = getSnapshot(id);
    if (!prev || prev.oraclePrice !== oraclePrice) {
      changedMarkets.add(id);
    }

    setSnapshot(id, {
      totalSupplyAssets,
      totalSupplyShares,
      totalBorrowAssets,
      totalBorrowShares,
      lastUpdate,
      fee,
      oraclePrice,
    });
  }

  return changedMarkets;
}

// ── Per-block: targeted reads ─────────────────────────

/**
 * Re-read only the dirty positions from chain and update the cache.
 * Groups by market for efficient multicall batching.
 */
async function refreshDirtyPositions(
  dirtyPositions: Set<string>,
): Promise<void> {
  if (dirtyPositions.size === 0) return;

  const byMarket = new Map<Hex, Address[]>();
  for (const key of dirtyPositions) {
    const { marketId, borrower } = parseDirtyKey(key);
    if (!byMarket.has(marketId)) byMarket.set(marketId, []);
    byMarket.get(marketId)!.push(borrower);
  }

  const allCalls: {
    address: Address;
    abi: typeof morphoAbi;
    functionName: "position";
    args: readonly [`0x${string}`, Address];
  }[] = [];
  const callIndex: { marketId: Hex; borrower: Address }[] = [];

  for (const [marketId, borrowers] of byMarket) {
    for (const b of borrowers) {
      allCalls.push({
        address: MORPHO_BLUE as Address,
        abi: morphoAbi,
        functionName: "position" as const,
        args: [marketId as `0x${string}`, b] as const,
      });
      callIndex.push({ marketId, borrower: b });
    }
  }

  try {
    const results = await publicClient.multicall({
      contracts: allCalls,
      allowFailure: true,
    });

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== "success") continue;
      const [, borrowShares, collateral] = r.result;
      const { marketId, borrower } = callIndex[i];
      setPosition(marketId, borrower, {
        borrowShares: BigInt(borrowShares),
        collateral: BigInt(collateral),
      });
    }
  } catch (err) {
    logError(`Failed to refresh dirty positions: ${err}`);
  }
}

// ── Per-block: in-memory health evaluation ────────────

/**
 * Evaluate health of all cached positions in a market.
 * Pure math — no RPC calls. Uses fresh oracle price + accrued borrow assets.
 */
function evaluateMarketHealth(
  market: TrackedMarket,
  snapshot: CachedMarketSnapshot,
  accruedTotalBorrowAssets: bigint,
): LiquidationOpportunity[] {
  const positions = getMarketPositions(market.id);
  const opportunities: LiquidationOpportunity[] = [];

  for (const [borrower, pos] of positions) {
    if (pos.borrowShares === 0n || pos.collateral === 0n) continue;

    const borrowAssets = sharesToAssetsUp(
      pos.borrowShares,
      accruedTotalBorrowAssets,
      snapshot.totalBorrowShares,
    );

    if (
      !isUnhealthy(
        borrowAssets,
        pos.collateral,
        snapshot.oraclePrice,
        market.params.lltv,
      )
    )
      continue;

    const ltvPct = computeLTV(
      borrowAssets,
      pos.collateral,
      snapshot.oraclePrice,
    );

    log(
      `LIQUIDATABLE: ${borrower} in ${market.label} | LTV=${ltvPct.toFixed(2)}% | ` +
        `collateral=${pos.collateral} borrowAssets=${borrowAssets}`,
    );

    opportunities.push({
      market,
      borrower,
      collateral: pos.collateral,
      borrowAssets,
      oraclePrice: snapshot.oraclePrice,
      estimatedProfitUsd: 0,
    });
  }

  return opportunities;
}

// ── Main block processing loop ────────────────────────

/**
 * Event-driven block processing pipeline:
 *
 * 1. Update gas estimate from block header
 * 2. Scan Morpho events → discover borrowers + flag dirty positions
 * 3. Re-read dirty positions from chain (targeted multicall)
 * 4. Refresh oracle prices + market states (2 multicalls for all markets)
 * 5. Determine which markets need health evaluation:
 *    - Oracle price changed → evaluate all cached positions in that market
 *    - Position event → evaluate that market
 *    - Every 100 blocks → full refresh + evaluate all
 * 6. Batch IRM calls for interest accrual on evaluated markets
 * 7. In-memory health evaluation (pure math, no RPC)
 * 8. Execute profitable liquidations
 *
 * On quiet blocks (no oracle changes, no events): steps 1-4 only (~4 RPC calls total).
 * vs. old approach: multicall every borrower position every block.
 */
async function processBlock(blockNumber: bigint): Promise<void> {
  if (blockNumber <= lastProcessedBlock) return;

  if (processing) {
    log(`Skipping block ${blockNumber} — previous block still processing`);
    return;
  }

  processing = true;
  lastProcessedBlock = blockNumber;

  try {
    updateMonitoringState(blockNumber);

    // 1. Gas estimate
    await updateGasEstimate(blockNumber).catch((err) =>
      logError(`Gas estimate update failed: ${err}`),
    );

    // 2. Scan Morpho events (covers any skipped blocks)
    const eventFromBlock =
      lastEventBlock > 0n ? lastEventBlock + 1n : blockNumber;
    const eventResults = await processBlockEvents(eventFromBlock, blockNumber);
    lastEventBlock = blockNumber;

    // 3. Re-read dirty positions from chain
    await refreshDirtyPositions(eventResults.dirtyPositions);

    // 4. Oracle prices + market states
    const changedMarkets = await refreshMarketSnapshots();

    // 5. Determine which markets to evaluate
    const marketsToEvaluate = new Set<Hex>(changedMarkets);
    for (const key of eventResults.dirtyPositions) {
      const { marketId } = parseDirtyKey(key);
      marketsToEvaluate.add(marketId);
    }

    const needsFullRefresh =
      blockNumber - lastFullRefreshBlock >= FULL_REFRESH_INTERVAL;

    if (needsFullRefresh) {
      await loadAllPositions();
      lastFullRefreshBlock = blockNumber;
      for (const id of marketRegistry.keys()) {
        marketsToEvaluate.add(id);
      }
    }

    // Fast path: nothing to evaluate
    if (marketsToEvaluate.size === 0) return;

    // 6. Batch IRM calls for interest accrual
    const evaluateArray = [...marketsToEvaluate];
    const irmCalls = evaluateArray.map((id) => {
      const market = marketRegistry.get(id)!;
      const snapshot = getSnapshot(id)!;
      return {
        address: market.params.irm as Address,
        abi: irmAbi,
        functionName: "borrowRateView" as const,
        args: [
          market.params,
          {
            totalSupplyAssets: snapshot.totalSupplyAssets,
            totalSupplyShares: snapshot.totalSupplyShares,
            totalBorrowAssets: snapshot.totalBorrowAssets,
            totalBorrowShares: snapshot.totalBorrowShares,
            lastUpdate: snapshot.lastUpdate,
            fee: snapshot.fee,
          },
        ] as const,
      };
    });

    const irmResults = await publicClient.multicall({
      contracts: irmCalls,
      allowFailure: true,
    });

    // 7. In-memory health evaluation
    const allOpportunities: LiquidationOpportunity[] = [];
    const nowSec = BigInt(Math.floor(Date.now() / 1000));

    for (let i = 0; i < evaluateArray.length; i++) {
      const id = evaluateArray[i];
      const market = marketRegistry.get(id);
      const snapshot = getSnapshot(id);
      if (!market || !snapshot) continue;

      let accruedTotalBorrowAssets = snapshot.totalBorrowAssets;
      const elapsed = nowSec - snapshot.lastUpdate;

      if (elapsed > 0n && irmResults[i].status === "success") {
        const borrowRate = irmResults[i].result as bigint;
        accruedTotalBorrowAssets = accrueInterest(
          snapshot.totalBorrowAssets,
          borrowRate,
          elapsed,
        );
      }

      const opps = evaluateMarketHealth(
        market,
        snapshot,
        accruedTotalBorrowAssets,
      );
      allOpportunities.push(...opps);
    }

    // 8. Execute liquidations
    for (const opp of allOpportunities) {
      await executeLiquidation(opp);
    }

    updateMonitoringState(
      blockNumber,
      marketsToEvaluate.size,
      eventResults.dirtyPositions.size,
    );

    if (changedMarkets.size > 0 || eventResults.dirtyPositions.size > 0) {
      log(
        `Block ${blockNumber}: evaluated ${marketsToEvaluate.size}/${marketRegistry.size} markets ` +
          `(${changedMarkets.size} oracle changes, ${eventResults.dirtyPositions.size} dirty positions)`,
      );
    }
  } finally {
    processing = false;
  }
}

// ── Orchestrator entry point ──────────────────────────

export async function startOrchestrator(): Promise<void> {
  // 1. Bootstrap markets
  await discoverMarkets();

  // 2. Initialize nonce manager
  await resetNonce();

  // 3. Initial borrower scan (historical events)
  log("Running initial borrower scan...");
  for (const [id, market] of marketRegistry) {
    if (!borrowerSets.has(id)) {
      borrowerSets.set(id, new Set());
    }
    try {
      await scanBorrowersForMarket(id, borrowerSets.get(id)!);
    } catch (err) {
      logError(`Initial scan failed for ${market.label}: ${err}`);
    }
  }

  const totalBorrowers = [...borrowerSets.values()].reduce(
    (sum, s) => sum + s.size,
    0,
  );
  log(
    `Initial scan complete. Tracking ${totalBorrowers} borrowers across ${marketRegistry.size} markets`,
  );

  // 4. Load all positions into in-memory cache
  log("Loading position cache...");
  await loadAllPositions();
  log(`Position cache loaded: ${getPositionCount()} active positions`);

  // 5. Initial oracle prices + market states
  await refreshMarketSnapshots();

  // Set event tracking cursor to current block
  lastEventBlock = await publicClient.getBlockNumber();
  lastFullRefreshBlock = lastEventBlock;

  log("Event-driven orchestrator ready");

  // 6. Block subscription
  startBlockSubscription();

  // 7. Fallback polling loop
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));

    try {
      const blockNumber = await publicClient.getBlockNumber();
      if (blockNumber > lastProcessedBlock) {
        await processBlock(blockNumber);
      }
    } catch (err) {
      logError(`Polling error: ${err}`);
    }
  }
}

function startBlockSubscription(): void {
  try {
    wsClient.watchBlockNumber({
      onBlockNumber: async (blockNumber) => {
        try {
          await processBlock(blockNumber);
        } catch (err) {
          logError(`Block ${blockNumber} processing error: ${err}`);
        }
      },
      onError: (err) => {
        logError(`WebSocket error: ${err}`);
        setTimeout(() => {
          log("Reconnecting WebSocket block subscription...");
          startBlockSubscription();
        }, 5_000);
      },
    });

    log("WebSocket block subscription active");
  } catch (err) {
    logError(`Failed to start WebSocket subscription: ${err}`);
  }
}
