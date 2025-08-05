#!/usr/bin/env node

const { ethers } = require('ethers');
require('dotenv').config();

// Get private key from command line argument or environment variable
const privateKey = process.argv[2] || process.env.PAYER_PRIVATE_KEY || process.env.HOT_WALLET_PK;

if (!privateKey) {
  console.error('Usage: node derive-address.js <private_key>');
  console.error('Or set PAYER_PRIVATE_KEY in .env file');
  process.exit(1);
}

try {
  // Remove 0x prefix if present
  const cleanPrivateKey = privateKey.replace(/^0x/, '');

  // Validate private key format
  if (!/^[a-fA-F0-9]{64}$/.test(cleanPrivateKey)) {
    throw new Error('Invalid private key format. Should be 64 hex characters.');
  }

  // Create wallet from private key
  const wallet = new ethers.Wallet(`0x${cleanPrivateKey}`);

  // Output the address
  console.log(wallet.address);
} catch (error) {
  console.error('Error deriving address:', error.message);
  process.exit(1);
}
