const { Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const { KMSClient, GetPublicKeyCommand } = require('@aws-sdk/client-kms');
require('dotenv').config();

const kms = new KMSClient({ region: process.env.AWS_REGION || 'us-east-1' });

async function getKmsHotWallet() {
  try {
    const { execSync } = require('child_process');
    const keyId = execSync(
      'aws cloudformation describe-stacks --stack-name SolanaInvoiceStack --query "Stacks[0].Outputs[?OutputKey==\'SolanaHotWalletKmsKeyId\'].OutputValue" --output text',
      { encoding: 'utf-8' }
    ).trim();

    if (!keyId) return null;

    const response = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
    const pubkeyBytes = new Uint8Array(response.PublicKey).slice(-32);
    return new PublicKey(pubkeyBytes).toBase58();
  } catch {
    return null;
  }
}

(async () => {
  console.log('\n🔑 Solana Wallet Addresses:\n');

  const hotWallet = await getKmsHotWallet();
  if (hotWallet) {
    console.log('Hot Wallet (KMS):');
    console.log('  Address:', hotWallet);
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
})();
