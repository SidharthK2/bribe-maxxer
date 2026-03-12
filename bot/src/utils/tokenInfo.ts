import type { Address } from "viem";
import { publicClient } from "../clients.js";
import { erc20Abi } from "./abis.js";
import { WETH, USDC, USDT, DAI } from "../markets/constants.js";

interface TokenInfo {
  decimals: number;
  symbol: string;
}

const cache = new Map<Address, TokenInfo>();

// Pre-seed known tokens to avoid RPC on first call
const KNOWN_TOKENS: Record<string, TokenInfo> = {
  [WETH.toLowerCase()]: { decimals: 18, symbol: "WETH" },
  [USDC.toLowerCase()]: { decimals: 6, symbol: "USDC" },
  [USDT.toLowerCase()]: { decimals: 6, symbol: "USDT" },
  [DAI.toLowerCase()]: { decimals: 18, symbol: "DAI" },
};

export async function getTokenInfo(token: Address): Promise<TokenInfo> {
  const cached = cache.get(token);
  if (cached) return cached;

  const known = KNOWN_TOKENS[token.toLowerCase()];
  if (known) {
    cache.set(token, known);
    return known;
  }

  const [decimals, symbol] = await Promise.all([
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
  ]);

  const info = { decimals: Number(decimals), symbol };
  cache.set(token, info);
  return info;
}

/**
 * Format a raw token amount into a human-readable string with up to 4 decimal places.
 */
export function formatTokenAmount(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();

  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const frac = amount % divisor;
  const isNegative = amount < 0n;
  const absFrac = frac < 0n ? -frac : frac;

  const fracStr = absFrac.toString().padStart(decimals, "0").slice(0, 4);
  // Trim trailing zeros
  const trimmed = fracStr.replace(/0+$/, "") || "0";

  return `${isNegative && whole === 0n ? "-" : ""}${whole}.${trimmed}`;
}

/**
 * Convert raw token amount to a floating-point USD-like value (for display/comparison).
 */
export function tokenToFloat(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}
