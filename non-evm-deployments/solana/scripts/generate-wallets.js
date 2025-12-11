const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

console.log('🔑 Generating Solana wallets...\n');

// Generate treasury wallet (cold wallet)
const treasuryKeypair = Keypair.generate();
const treasuryPublicKey = treasuryKeypair.publicKey.toBase58();

console.log('Treasury Wallet (Cold Storage):');
console.log('  Public Key:', treasuryPublicKey);
console.log('  ⚠️  Save the private key securely if needed for testing\n');

// Generate hot wallet (for gas top-ups)
const hotWalletKeypair = Keypair.generate();
const hotWalletPublicKey = hotWalletKeypair.publicKey.toBase58();
const hotWalletPrivateKey = bs58.default
    ? bs58.default.encode(hotWalletKeypair.secretKey)
    : Buffer.from(hotWalletKeypair.secretKey).toString('base64');

console.log('Hot Wallet (Gas Top-ups):');
console.log('  Public Key:', hotWalletPublicKey);
console.log('  Private Key:', hotWalletPrivateKey);
console.log('  ⚠️  Fund this wallet with devnet SOL: https://faucet.solana.com\n');

// Generate test payer wallet
const payerKeypair = Keypair.generate();
const payerPublicKey = payerKeypair.publicKey.toBase58();
const payerPrivateKey = bs58.default
    ? bs58.default.encode(payerKeypair.secretKey)
    : Buffer.from(payerKeypair.secretKey).toString('base64');

console.log('Test Payer Wallet (For Testing):');
console.log('  Public Key:', payerPublicKey);
console.log('  Private Key:', payerPrivateKey);
console.log('  ⚠️  Fund this wallet with devnet SOL: https://faucet.solana.com\n');

// Create .env file
const envContent = `# Solana RPC endpoint (mainnet-beta, devnet, or testnet)
SOLANA_RPC_URL=https://api.devnet.solana.com

# Treasury wallet public key where funds will be swept
SOLANA_TREASURY_PUBLIC_KEY=${treasuryPublicKey}

# Hot wallet private key (base58 encoded) for gas top-ups
SOLANA_HOT_WALLET_PRIVATE_KEY=${hotWalletPrivateKey}

# (OPTIONAL) Test payer private key for integration tests
SOLANA_PAYER_PRIVATE_KEY=${payerPrivateKey}
`;

const envPath = path.join(__dirname, '../.env');
fs.writeFileSync(envPath, envContent);

console.log('✅ .env file created successfully!\n');
console.log('📝 Next steps:');
console.log('1. Fund hot wallet with devnet SOL:');
console.log('visit: https://faucet.solana.com\n');
console.log('2. Fund test payer wallet with devnet SOL and USDC. ');
console.log('Visit: https://faucet.circle.com');
