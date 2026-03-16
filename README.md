# bribe-maxxer

Capital-free MEV liquidation bot for [Morpho Blue](https://docs.morpho.org/) on Ethereum mainnet.

Seizes collateral via Morpho's native `onMorphoLiquidate` callback, swaps to loan token on-chain (Uniswap V3), and Morpho pulls repayment — zero upfront capital required. Submits via Flashbots MEV-Share for frontrunning protection.

## How it works

```
Oracle price drops
        |
        v
Bot detects unhealthy position (in-memory, event-driven)
        |
        v
Simulate liquidation via eth_call
        |
        v
Quote swap: collateral -> loan token (Uniswap V3)
        |
        v
Calculate profit (minus gas + 90% builder bribe)
        |
        v
Sign EIP-1559 tx, send Flashbots bundle
        |
        v
MorphoLiquidator.liquidate()
   -> Morpho seizes collateral, sends to our contract
   -> onMorphoLiquidate callback fires
   -> Swap collateral for loan token on Uniswap
   -> Morpho pulls repayment
   -> Profit stays in contract
```

## Architecture

```
/                         Foundry root (contracts)
├── src/                  Solidity — MorphoLiquidator with callback swap routing
├── test/                 Fork tests against live Morpho Blue markets
├── script/               Deployment + token approval scripts
├── bot/                  TypeScript off-chain bot
│   └── src/
│       ├── core/         Event-driven orchestrator + position cache
│       ├── markets/      Market discovery (Morpho API + on-chain events)
│       ├── positions/    Health checking, interest accrual, borrower scanning
│       ├── simulation/   eth_call simulation, Uniswap quoting, profit calc
│       ├── execution/    Flashbots bundles, tx signing, nonce management
│       ├── db/           SQLite persistence
│       └── monitoring/   HTTP health server
├── docker-compose.yml    One-command deployment
└── .github/workflows/    CI: Solidity + Bot type-check + Docker build
```

### On-chain: `MorphoLiquidator.sol`

Single contract, no proxies. Immutable `MORPHO` + `owner`.

- `liquidate()` encodes swap steps as calldata, calls `MORPHO.liquidate()` with callback data
- `onMorphoLiquidate` callback executes swap steps sequentially, Morpho pulls repayment, profit swept to caller
- `approvedTargets` mapping gates which DEX contracts can be called (prevents drain via malicious calldata)
- `approvedCallers` mapping restricts who can call `liquidate()`
- On-chain `minProfit` parameter as safety backstop

### Off-chain: TypeScript bot

**Event-driven architecture** — reacts to oracle price changes and Morpho position events instead of polling every borrower every block.

- **Market discovery**: Morpho GraphQL API bootstrap + `CreateMarket` event scanning
- **Position cache**: In-memory position state, updated from Morpho events (Borrow, Repay, SupplyCollateral, WithdrawCollateral, Liquidate)
- **Oracle diffing**: Compares oracle prices block-to-block, only evaluates markets where price changed
- **Health check**: Exact Morpho math — two-step truncating division, virtual share offsets, off-chain interest accrual via IRM Taylor expansion
- **Execution**: Flashbots MEV-Share bundles with 90% MEV refund, Flashbots Protect fallback
- **Safety**: Gas circuit breaker, Chainlink staleness validation, on-chain minProfit, graceful shutdown

## Setup

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- Node.js 22+
- pnpm

### Install

```bash
git clone --recursive https://github.com/SidharthK2/bribe-maxxer.git
cd bribe-maxxer

# Contracts
forge build

# Bot
cd bot && pnpm install
```

### Configure

```bash
cp .env.example .env
# Fill in:
#   PRIVATE_KEY          — bot wallet (needs ~0.01 ETH for gas)
#   HTTP_RPC_URL         — Alchemy/Infura HTTP endpoint
#   WS_RPC_URL           — Alchemy/Infura WebSocket endpoint
#   FLASHBOTS_AUTH_KEY   — generate with: cast wallet new
#   FLASH_LIQUIDATOR     — set after deploying contract
```

### Deploy contract

```bash
# Deploy MorphoLiquidator
forge script script/Deploy.s.sol --rpc-url $MAINNET_RPC_URL --broadcast --verify

# Set your bot as approved caller
cast send $FLASH_LIQUIDATOR "setApprovedCaller(address,bool)" $BOT_ADDRESS true --rpc-url $MAINNET_RPC_URL --private-key $PRIVATE_KEY
```

### Run

```bash
# Dry run (logs opportunities, doesn't execute)
cd bot && pnpm start:dry

# Live
cd bot && pnpm start

# Docker
docker compose up -d
docker compose logs -f bot
```

### Monitor

```bash
curl localhost:3000/health       # uptime, block, cached positions
curl localhost:3000/markets      # tracked markets + LLTV/LIF
curl localhost:3000/liquidations # recent liquidations + profit stats
```

## Development

### Contracts

```bash
forge build                                              # compile
forge test --fork-url $MAINNET_RPC_URL -vvv              # fork tests (19 tests)
forge test --gas-report --fork-url $MAINNET_RPC_URL      # gas profiling
forge fmt                                                # format
```

### Bot

```bash
cd bot
pnpm install          # install deps
npx tsc --noEmit      # type-check
pnpm start:dry        # run in dry-run mode
```

## Key addresses (mainnet)

| Contract | Address |
|---|---|
| Morpho Blue | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
| Uniswap V3 SwapRouter02 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` |
| Uniswap V3 QuoterV2 | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |
| Chainlink ETH/USD | `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` |

## License

MIT
