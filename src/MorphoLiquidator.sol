// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IMorphoLiquidateCallback } from "@morpho-blue/interfaces/IMorphoCallbacks.sol";
import { IMorpho, MarketParams } from "@morpho-blue/interfaces/IMorpho.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MorphoLiquidator
/// @notice Capital-free liquidator for Morpho Blue markets using native liquidation callbacks.
/// @dev Seizes collateral via callback, executes arbitrary swap steps (Uni V3, Curve, etc.),
///      and lets Morpho pull the loan token repayment. Profit is swept to the caller.
///      Swap routing is fully calldata-driven — the off-chain bot computes optimal routes
///      and encodes them as SwapStep[] passed through Morpho's data parameter.
contract MorphoLiquidator is IMorphoLiquidateCallback {
    using SafeERC20 for IERC20;

    // ── Errors
    // ──────────────────────────────────────────────────────────

    error NotOwner();
    error NotMorpho();
    error NotApprovedCaller();
    error TargetNotApproved(address target);
    error SwapFailed(uint256 index);
    error InsufficientProfit(uint256 actual, uint256 minimum);
    error LengthMismatch();

    // ── Structs
    // ─────────────────────────────────────────────────────────

    /// @param target DEX router or pool to call.
    /// @param callData Exact calldata for the swap (e.g., UniV3 exactInputSingle).
    struct SwapStep {
        address target;
        bytes callData;
    }

    /// @dev Encoded as `data` in Morpho's liquidate() call, decoded in the callback.
    struct CallbackData {
        address collateralToken;
        address loanToken;
        uint256 minProfit;
        SwapStep[] swaps;
    }

    // ── Immutables
    // ──────────────────────────────────────────────────────

    IMorpho public immutable MORPHO;
    address public immutable owner;

    // ── Storage
    // ─────────────────────────────────────────────────────────

    mapping(address => bool) public approvedTargets;
    mapping(address => bool) public approvedCallers;

    // ── Constructor
    // ─────────────────────────────────────────────────────

    constructor(address morpho_, address[] memory initialTargets) {
        MORPHO = IMorpho(morpho_);
        owner = msg.sender;
        for (uint256 i; i < initialTargets.length; ++i) {
            approvedTargets[initialTargets[i]] = true;
        }
    }

    // ── Entry Point
    // ─────────────────────────────────────────────────────

    /// @notice Execute a capital-free liquidation on Morpho Blue.
    /// @param marketParams The Morpho market parameters.
    /// @param borrower The underwater borrower.
    /// @param seizedAssets Amount of collateral to seize (pass 0 to use repaidShares instead).
    /// @param repaidShares Amount of debt shares to repay (pass 0 to use seizedAssets instead).
    /// @param minProfit Minimum profit in loan token units; reverts if not met.
    /// @param swaps Ordered swap steps to convert collateral → loan token.
    function liquidate(
        MarketParams calldata marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        uint256 minProfit,
        SwapStep[] calldata swaps
    )
        external
        returns (uint256 seized, uint256 repaid)
    {
        if (msg.sender != owner && !approvedCallers[msg.sender]) revert NotApprovedCaller();

        bytes memory data = abi.encode(
            CallbackData({
                collateralToken: marketParams.collateralToken,
                loanToken: marketParams.loanToken,
                minProfit: minProfit,
                swaps: swaps
            })
        );

        (seized, repaid) = MORPHO.liquidate(marketParams, borrower, seizedAssets, repaidShares, data);

        // After Morpho has pulled repayment, remaining loanToken balance is profit
        uint256 profit = IERC20(marketParams.loanToken).balanceOf(address(this));
        if (profit < minProfit) revert InsufficientProfit(profit, minProfit);

        // Sweep profit + any collateral dust to caller
        _sweep(marketParams.loanToken, msg.sender);
        _sweep(marketParams.collateralToken, msg.sender);
    }

    // ── Morpho Callback
    // ─────────────────────────────────────────────────

    /// @notice Morpho liquidation callback. Executes the swap sequence.
    /// @dev Only callable by MORPHO. Collateral is already in this contract when called.
    ///      After this returns, Morpho pulls repaidAssets of loan token via safeTransferFrom.
    function onMorphoLiquidate(uint256, bytes calldata data) external {
        if (msg.sender != address(MORPHO)) revert NotMorpho();

        CallbackData memory cb = abi.decode(data, (CallbackData));

        for (uint256 i; i < cb.swaps.length; ++i) {
            address target = cb.swaps[i].target;
            if (!approvedTargets[target]) revert TargetNotApproved(target);

            (bool success,) = target.call(cb.swaps[i].callData);
            if (!success) revert SwapFailed(i);
        }

        // After all swaps, this contract must hold >= repaidAssets of loanToken.
        // Morpho will pull exactly repaidAssets via safeTransferFrom.
        // If balance is insufficient, Morpho's transferFrom will revert.
    }

    // ── Admin
    // ───────────────────────────────────────────────────────────

    /// @notice Approve or revoke a call target (DEX router/pool).
    function setApprovedTarget(address target, bool approved) external {
        if (msg.sender != owner) revert NotOwner();
        approvedTargets[target] = approved;
    }

    /// @notice Batch approve/revoke multiple targets.
    function setApprovedTargets(address[] calldata targets, bool[] calldata approved) external {
        if (msg.sender != owner) revert NotOwner();
        if (targets.length != approved.length) revert LengthMismatch();
        for (uint256 i; i < targets.length; ++i) {
            approvedTargets[targets[i]] = approved[i];
        }
    }

    /// @notice Approve or revoke a caller for liquidate().
    function setApprovedCaller(address caller, bool approved) external {
        if (msg.sender != owner) revert NotOwner();
        approvedCallers[caller] = approved;
    }

    /// @notice Approve this contract to spend a token on a spender (for DEX routers using transferFrom).
    function approveToken(address token, address spender, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        IERC20(token).forceApprove(spender, amount);
    }

    /// @notice Rescue tokens stuck in the contract.
    function sweep(address token, address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Rescue ETH stuck in the contract.
    function sweepETH(address payable to) external {
        if (msg.sender != owner) revert NotOwner();
        (bool success,) = to.call{ value: address(this).balance }("");
        require(success);
    }

    // ── Internal
    // ────────────────────────────────────────────────────────

    function _sweep(address token, address to) internal {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).safeTransfer(to, balance);
        }
    }

    receive() external payable { }
}
