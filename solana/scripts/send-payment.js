const { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');

const args = process.argv.slice(2);
if (args.length < 3) {
  console.log('Usage: node send-payment.js <from_private_key> <to_address> <amount_sol>');
  process.exit(1);
}

const fromPrivateKey = args[0];
const toAddress = args[1];
const amountSol = parseFloat(args[2]);

async function sendPayment() {
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  
  const fromKeypair = Keypair.fromSecretKey(bs58.default ? bs58.default.decode(fromPrivateKey) : bs58.decode(fromPrivateKey));
  const toPublicKey = new PublicKey(toAddress);
  
  console.log(`Sending ${amountSol} SOL from ${fromKeypair.publicKey.toBase58()} to ${toAddress}...`);
  
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: toPublicKey,
      lamports: amountSol * LAMPORTS_PER_SOL,
    })
  );
  
  const signature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair]);
  
  console.log(`✅ Payment sent! Signature: ${signature}`);
  console.log(`View on Solana Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
}

sendPayment().catch(console.error);
