# bribe-maxxer

Capital-free MEV liquidation bot for Morpho Blue (Ethereum mainnet). Seizes collateral via native `onMorphoLiquidate` callback, swaps to loan token on DEX, Morpho pulls repayment — zero upfront capital. Flashbots bundle submission for frontrunning protection.

## Project Structure

```
/                       Foundry root (contracts)
├── src/                Solidity contracts
├── test/               Fork tests against live Morpho Blue
├── script/             Deployment scripts
├── bot/                TypeScript off-chain bot
│   └── src/            Bot source (config, markets, positions, simulation, execution, db, monitoring)
```

## Commands

### Contracts (from repo root)
```bash
forge build                                    # Compile
forge test --fork-url $MAINNET_RPC_URL -vvv    # Run fork tests (requires .env with MAINNET_RPC_URL)
forge test --gas-report --fork-url $MAINNET_RPC_URL  # Gas profiling
forge fmt                                      # Format Solidity
forge script script/Deploy.s.sol --rpc-url $MAINNET_RPC_URL --broadcast  # Deploy
```

### Bot (from bot/)
```bash
pnpm install                # Install deps
npx tsc --noEmit            # Type-check
pnpm start                  # Run bot (requires .env)
pnpm start:dry              # Run in dry-run mode
```

## Architecture

### On-Chain: `MorphoLiquidator.sol`
- Single contract, no proxies. Immutable `MORPHO` + `owner`.
- `liquidate()` → encodes `CallbackData{collateralToken, loanToken, minProfit, SwapStep[]}` → calls `MORPHO.liquidate()` → callback executes swap steps → Morpho pulls repayment → profit swept to caller.
- `approvedTargets` mapping gates which DEX contracts can be called (prevents draining via malicious calldata).
- Swap routing is fully calldata-driven — bot computes optimal route off-chain, encodes as `SwapStep[]`.

### Off-Chain: TypeScript Bot
- **Market Discovery**: Morpho GraphQL API bootstrap + `CreateMarket` event scanning.
- **Position Tracking**: Per-market borrower sets via `Borrow`/`SupplyCollateral` events, multicall batched position reads.
- **Health Check**: `borrowAssets * ORACLE_PRICE_SCALE > collateral * oraclePrice * LLTV / WAD`. Off-chain interest accrual via `IRM.borrowRateView()` + Taylor expansion (catches positions going underwater between blocks).
- **Simulation**: `eth_call` of `MorphoLiquidator.liquidate()` to verify success + extract seized/repaid.
- **Swap Quoting**: Uniswap V3 QuoterV2 — tries all fee tiers single-hop, then multi-hop via WETH.
- **Profit Calculation**: Converts loan token profit → ETH (WETH direct, stablecoins via Chainlink ETH/USD, others via Uniswap quote). Subtracts gas cost + 70% builder bribe. Checks against `MIN_PROFIT_USD` threshold.
- **Gas Estimation**: Rolling 5-block baseFee tracker, EIP-1559 params with 13% buffer for next-block fee prediction.
- **Execution**: Direct tx for now (Phase 4 adds Flashbots bundles).

## Key Addresses (Mainnet)
- Morpho Blue: `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`
- Uniswap V3 SwapRouter02: `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`
- Uniswap V3 QuoterV2: `0x61fFE014bA17989E743c5F6cB21bF9697530B21e`

## Environment Variables
See `.env.example` for full list. Required: `PRIVATE_KEY`, `HTTP_RPC_URL`, `WS_RPC_URL`, `FLASHBOTS_AUTH_KEY`, `FLASH_LIQUIDATOR`.

## Conventions
- Foundry config: `optimizer_runs = 999999`, `evm_version = cancun`, `via_ir = false`
- Solidity: custom errors (no strings), immutables over storage, no events in hot path
- TypeScript: viem for all RPC, better-sqlite3 for persistence, hono for HTTP
- Tests: mainnet fork tests with real Morpho markets, `vm.mockCall` for oracle price manipulation
