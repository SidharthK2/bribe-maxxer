import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import type { Address, Hex } from "viem";

const DATA_DIR = path.resolve("data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "bot.db"));
db.pragma("journal_mode = WAL");

// ── Schema ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS markets (
    id                TEXT PRIMARY KEY,
    loan_token        TEXT NOT NULL,
    collateral_token  TEXT NOT NULL,
    oracle            TEXT NOT NULL,
    irm               TEXT NOT NULL,
    lltv              TEXT NOT NULL,
    label             TEXT,
    is_active         INTEGER DEFAULT 1,
    discovered_at     TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS borrowers (
    market_id TEXT NOT NULL,
    address   TEXT NOT NULL,
    first_seen_block TEXT NOT NULL,
    PRIMARY KEY (market_id, address)
  );

  CREATE TABLE IF NOT EXISTS scan_state (
    market_id          TEXT PRIMARY KEY,
    last_scanned_block TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS liquidations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT NOT NULL,
    market_id       TEXT NOT NULL,
    borrower        TEXT NOT NULL,
    seized_assets   TEXT,
    repaid_assets   TEXT,
    net_profit_usd  REAL,
    gas_cost_usd    REAL,
    tx_hash         TEXT NOT NULL,
    bundle_hash     TEXT,
    status          TEXT NOT NULL,
    detail          TEXT,
    created_at      TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_borrowers_market ON borrowers(market_id);
  CREATE INDEX IF NOT EXISTS idx_liquidations_status ON liquidations(status);
`);

// ── Prepared Statements ─────────────────────────────────
const stmts = {
  // Markets
  upsertMarket: db.prepare(`
    INSERT INTO markets (id, loan_token, collateral_token, oracle, irm, lltv, label, discovered_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, is_active = 1
  `),
  loadActiveMarkets: db.prepare("SELECT * FROM markets WHERE is_active = 1"),

  // Borrowers
  addBorrower: db.prepare(
    "INSERT OR IGNORE INTO borrowers (market_id, address, first_seen_block) VALUES (?, ?, ?)",
  ),
  loadBorrowers: db.prepare("SELECT address FROM borrowers WHERE market_id = ?"),

  // Scan state
  getScanState: db.prepare("SELECT last_scanned_block FROM scan_state WHERE market_id = ?"),
  setScanState: db.prepare(
    "INSERT INTO scan_state (market_id, last_scanned_block) VALUES (?, ?) ON CONFLICT(market_id) DO UPDATE SET last_scanned_block = excluded.last_scanned_block",
  ),

  // Liquidations
  insertLiquidation: db.prepare(
    "INSERT INTO liquidations (timestamp, market_id, borrower, seized_assets, repaid_assets, net_profit_usd, gas_cost_usd, tx_hash, bundle_hash, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ),
  recentLiquidations: db.prepare("SELECT * FROM liquidations ORDER BY id DESC LIMIT 50"),
  liquidationStats: db.prepare(
    "SELECT COUNT(*) as total, SUM(net_profit_usd) as total_profit FROM liquidations WHERE status = 'included'",
  ),
};

// ── Market DB functions ─────────────────────────────────

export function upsertMarketDB(
  id: Hex,
  loanToken: Address,
  collateralToken: Address,
  oracle: Address,
  irm: Address,
  lltv: bigint,
  label: string,
): void {
  const now = new Date().toISOString();
  stmts.upsertMarket.run(id, loanToken, collateralToken, oracle, irm, lltv.toString(), label, now, now);
}

export function loadActiveMarketsDB(): Array<{
  id: string;
  loan_token: string;
  collateral_token: string;
  oracle: string;
  irm: string;
  lltv: string;
  label: string;
}> {
  return stmts.loadActiveMarkets.all() as any[];
}

// ── Borrower DB functions ───────────────────────────────

export function addBorrowerDB(marketId: Hex, address: Address, block: bigint): void {
  stmts.addBorrower.run(marketId, address, block.toString());
}

export function loadBorrowersDB(marketId: Hex): Set<Address> {
  const rows = stmts.loadBorrowers.all(marketId) as { address: string }[];
  return new Set(rows.map((r) => r.address as Address));
}

// ── Scan state DB functions ─────────────────────────────

export function getLastScannedBlockDB(marketId: Hex): bigint | null {
  const row = stmts.getScanState.get(marketId) as { last_scanned_block: string } | undefined;
  return row ? BigInt(row.last_scanned_block) : null;
}

export function setLastScannedBlockDB(marketId: Hex, block: bigint): void {
  stmts.setScanState.run(marketId, block.toString());
}

// ── Liquidation DB functions ────────────────────────────

export function logLiquidation(
  marketId: string,
  borrower: string,
  seized: string | null,
  repaid: string | null,
  profitUsd: number | null,
  gasCostUsd: number | null,
  txHash: string,
  bundleHash: string | null,
  status: string,
  detail: string | null,
): void {
  const now = new Date().toISOString();
  stmts.insertLiquidation.run(now, marketId, borrower, seized, repaid, profitUsd, gasCostUsd, txHash, bundleHash, status, detail, now);
}

export function getRecentLiquidations() {
  return stmts.recentLiquidations.all();
}

export function getLiquidationStats(): { total: number; total_profit: number } {
  return stmts.liquidationStats.get() as any;
}
