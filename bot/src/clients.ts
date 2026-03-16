import { createPublicClient, createWalletClient, http, webSocket } from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";

export const account = privateKeyToAccount(config.privateKey);

const httpTransport = http(config.httpRpcUrl, {
  retryCount: 3,
  retryDelay: 1000,
});

const wsTransport = webSocket(config.wsRpcUrl, {
  retryCount: 5,
  retryDelay: 2000,
});

/** HTTP-based client for reads and multicall batching. */
export const publicClient = createPublicClient({
  chain: mainnet,
  transport: httpTransport,
});

/** WebSocket-based client for block subscriptions. */
export const wsClient = createPublicClient({
  chain: mainnet,
  transport: wsTransport,
});

/** Wallet client for signing transactions (never broadcasts to public mempool). */
export const walletClient = createWalletClient({
  account,
  chain: mainnet,
  transport: httpTransport,
});
