// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console2 as console } from "forge-std/Script.sol";
import { MorphoLiquidator } from "../src/MorphoLiquidator.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Deploy is Script {
    // Morpho Blue mainnet
    address constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    // DEX routers
    address constant UNISWAP_V3_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address constant UNISWAP_UNIVERSAL_ROUTER = 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD;
    address constant CURVE_ROUTER = 0xF0d4c12A5768D806021F80a262B4d39d26C58b8D;

    // Common tokens on Morpho Blue markets
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;
    address constant WBTC = 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599;
    address constant CBETH = 0xBe9895146f7AF43049ca1c1AE358B0541Ea49704;

    function run() external {
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPk);

        // 1. Deploy with initial approved targets
        address[] memory targets = new address[](3);
        targets[0] = UNISWAP_V3_ROUTER;
        targets[1] = UNISWAP_UNIVERSAL_ROUTER;
        targets[2] = CURVE_ROUTER;

        MorphoLiquidator liq = new MorphoLiquidator(MORPHO_BLUE, targets);
        console.log("MorphoLiquidator deployed at:", address(liq));

        // 2. Approve loan tokens on Morpho (for repayment pull via safeTransferFrom)
        liq.approveToken(USDC, MORPHO_BLUE, type(uint256).max);
        liq.approveToken(WETH, MORPHO_BLUE, type(uint256).max);
        liq.approveToken(USDT, MORPHO_BLUE, type(uint256).max);
        liq.approveToken(DAI, MORPHO_BLUE, type(uint256).max);

        // 3. Approve collateral tokens on Uniswap V3 (for swap execution)
        address[] memory tokens = new address[](7);
        tokens[0] = WETH;
        tokens[1] = WSTETH;
        tokens[2] = USDC;
        tokens[3] = USDT;
        tokens[4] = DAI;
        tokens[5] = WBTC;
        tokens[6] = CBETH;

        for (uint256 i; i < tokens.length; ++i) {
            liq.approveToken(tokens[i], UNISWAP_V3_ROUTER, type(uint256).max);
            liq.approveToken(tokens[i], CURVE_ROUTER, type(uint256).max);
        }

        console.log("Token approvals set");

        vm.stopBroadcast();
    }
}
