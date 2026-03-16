import { publicClient } from "../clients.js";
import { config } from "../config.js";
import type { LiquidationOpportunity } from "../markets/types.js";
import { getBestQuote, buildSwapStep } from "../simulation/swapQuoter.js";
import { simulateLiquidation } from "../simulation/simulator.js";
import {
  estimateProfit,
  computeBribe,
} from "../simulation/profitCalculator.js";
import {
  getCurrentGasPrice,
  getGasEstimate,
} from "../simulation/gasEstimator.js";
import {
  getTokenInfo,
  formatTokenAmount,
} from "../utils/tokenInfo.js";
import { logLiquidation } from "../db/database.js";
import { log, logError, notify } from "../utils/logger.js";
import { signLiquidationTx } from "./bundleBuilder.js";
import { sendBundle, sendProtectTx } from "./flashbotsClient.js";
import { acquireNonce, releaseNonce } from "./nonceManager.js";

const MIN_PRIORITY_FEE = 2_000_000_000n; // 2 gwei floor

/**
 * Full execution pipeline for a liquidation opportunity:
 * 1. Get swap quote (collateral → loan token)
 * 2. Build swap steps for on-chain callback
 * 3. Simulate the full liquidation via eth_call
 * 4. Calculate profit in ETH and USD
 * 5. Execute via Flashbots bundle (fallback: Flashbots Protect)
 */
export async function executeLiquidation(
  opportunity: LiquidationOpportunity,
): Promise<void> {
  const { market, borrower, collateral } = opportunity;

  const [collateralInfo, loanInfo] = await Promise.all([
    getTokenInfo(market.params.collateralToken),
    getTokenInfo(market.params.loanToken),
  ]);

  // 1. Get best swap quote: collateral → loan token
  const quote = await getBestQuote(
    market.params.collateralToken,
    market.params.loanToken,
    collateral,
  );

  if (!quote) {
    logError(
      `No swap route for ${market.label} (${collateralInfo.symbol} → ${loanInfo.symbol})`,
    );
    return;
  }

  log(
    `Quote: ${formatTokenAmount(collateral, collateralInfo.decimals)} ${collateralInfo.symbol} → ` +
      `${formatTokenAmount(quote.amountOut, loanInfo.decimals)} ${loanInfo.symbol} ` +
      `(${quote.isMultiHop ? "multi-hop" : "single"}, fee=${quote.feeTier})`,
  );

  // 2. Build on-chain swap step
  const swapStep = buildSwapStep(quote, config.flashLiquidator, collateral);

  // 3. Simulate the full liquidation
  const sim = await simulateLiquidation(opportunity, [swapStep], 0n);
  if (!sim.success) {
    logError(`Sim failed for ${borrower} in ${market.label}: ${sim.error}`);
    return;
  }

  log(
    `Sim OK: seized=${formatTokenAmount(sim.seized, collateralInfo.decimals)} ${collateralInfo.symbol}, ` +
      `repaid=${formatTokenAmount(sim.repaid, loanInfo.decimals)} ${loanInfo.symbol}, gas=${sim.gasEstimate}`,
  );

  // 4. Estimate profit in ETH + USD
  const gasPrice = getCurrentGasPrice();
  const profit = await estimateProfit(
    market.params.loanToken,
    quote.amountOut,
    sim.repaid,
    sim.gasEstimate,
    gasPrice,
    config.minProfitUsd,
    config.bridePercentage,
  );

  const grossStr = formatTokenAmount(
    profit.grossProfitLoanToken,
    loanInfo.decimals,
  );
  const netEthStr = (Number(profit.netProfitEth) / 1e18).toFixed(5);
  const gasCostEthStr = (Number(profit.gasCostEth) / 1e18).toFixed(5);

  if (!profit.isProfitable) {
    log(
      `Not profitable: ${borrower} in ${market.label} | gross=${grossStr} ${loanInfo.symbol}, ` +
        `net=${netEthStr} ETH ($${profit.netProfitUsd.toFixed(2)}), gas=${gasCostEthStr} ETH`,
    );
    return;
  }

  log(
    `Profitable: ${borrower} in ${market.label} | gross=${grossStr} ${loanInfo.symbol}, ` +
      `net=${netEthStr} ETH ($${profit.netProfitUsd.toFixed(2)}), gas=${gasCostEthStr} ETH`,
  );

  // 5. Gas price circuit breaker
  const { baseFee: currentBaseFee } = getGasEstimate();
  const maxGasWei = BigInt(config.maxGasPriceGwei) * 1_000_000_000n;
  if (currentBaseFee > maxGasWei) {
    log(
      `Gas too high: ${Number(currentBaseFee) / 1e9} gwei > ${config.maxGasPriceGwei} gwei max. Skipping.`,
    );
    return;
  }

  // Dry run check
  if (config.dryRun) {
    await notify(
      `[DRY RUN] Would liquidate ${borrower} in ${market.label} | ` +
        `seized=${formatTokenAmount(sim.seized, collateralInfo.decimals)} ${collateralInfo.symbol} ` +
        `profit=${netEthStr} ETH ($${profit.netProfitUsd.toFixed(2)})`,
    );
    return;
  }

  // Acquire nonce (serializes execution across all markets)
  const nonce = await acquireNonce();
  if (nonce === null) {
    log(`Skipping ${borrower} in ${market.label}: another liquidation in-flight`);
    return;
  }

  let included = false;
  try {
    // Compute bribe as priority fee per gas
    const bribePerGas = computeBribe(profit.grossProfitEth, sim.gasEstimate, config.bridePercentage);
    const { baseFee } = getGasEstimate();
    const bufferedBaseFee = baseFee + (baseFee * 13n) / 100n;
    const effectivePriority =
      bribePerGas > MIN_PRIORITY_FEE ? bribePerGas : MIN_PRIORITY_FEE;
    const gasLimit = sim.gasEstimate + (sim.gasEstimate * 20n) / 100n;

    // On-chain minProfit: 50% of gross profit in loan token as safety backstop
    const minProfit = profit.grossProfitLoanToken / 2n;

    // Sign the transaction
    const { signedTx, txHash } = await signLiquidationTx({
      marketParams: market.params,
      borrower,
      seizedAssets: collateral,
      swaps: [swapStep],
      minProfit,
      maxFeePerGas: bufferedBaseFee + effectivePriority,
      maxPriorityFeePerGas: effectivePriority,
      gasLimit,
      nonce,
    });

    const currentBlock = await publicClient.getBlockNumber();
    const targetBlock = Number(currentBlock) + 1;
    const maxBlock = targetBlock + config.bundleMaxRetries - 1;

    await notify(
      `Bundle: ${borrower} in ${market.label} | profit: ${netEthStr} ETH | ` +
        `bribe: ${(Number(effectivePriority) / 1e9).toFixed(2)} gwei/gas | ` +
        `blocks=[${targetBlock},${maxBlock}]`,
    );

    // Send bundle to MEV-Share (targets multiple builders)
    const bundleResult = await sendBundle(signedTx, targetBlock, maxBlock);
    const bundleHash = bundleResult?.bundleHash ?? null;

    // Wait for inclusion across the target block range
    let receipt = await publicClient
      .waitForTransactionReceipt({
        hash: txHash,
        timeout: 15_000 * config.bundleMaxRetries,
        pollingInterval: 2_000,
      })
      .catch(() => null);

    // Fallback: Flashbots Protect (private mempool, wider builder access)
    if (!receipt) {
      log(
        `Bundle not included by block ${maxBlock}, falling back to Protect...`,
      );
      const protectMaxBlock = maxBlock + 5;
      await sendProtectTx(signedTx, protectMaxBlock);

      receipt = await publicClient
        .waitForTransactionReceipt({
          hash: txHash,
          timeout: 75_000,
          pollingInterval: 2_000,
        })
        .catch(() => null);
    }

    // Neither bundle nor Protect landed
    if (!receipt) {
      logLiquidation(
        market.id,
        borrower,
        sim.seized.toString(),
        sim.repaid.toString(),
        null,
        null,
        txHash,
        bundleHash,
        "expired",
        `not included via Flashbots`,
      );
      await notify(
        `EXPIRED: ${borrower} in ${market.label} | bundle=${bundleHash}`,
      );
      return;
    }

    // Tx landed on chain
    included = true;

    const actualGasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    const actualGasEth = (Number(actualGasCost) / 1e18).toFixed(5);
    const ethPriceRatio =
      Number(profit.netProfitEth) !== 0
        ? profit.netProfitUsd / (Number(profit.netProfitEth) / 1e18)
        : 0;
    const actualGasCostUsd = (Number(actualGasCost) / 1e18) * ethPriceRatio;

    if (receipt.status === "reverted") {
      logLiquidation(
        market.id,
        borrower,
        sim.seized.toString(),
        sim.repaid.toString(),
        null,
        actualGasCostUsd || null,
        txHash,
        bundleHash,
        "reverted",
        `block=${receipt.blockNumber}`,
      );
      await notify(
        `REVERTED: ${borrower} in ${market.label} | tx=${txHash} | gas=${actualGasEth} ETH`,
      );
      return;
    }

    logLiquidation(
      market.id,
      borrower,
      sim.seized.toString(),
      sim.repaid.toString(),
      profit.netProfitUsd,
      actualGasCostUsd || null,
      txHash,
      bundleHash,
      "included",
      `block=${receipt.blockNumber}`,
    );
    await notify(
      `SUCCESS: ${borrower} in ${market.label} | tx=${txHash} | block=${receipt.blockNumber} | ` +
        `profit=${netEthStr} ETH ($${profit.netProfitUsd.toFixed(2)}) | gas=${actualGasEth} ETH | bundle=${bundleHash}`,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logLiquidation(
      market.id,
      borrower,
      null,
      null,
      null,
      null,
      "",
      null,
      "failed",
      errMsg,
    );
    await notify(`FAILED: ${borrower} in ${market.label} | error=${errMsg}`);
  } finally {
    releaseNonce(included);
  }
}
