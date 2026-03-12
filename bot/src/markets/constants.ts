import type { Address } from "viem";

// ── Morpho Blue ─────────────────────────────────────────
export const MORPHO_BLUE: Address = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

// ── Math constants ──────────────────────────────────────
export const WAD = 10n ** 18n;
export const ORACLE_PRICE_SCALE = 10n ** 36n;

// Liquidation incentive constants (from Morpho Blue)
export const LIQUIDATION_CURSOR = 300_000_000_000_000_000n; // 0.3e18
export const MAX_LIQUIDATION_INCENTIVE_FACTOR = 1_150_000_000_000_000_000n; // 1.15e18

// ── DEX Routers ─────────────────────────────────────────
export const UNISWAP_V3_ROUTER: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
export const UNISWAP_V3_QUOTER: Address = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

// ── Common Tokens ───────────────────────────────────────
export const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
export const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
export const DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
export const WSTETH: Address = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
export const WBTC: Address = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";

// ── Chainlink Price Feeds ────────────────────────────────
export const CHAINLINK_ETH_USD: Address = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";

// ── Morpho Blue Deployment Block ────────────────────────
export const MORPHO_DEPLOY_BLOCK = 18883124n;
