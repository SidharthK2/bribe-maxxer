import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { config } from "../config.js";
import { marketRegistry } from "../markets/discovery.js";
import { getRecentLiquidations, getLiquidationStats } from "../db/database.js";
import { getPositionCount } from "../core/positionCache.js";
import { log } from "../utils/logger.js";

const app = new Hono();
const startedAt = Date.now();
let lastBlockSeen = 0n;
let lastCycleAt = 0;
let lastEvaluatedMarkets = 0;
let lastDirtyPositions = 0;

export function updateMonitoringState(
  block: bigint,
  evaluated?: number,
  dirty?: number,
): void {
  lastBlockSeen = block;
  lastCycleAt = Date.now();
  if (evaluated !== undefined) lastEvaluatedMarkets = evaluated;
  if (dirty !== undefined) lastDirtyPositions = dirty;
}

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    lastBlockSeen: lastBlockSeen.toString(),
    lastCycleAgo: lastCycleAt ? Math.floor((Date.now() - lastCycleAt) / 1000) : null,
    activeMarkets: marketRegistry.size,
    cachedPositions: getPositionCount(),
    lastEvaluatedMarkets,
    lastDirtyPositions,
    dryRun: config.dryRun,
  });
});

app.get("/markets", (c) => {
  const markets = [...marketRegistry.values()].map((m) => ({
    id: m.id,
    label: m.label,
    lltv: (Number(m.params.lltv) / 1e18 * 100).toFixed(1) + "%",
    lif: (Number(m.liquidationIncentiveFactor) / 1e18 * 100 - 100).toFixed(2) + "%",
  }));
  return c.json({ count: markets.length, markets });
});

app.get("/liquidations", (c) => {
  const recent = getRecentLiquidations();
  const stats = getLiquidationStats();
  return c.json({
    totalCount: stats.total,
    totalProfitUsd: stats.total_profit,
    recent,
  });
});

export function startHealthServer(): void {
  serve({ fetch: app.fetch, port: config.port }, () => {
    log(`Health server running on :${config.port}`);
  });
}
