import { publicClient, walletClient } from "../clients.js";
import { morphoLiquidatorAbi } from "../utils/abis.js";
import { config } from "../config.js";
import type { LiquidationOpportunity } from "../markets/types.js";
import { getBestQuote, buildSwapStep } from "../simulation/swapQuoter.js";
import { simulateLiquidation } from "../simulation/simulator.js";
import { estimateProfit } from "../simulation/profitCalculator.js";
import { getCurrentGasPrice, getGasEstimate } from "../simulation/gasEstimator.js";
import { getTokenInfo, formatTokenAmount, tokenToFloat } from "../utils/tokenInfo.js";
import { logLiquidation } from "../db/database.js";
import { log, logError, notify } from "../utils/logger.js";

/**
 * Full execution pipeline for a liquidation opportunity:
 * 1. Get swap quote (collateral → loan token)
 * 2. Build swap steps for on-chain callback
 * 3. Simulate the full liquidation via eth_call
 * 4. Calculate profit in ETH and USD
 * 5. Execute (or log in dry-run mode)
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
    logError(`No swap route for ${market.label} (${collateralInfo.symbol} → ${loanInfo.symbol})`);
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
  );

  const grossStr = formatTokenAmount(profit.grossProfitLoanToken, loanInfo.decimals);
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

  // 5. Dry run check
  if (config.dryRun) {
    await notify(
      `[DRY RUN] Would liquidate ${borrower} in ${market.label} | ` +
        `seized=${formatTokenAmount(sim.seized, collateralInfo.decimals)} ${collateralInfo.symbol} ` +
        `profit=${netEthStr} ETH ($${profit.netProfitUsd.toFixed(2)})`,
    );
    return;
  }

  // 6. Execute via direct transaction
  // TODO: Phase 4 — Replace with Flashbots bundle submission
  try {
    const { maxFeePerGas, priorityFee } = getGasEstimate();

    await notify(`Executing liquidation: ${borrower} in ${market.label} | est profit: ${netEthStr} ETH`);

    const hash = await walletClient.writeContract({
      address: config.flashLiquidator,
      abi: morphoLiquidatorAbi,
      functionName: "liquidate",
      args: [
        market.params,
        borrower,
        collateral,
        0n,
        0n, // minProfit — set to 0 for now, contract handles atomically
        [swapStep],
      ],
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFee,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const actualGasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    const actualGasEth = (Number(actualGasCost) / 1e18).toFixed(5);

    const actualGasCostUsd = (Number(actualGasCost) / 1e18) * (profit.netProfitUsd / (Number(profit.netProfitEth) / 1e18) || 0);

    if (receipt.status === "reverted") {
      logLiquidation(market.id, borrower, sim.seized.toString(), sim.repaid.toString(), null, actualGasCostUsd || null, hash, null, "reverted", `block=${receipt.blockNumber}`);
      await notify(`REVERTED: ${borrower} in ${market.label} | tx=${hash} | gas=${actualGasEth} ETH`);
      return;
    }

    logLiquidation(
      market.id, borrower, sim.seized.toString(), sim.repaid.toString(),
      profit.netProfitUsd, actualGasCostUsd || null, hash, null, "included",
      `block=${receipt.blockNumber}`,
    );
    await notify(
      `SUCCESS: ${borrower} in ${market.label} | tx=${hash} | block=${receipt.blockNumber} | ` +
        `profit=${netEthStr} ETH ($${profit.netProfitUsd.toFixed(2)}) | gas=${actualGasEth} ETH`,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logLiquidation(market.id, borrower, null, null, null, null, "", null, "failed", errMsg);
    await notify(`FAILED: ${borrower} in ${market.label} | error=${errMsg}`);
  }
}
