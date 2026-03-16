import { publicClient, account } from "../clients.js";
import { log } from "../utils/logger.js";

/**
 * In-memory nonce manager that prevents concurrent liquidations
 * from signing with the same nonce.
 *
 * - `acquire()` returns the next nonce and increments the counter.
 * - `reset()` re-syncs from on-chain (call after confirmed inclusion or on error).
 * - Only one liquidation can be in-flight at a time via the lock.
 */

let currentNonce: number | null = null;
let locked = false;

/** Initialize nonce from chain if not yet set. */
async function ensureInitialized(): Promise<void> {
  if (currentNonce === null) {
    currentNonce = await publicClient.getTransactionCount({
      address: account.address,
    });
    log(`Nonce manager initialized: ${currentNonce}`);
  }
}

/**
 * Try to acquire the execution lock + next nonce.
 * Returns the nonce if acquired, null if another liquidation is in-flight.
 */
export async function acquireNonce(): Promise<number | null> {
  if (locked) return null;
  locked = true;
  await ensureInitialized();
  const nonce = currentNonce!;
  currentNonce! += 1;
  return nonce;
}

/**
 * Release the lock after execution completes (success or failure).
 * If the tx was NOT included (expired/failed), roll back the nonce.
 */
export function releaseNonce(included: boolean): void {
  if (!included && currentNonce !== null) {
    currentNonce -= 1;
  }
  locked = false;
}

/**
 * Force re-sync nonce from chain. Call on startup or after unexpected errors.
 */
export async function resetNonce(): Promise<void> {
  currentNonce = await publicClient.getTransactionCount({
    address: account.address,
  });
  locked = false;
  log(`Nonce manager reset: ${currentNonce}`);
}
