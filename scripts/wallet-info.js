#!/usr/bin/env node

const { ethers } = require("ethers");
require('dotenv').config();

// Get private key from command line argument or environment variable
const privateKey = process.argv[2] || process.env.PAYER_PRIVATE_KEY || process.env.HOT_WALLET_PK;

if (!privateKey) {
    console.error("Usage: node wallet-info.js <private_key>");
    console.error("Or set PAYER_PRIVATE_KEY in .env file");
    process.exit(1);
}

async function getWalletInfo() {
    try {
        // Remove 0x prefix if present
        const cleanPrivateKey = privateKey.replace(/^0x/, '');
        
        // Validate private key format
        if (!/^[a-fA-F0-9]{64}$/.test(cleanPrivateKey)) {
            throw new Error("Invalid private key format. Should be 64 hex characters.");
        }
        
        // Create wallet from private key
        const wallet = new ethers.Wallet(`0x${cleanPrivateKey}`);
        
        console.log("=== Wallet Information ===");
        console.log(`Address: ${wallet.address}`);
        console.log(`Private Key: 0x${cleanPrivateKey}`);
        console.log(`Public Key: ${wallet.publicKey}`);
        
        // If RPC_URL is available, get balance
        if (process.env.RPC_URL) {
            try {
                const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
                const connectedWallet = wallet.connect(provider);
                const balance = await connectedWallet.provider.getBalance(wallet.address);
                const balanceEth = ethers.formatEther(balance);
                
                console.log(`Balance: ${balanceEth} ETH`);
                
                // Get network info
                const network = await provider.getNetwork();
                console.log(`Network: ${network.name} (Chain ID: ${network.chainId})`);
                
            } catch (error) {
                console.log(`Balance: Unable to fetch (${error.message})`);
            }
        }
        
    } catch (error) {
        console.error("Error getting wallet info:", error.message);
        process.exit(1);
    }
}

getWalletInfo();
