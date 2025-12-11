const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, createTransferInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');
require('dotenv').config();

const args = process.argv.slice(2);
if (args.length < 3) {
  console.log('Usage: node send-spl-payment.js <to_address> <amount> <token_mint>');
  console.log('  Payer private key will be read from SOLANA_PAYER_PRIVATE_KEY in .env');
  process.exit(1);
}

const toAddress = args[0];
const amount = parseFloat(args[1]);
const tokenMint = args[2];
const fromPrivateKey = process.env.SOLANA_PAYER_PRIVATE_KEY;

if (!fromPrivateKey) {
  console.error('Error: SOLANA_PAYER_PRIVATE_KEY not found in .env file');
  process.exit(1);
}

async function sendSPLPayment() {
  const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
  
  const fromKeypair = Keypair.fromSecretKey(bs58.default ? bs58.default.decode(fromPrivateKey) : bs58.decode(fromPrivateKey));
  const toPublicKey = new PublicKey(toAddress);
  const mintPublicKey = new PublicKey(tokenMint);
  
  console.log(`Sending ${amount} tokens from ${fromKeypair.publicKey.toBase58()} to ${toAddress}...`);
  
  const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    fromKeypair,
    mintPublicKey,
    fromKeypair.publicKey
  );
  
  const toTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    fromKeypair,
    mintPublicKey,
    toPublicKey
  );
  
  const transaction = new Transaction().add(
    createTransferInstruction(
      fromTokenAccount.address,
      toTokenAccount.address,
      fromKeypair.publicKey,
      amount * Math.pow(10, 6) // Assuming 6 decimals for USDC
    )
  );
  
  const signature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair]);
  
  console.log(`✅ SPL token payment sent! Signature: ${signature}`);
  console.log(`View on Solana Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
}

sendSPLPayment().catch(console.error);
