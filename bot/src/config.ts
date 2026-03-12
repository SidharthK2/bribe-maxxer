import type { Address, Hex } from "viem";

export interface Config {
  privateKey: Hex;
  httpRpcUrl: string;
  wsRpcUrl: string;
  flashbotsAuthKey: Hex;
  flashLiquidator: Address;
  minProfitUsd: number;
  minMarketBorrowUsd: number;
  maxConcurrentMarkets: number;
  bundleMaxRetries: number;
  dryRun: boolean;
  discordWebhookUrl: string;
  port: number;
}

const HEX_64 = /^0x[0-9a-fA-F]{64}$/;
const HEX_40 = /^0x[0-9a-fA-F]{40}$/;

function validate(): string[] {
  const errors: string[] = [];

  const pk = process.env.PRIVATE_KEY;
  if (!pk) errors.push("PRIVATE_KEY is required");
  else if (!HEX_64.test(pk)) errors.push("PRIVATE_KEY must be 0x-prefixed 64-char hex");

  const httpRpc = process.env.HTTP_RPC_URL;
  if (!httpRpc) errors.push("HTTP_RPC_URL is required");
  else if (!/^https?:\/\/.+/.test(httpRpc)) errors.push("HTTP_RPC_URL must be a valid URL");

  const wsRpc = process.env.WS_RPC_URL;
  if (!wsRpc) errors.push("WS_RPC_URL is required");
  else if (!/^wss?:\/\/.+/.test(wsRpc)) errors.push("WS_RPC_URL must be a valid WebSocket URL");

  const fbKey = process.env.FLASHBOTS_AUTH_KEY;
  if (!fbKey) errors.push("FLASHBOTS_AUTH_KEY is required");
  else if (!HEX_64.test(fbKey)) errors.push("FLASHBOTS_AUTH_KEY must be 0x-prefixed 64-char hex");

  const flash = process.env.FLASH_LIQUIDATOR;
  if (!flash) errors.push("FLASH_LIQUIDATOR is required");
  else if (!HEX_40.test(flash)) errors.push("FLASH_LIQUIDATOR must be a valid Ethereum address");

  const port = process.env.PORT;
  if (port !== undefined) {
    const p = Number(port);
    if (isNaN(p) || p < 1 || p > 65535 || !Number.isInteger(p)) {
      errors.push("PORT must be an integer between 1 and 65535");
    }
  }

  return errors;
}

function loadConfig(): Config {
  const errors = validate();
  if (errors.length > 0) {
    console.error("Configuration errors:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  return {
    privateKey: process.env.PRIVATE_KEY as Hex,
    httpRpcUrl: process.env.HTTP_RPC_URL!,
    wsRpcUrl: process.env.WS_RPC_URL!,
    flashbotsAuthKey: process.env.FLASHBOTS_AUTH_KEY as Hex,
    flashLiquidator: process.env.FLASH_LIQUIDATOR as Address,
    minProfitUsd: Number(process.env.MIN_PROFIT_USD || "5"),
    minMarketBorrowUsd: Number(process.env.MIN_MARKET_BORROW_USD || "10000"),
    maxConcurrentMarkets: Number(process.env.MAX_CONCURRENT_MARKETS || "20"),
    bundleMaxRetries: Number(process.env.BUNDLE_MAX_RETRIES || "3"),
    dryRun: process.env.DRY_RUN === "true",
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "",
    port: Number(process.env.PORT || "3000"),
  };
}

export const config = loadConfig();
