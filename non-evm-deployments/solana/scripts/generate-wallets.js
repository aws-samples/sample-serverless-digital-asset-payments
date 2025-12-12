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

// Generate test payer wallet
const payerKeypair = Keypair.generate();
const payerPublicKey = payerKeypair.publicKey.toBase58();
const payerPrivateKey = bs58.default
  ? bs58.default.encode(payerKeypair.secretKey)
  : Buffer.from(payerKeypair.secretKey).toString('base64');

console.log('\nTest Payer Wallet (For Testing):');
console.log('  Public Key:', payerPublicKey);
console.log('  Private Key:', payerPrivateKey);

console.log('\n⚠️  Hot Wallet will be generated via AWS KMS after deployment');

// Create .env file
const envContent = `# Solana RPC endpoint (mainnet-beta, devnet, or testnet)
SOLANA_RPC_URL=https://api.devnet.solana.com

# Treasury wallet public key where funds will be swept
SOLANA_TREASURY_PUBLIC_KEY=${treasuryPublicKey}

# (OPTIONAL) Test payer private key for integration tests
SOLANA_PAYER_PRIVATE_KEY=${payerPrivateKey}
`;

const envPath = path.join(__dirname, '../.env');
fs.writeFileSync(envPath, envContent);

console.log('\n✅ .env file created successfully!');
