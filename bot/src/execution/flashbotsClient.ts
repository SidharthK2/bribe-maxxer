import { Wallet } from "ethers";
import MevShareClientPkg from "@flashbots/mev-share-client";
import type { BundleParams } from "@flashbots/mev-share-client";
import { config } from "../config.js";
import { log, logError } from "../utils/logger.js";

// CJS/ESM interop: nodenext resolves CJS default export as module namespace
const MevShareClient =
  (MevShareClientPkg as any).default ?? MevShareClientPkg;

const authSigner = new Wallet(config.flashbotsAuthKey);
const mevShareClient = MevShareClient.useEthereumMainnet(authSigner);

/**
 * Top block builders by market share (March 2026, relayscan.io).
 * Titan (~50%), BuilderNet/flashbots (~29%), Quasar (~16%), Eureka (~2.5%),
 * beaverbuild (<1%), rsync (<1%), builder0x69 (~1%).
 */
const BUILDERS = [
  "flashbots",
  "Titan",
  "beaverbuild.org",
  "rsync-builder",
  "builder0x69",
];

export interface SendBundleResult {
  bundleHash: string;
}

/**
 * Send a bundle to MEV-Share, targeting multiple builders.
 * Enables tx hash hint for backrun MEV refund (liquidations create arb opportunities).
 */
export async function sendBundle(
  signedTx: string,
  targetBlock: number,
  maxBlock: number,
): Promise<SendBundleResult | null> {
  const params: BundleParams = {
    inclusion: {
      block: targetBlock,
      maxBlock,
    },
    body: [{ tx: signedTx, canRevert: false }],
    validity: {
      // Enable MEV refund: backrunners pay us 90% of their profit
      refund: [{ bodyIdx: 0, percent: 90 }],
    },
    privacy: {
      hints: {
        txHash: true,
        functionSelector: true,
        logs: true,
      },
      builders: BUILDERS,
    },
  };

  try {
    const result = await mevShareClient.sendBundle(params);
    log(
      `Bundle sent: ${result.bundleHash} target=[${targetBlock},${maxBlock}]`,
    );
    return result;
  } catch (err) {
    logError(
      `sendBundle failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Send a private transaction via Flashbots Protect (fallback path).
 * Goes to Flashbots private mempool, never the public mempool.
 */
export async function sendProtectTx(
  signedTx: string,
  maxBlockNumber: number,
): Promise<string | null> {
  try {
    const hash = await mevShareClient.sendTransaction(signedTx, {
      maxBlockNumber,
      hints: {
        calldata: false,
        logs: true,
        functionSelector: true,
        contractAddress: false,
        txHash: true,
      },
      builders: BUILDERS,
    });
    log(`Protect tx sent: ${hash}`);
    return hash;
  } catch (err) {
    logError(
      `sendProtectTx failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
