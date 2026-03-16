import type { Address, Hex } from "viem";
import { publicClient } from "../clients.js";
import { morphoAbi } from "../utils/abis.js";
import { MORPHO_BLUE, MORPHO_DEPLOY_BLOCK } from "./constants.js";
import { computeLIF } from "../positions/health.js";
import type { TrackedMarket, MarketParams } from "./types.js";
import { upsertMarketDB, loadActiveMarketsDB, loadBorrowersDB } from "../db/database.js";
import { log, logError } from "../utils/logger.js";
import { config } from "../config.js";

/** In-memory registry of active markets. */
export const marketRegistry = new Map<Hex, TrackedMarket>();

/** Per-market borrower sets. */
export const borrowerSets = new Map<Hex, Set<Address>>();

/**
 * Bootstrap markets from the Morpho API for instant discovery.
 * Falls back to on-chain event scanning if the API is unavailable.
 */
export async function discoverMarkets(): Promise<void> {
  log("Discovering Morpho Blue markets...");

  try {
    await discoverFromApi();
  } catch (err) {
    logError(`API discovery failed, falling back to on-chain scan: ${err}`);
    await discoverFromEvents();
  }

  // Hydrate borrower sets from DB
  for (const [id] of marketRegistry) {
    if (!borrowerSets.has(id)) {
      borrowerSets.set(id, loadBorrowersDB(id));
    }
  }

  log(`Discovered ${marketRegistry.size} active markets`);
}

async function discoverFromApi(): Promise<void> {
  const query = `{
    markets(where: { chainId_in: [1], borrowAssetsUsd_gte: ${config.minMarketBorrowUsd} }) {
      items {
        uniqueKey
        loanAsset { address symbol }
        collateralAsset { address symbol }
        oracleAddress
        irmAddress
        lltv
        state { borrowAssetsUsd }
      }
    }
  }`;

  const resp = await fetch("https://blue-api.morpho.org/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!resp.ok) throw new Error(`Morpho API returned ${resp.status}`);

  const data = (await resp.json()) as any;
  const items = data?.data?.markets?.items;

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("No markets returned from API");
  }

  for (const item of items) {
    const id = item.uniqueKey as Hex;
    const params: MarketParams = {
      loanToken: item.loanAsset.address as Address,
      collateralToken: item.collateralAsset.address as Address,
      oracle: item.oracleAddress as Address,
      irm: item.irmAddress as Address,
      lltv: BigInt(item.lltv),
    };

    const label = `${item.collateralAsset.symbol}/${item.loanAsset.symbol}`;
    const lif = computeLIF(params.lltv);

    const market: TrackedMarket = { id, params, label, liquidationIncentiveFactor: lif };
    marketRegistry.set(id, market);

    upsertMarketDB(id, params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv, label);
  }
}

async function discoverFromEvents(): Promise<void> {
  // Scan CreateMarket events from Morpho Blue
  const currentBlock = await publicClient.getBlockNumber();
  const CHUNK = 50000n;

  for (let from = MORPHO_DEPLOY_BLOCK; from <= currentBlock; from += CHUNK) {
    const to = from + CHUNK - 1n > currentBlock ? currentBlock : from + CHUNK - 1n;

    const logs = await publicClient.getLogs({
      address: MORPHO_BLUE,
      event: {
        name: "CreateMarket",
        type: "event",
        inputs: [
          { name: "id", type: "bytes32", indexed: true },
          {
            name: "marketParams",
            type: "tuple",
            indexed: false,
            components: [
              { name: "loanToken", type: "address" },
              { name: "collateralToken", type: "address" },
              { name: "oracle", type: "address" },
              { name: "irm", type: "address" },
              { name: "lltv", type: "uint256" },
            ],
          },
        ],
      },
      fromBlock: from,
      toBlock: to,
    });

    for (const entry of logs) {
      const id = entry.args.id as Hex;
      const mp = entry.args.marketParams;
      if (!mp) continue;

      const params: MarketParams = {
        loanToken: mp.loanToken as Address,
        collateralToken: mp.collateralToken as Address,
        oracle: mp.oracle as Address,
        irm: mp.irm as Address,
        lltv: mp.lltv,
      };

      const lif = computeLIF(params.lltv);
      const label = `${id.slice(0, 10)}...`;

      marketRegistry.set(id, { id, params, label, liquidationIncentiveFactor: lif });
      upsertMarketDB(id, params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv, label);
    }
  }
}
