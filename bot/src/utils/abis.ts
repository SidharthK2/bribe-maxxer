export const morphoAbi = [
  {
    name: "liquidate",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "marketParams",
        type: "tuple",
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
      { name: "borrower", type: "address" },
      { name: "seizedAssets", type: "uint256" },
      { name: "repaidShares", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
    ],
  },
  {
    name: "position",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "supplyShares", type: "uint256" },
      { name: "borrowShares", type: "uint128" },
      { name: "collateral", type: "uint128" },
    ],
  },
  {
    name: "market",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "totalSupplyAssets", type: "uint128" },
      { name: "totalSupplyShares", type: "uint128" },
      { name: "totalBorrowAssets", type: "uint128" },
      { name: "totalBorrowShares", type: "uint128" },
      { name: "lastUpdate", type: "uint128" },
      { name: "fee", type: "uint128" },
    ],
  },
  {
    name: "idToMarketParams",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "loanToken", type: "address" },
      { name: "collateralToken", type: "address" },
      { name: "oracle", type: "address" },
      { name: "irm", type: "address" },
      { name: "lltv", type: "uint256" },
    ],
  },
  // Events
  {
    name: "Borrow",
    type: "event",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "caller", type: "address", indexed: false },
      { name: "onBehalf", type: "address", indexed: true },
      { name: "receiver", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
  {
    name: "Repay",
    type: "event",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "onBehalf", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
  {
    name: "SupplyCollateral",
    type: "event",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "onBehalf", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
    ],
  },
  {
    name: "WithdrawCollateral",
    type: "event",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "caller", type: "address", indexed: false },
      { name: "onBehalf", type: "address", indexed: true },
      { name: "receiver", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
    ],
  },
  {
    name: "Liquidate",
    type: "event",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "borrower", type: "address", indexed: true },
      { name: "repaidAssets", type: "uint256", indexed: false },
      { name: "repaidShares", type: "uint256", indexed: false },
      { name: "seizedAssets", type: "uint256", indexed: false },
      { name: "badDebtAssets", type: "uint256", indexed: false },
      { name: "badDebtShares", type: "uint256", indexed: false },
    ],
  },
  {
    name: "CreateMarket",
    type: "event",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      {
        name: "marketParams",
        type: "tuple",
        indexed: false,
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
    ],
  },
] as const;

export const oracleAbi = [
  {
    name: "price",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const erc20Abi = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

export const morphoLiquidatorAbi = [
  {
    name: "setApprovedCaller",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "caller", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
  {
    name: "liquidate",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "marketParams",
        type: "tuple",
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
      { name: "borrower", type: "address" },
      { name: "seizedAssets", type: "uint256" },
      { name: "repaidShares", type: "uint256" },
      { name: "minProfit", type: "uint256" },
      {
        name: "swaps",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "seized", type: "uint256" },
      { name: "repaid", type: "uint256" },
    ],
  },
] as const;

export const irmAbi = [
  {
    name: "borrowRateView",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "marketParams",
        type: "tuple",
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
      {
        name: "market",
        type: "tuple",
        components: [
          { name: "totalSupplyAssets", type: "uint128" },
          { name: "totalSupplyShares", type: "uint128" },
          { name: "totalBorrowAssets", type: "uint128" },
          { name: "totalBorrowShares", type: "uint128" },
          { name: "lastUpdate", type: "uint128" },
          { name: "fee", type: "uint128" },
        ],
      },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const chainlinkAbi = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

export const uniswapQuoterAbi = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  {
    name: "quoteExactInput",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "path", type: "bytes" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96AfterList", type: "uint160[]" },
      { name: "initializedTicksCrossedList", type: "uint32[]" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;
