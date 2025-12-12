const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
require('dotenv').config();

console.log('\n🔑 Solana Wallet Addresses:\n');

if (process.env.SOLANA_HOT_WALLET_PRIVATE_KEY) {
  const hotKeypair = Keypair.fromSecretKey(
    bs58.default.decode(process.env.SOLANA_HOT_WALLET_PRIVATE_KEY)
  );
  console.log('\nHot Wallet:');
  console.log('  Address:', hotKeypair.publicKey.toBase58());
}

if (process.env.SOLANA_PAYER_PRIVATE_KEY) {
  const payerKeypair = Keypair.fromSecretKey(
    bs58.default.decode(process.env.SOLANA_PAYER_PRIVATE_KEY)
  );
  console.log('\nTest Payer Wallet:');
  console.log('  Address:', payerKeypair.publicKey.toBase58());
}

console.log('\n📝 Fund these addresses at:');
console.log('  SOL: https://faucet.solana.com');
console.log('  USDC: https://faucet.circle.com\n');
console.log(
  '  Note: The Hot Wallet needs to be funded with SOL. The Payer Wallet requires both SOL and USDC for testing payments.'
);
