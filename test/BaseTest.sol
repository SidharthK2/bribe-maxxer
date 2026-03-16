// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { MorphoLiquidator } from "../src/MorphoLiquidator.sol";
import { IMorpho, IMorphoStaticTyping, MarketParams, Id } from "@morpho-blue/interfaces/IMorpho.sol";
import { IOracle } from "@morpho-blue/interfaces/IOracle.sol";
import { MarketParamsLib } from "@morpho-blue/libraries/MarketParamsLib.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ISwapRouter } from "./interfaces/ISwapRouter.sol";

/// @notice Base test contract with mainnet fork setup and real Morpho Blue markets.
abstract contract BaseTest is Test {
    using MarketParamsLib for MarketParams;

    // ── Mainnet Addresses
    // ───────────────────────────────────────────────

    address constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant UNISWAP_V3_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address constant UNISWAP_UNIVERSAL_ROUTER = 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD;

    // Tokens
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;

    // ── State
    // ───────────────────────────────────────────────────────────

    IMorpho morpho;
    IMorphoStaticTyping morphoStatic;
    MorphoLiquidator liquidator;
    ISwapRouter uniRouter;

    address deployer;
    address bot;
    address borrower;
    address supplier;

    // ── wstETH/USDC Market (86% LLTV, Chainlink oracle) ─────────────────
    MarketParams wstethUsdcParams;
    Id wstethUsdcId;

    function setUp() public virtual {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        // Actors
        deployer = makeAddr("deployer");
        bot = makeAddr("bot");
        borrower = makeAddr("borrower");
        supplier = makeAddr("supplier");

        // Core contracts
        morpho = IMorpho(MORPHO_BLUE);
        morphoStatic = IMorphoStaticTyping(MORPHO_BLUE);
        uniRouter = ISwapRouter(UNISWAP_V3_ROUTER);

        // Deploy MorphoLiquidator
        address[] memory targets = new address[](2);
        targets[0] = UNISWAP_V3_ROUTER;
        targets[1] = UNISWAP_UNIVERSAL_ROUTER;

        vm.prank(deployer);
        liquidator = new MorphoLiquidator(MORPHO_BLUE, targets);

        // Approve tokens on Morpho (for repayment pull) and Uniswap router (for swaps)
        vm.startPrank(deployer);
        liquidator.approveToken(USDC, MORPHO_BLUE, type(uint256).max);
        liquidator.approveToken(WETH, MORPHO_BLUE, type(uint256).max);
        liquidator.approveToken(WSTETH, UNISWAP_V3_ROUTER, type(uint256).max);
        liquidator.approveToken(WETH, UNISWAP_V3_ROUTER, type(uint256).max);
        liquidator.approveToken(USDC, UNISWAP_V3_ROUTER, type(uint256).max);
        liquidator.setApprovedCaller(bot, true);
        vm.stopPrank();

        _setupWstethUsdcMarket();
    }

    function _setupWstethUsdcMarket() internal {
        // Known wstETH/USDC 86% LLTV market on Morpho Blue mainnet
        bytes32 knownId = 0xb323495f7e4148be5643a4ea4a8221eef163e4bccfdedc2a6f4696baacbc86cc;

        (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) =
            morphoStatic.idToMarketParams(Id.wrap(knownId));

        if (loanToken == address(0)) return;

        wstethUsdcParams = MarketParams({
            loanToken: loanToken, collateralToken: collateralToken, oracle: oracle, irm: irm, lltv: lltv
        });
        wstethUsdcId = wstethUsdcParams.id();
    }

    // ── Helpers
    // ─────────────────────────────────────────────────────────

    function _createUnderwaterPosition(
        MarketParams memory marketParams,
        uint256 collateralAmount,
        uint256 borrowAmount,
        uint256 priceDivisor
    )
        internal
    {
        // Supply liquidity
        deal(marketParams.loanToken, supplier, borrowAmount * 2);
        vm.startPrank(supplier);
        IERC20(marketParams.loanToken).approve(MORPHO_BLUE, type(uint256).max);
        morpho.supply(marketParams, borrowAmount * 2, 0, supplier, "");
        vm.stopPrank();

        // Borrower supplies collateral and borrows
        deal(marketParams.collateralToken, borrower, collateralAmount);
        vm.startPrank(borrower);
        IERC20(marketParams.collateralToken).approve(MORPHO_BLUE, type(uint256).max);
        morpho.supplyCollateral(marketParams, collateralAmount, borrower, "");
        morpho.borrow(marketParams, borrowAmount, 0, borrower, borrower);
        vm.stopPrank();

        // Crash oracle price
        uint256 realPrice = IOracle(marketParams.oracle).price();
        uint256 crashedPrice = realPrice / priceDivisor;
        vm.mockCall(marketParams.oracle, abi.encodeWithSelector(IOracle.price.selector), abi.encode(crashedPrice));
    }

    /// @notice Builds UniswapV3 SwapRouter02 exactInputSingle calldata using proper interface encoding.
    function _buildUniV3SingleSwap(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOutMin
    )
        internal
        view
        returns (MorphoLiquidator.SwapStep memory)
    {
        bytes memory swapCalldata = abi.encodeCall(
            ISwapRouter.exactInputSingle,
            (ISwapRouter.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: address(liquidator),
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMin,
                    sqrtPriceLimitX96: 0
                }))
        );

        return MorphoLiquidator.SwapStep({ target: UNISWAP_V3_ROUTER, callData: swapCalldata });
    }

    /// @notice Builds UniswapV3 SwapRouter02 exactInput (multi-hop) calldata using proper interface encoding.
    function _buildUniV3MultiHopSwap(
        bytes memory path,
        uint256 amountIn,
        uint256 amountOutMin
    )
        internal
        view
        returns (MorphoLiquidator.SwapStep memory)
    {
        bytes memory swapCalldata = abi.encodeCall(
            ISwapRouter.exactInput,
            (ISwapRouter.ExactInputParams({
                    path: path, recipient: address(liquidator), amountIn: amountIn, amountOutMinimum: amountOutMin
                }))
        );

        return MorphoLiquidator.SwapStep({ target: UNISWAP_V3_ROUTER, callData: swapCalldata });
    }

    /// @notice Encodes a UniswapV3 multi-hop path.
    function _encodePath(
        address tokenA,
        uint24 fee1,
        address tokenB,
        uint24 fee2,
        address tokenC
    )
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(tokenA, fee1, tokenB, fee2, tokenC);
    }
}
