const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const bs58 = require('bs58');
require('dotenv').config();

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: node send-payment.js <to_address> <amount_sol>');
  console.log('  Payer private key will be read from SOLANA_PAYER_PRIVATE_KEY in .env');
  process.exit(1);
}

const toAddress = args[0];
const amountSol = parseFloat(args[1]);
const fromPrivateKey = process.env.SOLANA_PAYER_PRIVATE_KEY;

if (!fromPrivateKey) {
  console.error('Error: SOLANA_PAYER_PRIVATE_KEY not found in .env file');
  process.exit(1);
}

async function sendPayment() {
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    'confirmed'
  );

  const fromKeypair = Keypair.fromSecretKey(
    bs58.default ? bs58.default.decode(fromPrivateKey) : bs58.decode(fromPrivateKey)
  );
  const toPublicKey = new PublicKey(toAddress);

  console.log(
    `Sending ${amountSol} SOL from ${fromKeypair.publicKey.toBase58()} to ${toAddress}...`
  );

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: toPublicKey,
      lamports: amountSol * LAMPORTS_PER_SOL,
    })
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair]);

  console.log(`✅ Payment sent! Signature: ${signature}`);
  console.log(
    `View on Solana Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`
  );
}

sendPayment().catch(console.error);
