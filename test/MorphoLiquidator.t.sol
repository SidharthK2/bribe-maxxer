// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { BaseTest } from "./BaseTest.sol";
import { MorphoLiquidator } from "../src/MorphoLiquidator.sol";
import { IMorpho, MarketParams, Id, Market, Position } from "@morpho-blue/interfaces/IMorpho.sol";
import { IOracle } from "@morpho-blue/interfaces/IOracle.sol";
import { MarketParamsLib } from "@morpho-blue/libraries/MarketParamsLib.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { console2 as console } from "forge-std/Test.sol";

contract MorphoLiquidatorTest is BaseTest {
    using MarketParamsLib for MarketParams;

    // ─── Liquidation: wstETH/USDC
    // ───────────────────────────────────────

    function testLiquidateWstethUsdcSingleHop() public {
        // Skip if market not found on fork
        if (wstethUsdcParams.loanToken == address(0)) return;

        // Supply 10 wstETH as collateral, borrow USDC
        uint256 collateralAmount = 10 ether;
        // Borrow a conservative amount that's healthy at current price but unhealthy after crash
        // At ~$3000 wstETH and 86% LLTV, max borrow ~ 10 * 3000 * 0.86 = $25,800 USDC
        uint256 borrowAmount = 20_000e6; // $20k USDC — healthy at real price

        _createUnderwaterPosition(wstethUsdcParams, collateralAmount, borrowAmount, 3);

        // Verify position exists
        Position memory pos = morpho.position(wstethUsdcId, borrower);
        assertGt(pos.borrowShares, 0, "should have borrow shares");
        assertGt(pos.collateral, 0, "should have collateral");

        // Bot starts with zero capital
        assertEq(IERC20(USDC).balanceOf(bot), 0, "bot must start with 0 USDC");

        // Build swap: wstETH → USDC via UniV3 (0.05% fee tier for wstETH/USDC or wstETH → WETH → USDC)
        // Use multi-hop: wstETH → WETH (0.01%) → USDC (0.05%)
        MorphoLiquidator.SwapStep[] memory swaps = new MorphoLiquidator.SwapStep[](1);
        bytes memory path = _encodePath(WSTETH, 100, WETH, 500, USDC); // 0.01% then 0.05%
        swaps[0] = _buildUniV3MultiHopSwap(path, uint256(pos.collateral), 0);

        // Execute liquidation — capital free
        vm.prank(bot);
        (uint256 seized, uint256 repaid) = liquidator.liquidate(
            wstethUsdcParams,
            borrower,
            uint256(pos.collateral), // seize all collateral
            0,
            0, // minProfit = 0 for test (we verify profit separately)
            swaps
        );

        assertGt(seized, 0, "must seize collateral");
        assertGt(repaid, 0, "must repay debt");

        // Bot should have received profit in USDC
        uint256 profit = IERC20(USDC).balanceOf(bot);
        assertGt(profit, 0, "bot must profit in USDC");
        console.log("Profit (USDC):", profit);

        // Contract should hold zero residual
        assertEq(IERC20(USDC).balanceOf(address(liquidator)), 0, "no residual USDC in contract");
        assertEq(IERC20(WSTETH).balanceOf(address(liquidator)), 0, "no residual wstETH in contract");

        // Position should be cleared
        Position memory posAfter = morpho.position(wstethUsdcId, borrower);
        assertEq(posAfter.collateral, 0, "collateral must be 0 after full seizure");

        vm.clearMockedCalls();
    }

    function testLiquidatePartialSeizure() public {
        if (wstethUsdcParams.loanToken == address(0)) return;

        uint256 collateralAmount = 10 ether;
        uint256 borrowAmount = 20_000e6;

        _createUnderwaterPosition(wstethUsdcParams, collateralAmount, borrowAmount, 3);

        Position memory pos = morpho.position(wstethUsdcId, borrower);
        uint256 halfCollateral = uint256(pos.collateral) / 2;

        // Swap only half
        MorphoLiquidator.SwapStep[] memory swaps = new MorphoLiquidator.SwapStep[](1);
        bytes memory path = _encodePath(WSTETH, 100, WETH, 500, USDC);
        swaps[0] = _buildUniV3MultiHopSwap(path, halfCollateral, 0);

        vm.prank(bot);
        liquidator.liquidate(wstethUsdcParams, borrower, halfCollateral, 0, 0, swaps);

        // Position should be partially remaining
        Position memory posAfter = morpho.position(wstethUsdcId, borrower);
        assertGt(posAfter.collateral, 0, "should have remaining collateral");
        assertLt(posAfter.collateral, pos.collateral, "collateral must have decreased");
        assertLt(posAfter.borrowShares, pos.borrowShares, "borrow shares must have decreased");

        vm.clearMockedCalls();
    }

    // ─── MinProfit Protection
    // ───────────────────────────────────────────

    function testMinProfitReverts() public {
        if (wstethUsdcParams.loanToken == address(0)) return;

        uint256 collateralAmount = 10 ether;
        uint256 borrowAmount = 20_000e6;

        _createUnderwaterPosition(wstethUsdcParams, collateralAmount, borrowAmount, 3);

        Position memory pos = morpho.position(wstethUsdcId, borrower);

        MorphoLiquidator.SwapStep[] memory swaps = new MorphoLiquidator.SwapStep[](1);
        bytes memory path = _encodePath(WSTETH, 100, WETH, 500, USDC);
        swaps[0] = _buildUniV3MultiHopSwap(path, uint256(pos.collateral), 0);

        // Set absurdly high minProfit — should revert
        vm.prank(bot);
        vm.expectRevert(); // InsufficientProfit
        liquidator.liquidate(
            wstethUsdcParams,
            borrower,
            uint256(pos.collateral),
            0,
            type(uint256).max, // impossible profit target
            swaps
        );

        vm.clearMockedCalls();
    }

    // ─── Healthy Position Reverts
    // ───────────────────────────────────────

    function testHealthyPositionReverts() public {
        if (wstethUsdcParams.loanToken == address(0)) return;

        // Create position WITHOUT crashing oracle
        uint256 collateralAmount = 10 ether;
        uint256 borrowAmount = 10_000e6; // very conservative borrow

        // Supply liquidity
        deal(wstethUsdcParams.loanToken, supplier, borrowAmount * 2);
        vm.startPrank(supplier);
        IERC20(wstethUsdcParams.loanToken).approve(MORPHO_BLUE, type(uint256).max);
        morpho.supply(wstethUsdcParams, borrowAmount * 2, 0, supplier, "");
        vm.stopPrank();

        // Borrower opens position
        deal(wstethUsdcParams.collateralToken, borrower, collateralAmount);
        vm.startPrank(borrower);
        IERC20(wstethUsdcParams.collateralToken).approve(MORPHO_BLUE, type(uint256).max);
        morpho.supplyCollateral(wstethUsdcParams, collateralAmount, borrower, "");
        morpho.borrow(wstethUsdcParams, borrowAmount, 0, borrower, borrower);
        vm.stopPrank();

        Position memory pos = morpho.position(wstethUsdcId, borrower);

        MorphoLiquidator.SwapStep[] memory swaps = new MorphoLiquidator.SwapStep[](1);
        bytes memory path = _encodePath(WSTETH, 100, WETH, 500, USDC);
        swaps[0] = _buildUniV3MultiHopSwap(path, uint256(pos.collateral), 0);

        // Position is healthy — Morpho should revert
        vm.prank(bot);
        vm.expectRevert();
        liquidator.liquidate(wstethUsdcParams, borrower, uint256(pos.collateral), 0, 0, swaps);
    }

    // ─── Caller Access Control
    // ────────────────────────────────────────

    function testLiquidateRevertsUnapprovedCaller() public {
        if (wstethUsdcParams.loanToken == address(0)) return;

        uint256 collateralAmount = 10 ether;
        uint256 borrowAmount = 20_000e6;
        _createUnderwaterPosition(wstethUsdcParams, collateralAmount, borrowAmount, 3);

        Position memory pos = morpho.position(wstethUsdcId, borrower);
        MorphoLiquidator.SwapStep[] memory swaps = new MorphoLiquidator.SwapStep[](1);
        bytes memory path = _encodePath(WSTETH, 100, WETH, 500, USDC);
        swaps[0] = _buildUniV3MultiHopSwap(path, uint256(pos.collateral), 0);

        // Random address is not an approved caller
        address rando = makeAddr("rando");
        vm.prank(rando);
        vm.expectRevert(MorphoLiquidator.NotApprovedCaller.selector);
        liquidator.liquidate(wstethUsdcParams, borrower, uint256(pos.collateral), 0, 0, swaps);

        vm.clearMockedCalls();
    }

    function testOwnerCanCallLiquidateWithoutApproval() public {
        if (wstethUsdcParams.loanToken == address(0)) return;

        uint256 collateralAmount = 10 ether;
        uint256 borrowAmount = 20_000e6;
        _createUnderwaterPosition(wstethUsdcParams, collateralAmount, borrowAmount, 3);

        Position memory pos = morpho.position(wstethUsdcId, borrower);
        MorphoLiquidator.SwapStep[] memory swaps = new MorphoLiquidator.SwapStep[](1);
        bytes memory path = _encodePath(WSTETH, 100, WETH, 500, USDC);
        swaps[0] = _buildUniV3MultiHopSwap(path, uint256(pos.collateral), 0);

        // Owner (deployer) can call without being in approvedCallers
        vm.prank(deployer);
        (uint256 seized,) = liquidator.liquidate(wstethUsdcParams, borrower, uint256(pos.collateral), 0, 0, swaps);
        assertGt(seized, 0, "owner must be able to liquidate");

        vm.clearMockedCalls();
    }

    function testSetApprovedCallerOnlyOwner() public {
        vm.prank(bot);
        vm.expectRevert(MorphoLiquidator.NotOwner.selector);
        liquidator.setApprovedCaller(bot, true);
    }

    // ─── Callback Access Control
    // ────────────────────────────────────────

    function testCallbackOnlyMorpho() public {
        bytes memory data = abi.encode(
            MorphoLiquidator.CallbackData({
                collateralToken: WSTETH, loanToken: USDC, minProfit: 0, swaps: new MorphoLiquidator.SwapStep[](0)
            })
        );

        // Direct call from non-Morpho address must revert
        vm.prank(bot);
        vm.expectRevert(MorphoLiquidator.NotMorpho.selector);
        liquidator.onMorphoLiquidate(0, data);
    }

    // ─── Unapproved Target Reverts
    // ──────────────────────────────────────

    function testUnapprovedTargetReverts() public {
        if (wstethUsdcParams.loanToken == address(0)) return;

        uint256 collateralAmount = 10 ether;
        uint256 borrowAmount = 20_000e6;

        _createUnderwaterPosition(wstethUsdcParams, collateralAmount, borrowAmount, 3);

        Position memory pos = morpho.position(wstethUsdcId, borrower);

        // Build swap targeting an unapproved address
        address unapproved = makeAddr("malicious_dex");
        MorphoLiquidator.SwapStep[] memory swaps = new MorphoLiquidator.SwapStep[](1);
        swaps[0] = MorphoLiquidator.SwapStep({ target: unapproved, callData: hex"deadbeef" });

        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(MorphoLiquidator.TargetNotApproved.selector, unapproved));
        liquidator.liquidate(wstethUsdcParams, borrower, uint256(pos.collateral), 0, 0, swaps);

        vm.clearMockedCalls();
    }

    // ─── Admin: Sweep
    // ───────────────────────────────────────────────────

    function testSweepOnlyOwner() public {
        vm.prank(bot);
        vm.expectRevert(MorphoLiquidator.NotOwner.selector);
        liquidator.sweep(USDC, bot, 0);
    }

    function testSweepByOwner() public {
        deal(USDC, address(liquidator), 100e6);

        uint256 before = IERC20(USDC).balanceOf(deployer);
        vm.prank(deployer);
        liquidator.sweep(USDC, deployer, 100e6);
        uint256 received = IERC20(USDC).balanceOf(deployer) - before;

        assertEq(received, 100e6, "owner must receive swept tokens");
        assertEq(IERC20(USDC).balanceOf(address(liquidator)), 0, "contract must be empty");
    }

    function testSweepETHOnlyOwner() public {
        vm.deal(address(liquidator), 1 ether);

        vm.prank(bot);
        vm.expectRevert(MorphoLiquidator.NotOwner.selector);
        liquidator.sweepETH(payable(bot));
    }

    function testSweepETHByOwner() public {
        vm.deal(address(liquidator), 1 ether);

        address payable recipient = payable(address(0xBEEF));
        uint256 before = recipient.balance;
        vm.prank(deployer);
        liquidator.sweepETH(recipient);
        uint256 received = recipient.balance - before;

        assertEq(received, 1 ether, "recipient must receive ETH");
        assertEq(address(liquidator).balance, 0, "contract must have no ETH");
    }

    // ─── Admin: Approved Targets
    // ────────────────────────────────────────

    function testSetApprovedTargetOnlyOwner() public {
        vm.prank(bot);
        vm.expectRevert(MorphoLiquidator.NotOwner.selector);
        liquidator.setApprovedTarget(makeAddr("new_dex"), true);
    }

    function testSetApprovedTarget() public {
        address newDex = makeAddr("new_dex");
        assertFalse(liquidator.approvedTargets(newDex));

        vm.prank(deployer);
        liquidator.setApprovedTarget(newDex, true);
        assertTrue(liquidator.approvedTargets(newDex));

        vm.prank(deployer);
        liquidator.setApprovedTarget(newDex, false);
        assertFalse(liquidator.approvedTargets(newDex));
    }

    function testSetApprovedTargetsBatch() public {
        address[] memory targets = new address[](3);
        targets[0] = makeAddr("dex1");
        targets[1] = makeAddr("dex2");
        targets[2] = makeAddr("dex3");

        bool[] memory approvals = new bool[](3);
        approvals[0] = true;
        approvals[1] = true;
        approvals[2] = true;

        vm.prank(deployer);
        liquidator.setApprovedTargets(targets, approvals);

        assertTrue(liquidator.approvedTargets(targets[0]));
        assertTrue(liquidator.approvedTargets(targets[1]));
        assertTrue(liquidator.approvedTargets(targets[2]));
    }

    function testSetApprovedTargetsLengthMismatch() public {
        address[] memory targets = new address[](2);
        bool[] memory approvals = new bool[](3);

        vm.prank(deployer);
        vm.expectRevert(MorphoLiquidator.LengthMismatch.selector);
        liquidator.setApprovedTargets(targets, approvals);
    }

    // ─── Admin: Token Approvals
    // ─────────────────────────────────────────

    function testApproveTokenOnlyOwner() public {
        vm.prank(bot);
        vm.expectRevert(MorphoLiquidator.NotOwner.selector);
        liquidator.approveToken(USDC, UNISWAP_V3_ROUTER, type(uint256).max);
    }

    // ─── Immutables
    // ─────────────────────────────────────────────────────

    function testImmutables() public view {
        assertEq(address(liquidator.MORPHO()), MORPHO_BLUE);
        assertEq(liquidator.owner(), deployer);
        assertTrue(liquidator.approvedTargets(UNISWAP_V3_ROUTER));
        assertTrue(liquidator.approvedTargets(UNISWAP_UNIVERSAL_ROUTER));
    }
}
