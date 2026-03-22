#!/usr/bin/env node

/**
 * Setup Secrets - Stores mnemonic in AWS Secrets Manager
 *
 * Reads from .mnemonic file (created by generate-wallets) or prompts for input.
 */

const { SecretsManagerClient, PutSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const MNEMONIC_PATH = path.join(__dirname, '..', '.mnemonic');

async function storeMnemonic(mnemonic) {
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });

  console.log('\n📝 Storing mnemonic in AWS Secrets Manager...');
  await client.send(new PutSecretValueCommand({
    SecretId: 'sui-payment-mnemonic',
    SecretString: mnemonic,
  }));

  console.log('✅ Mnemonic stored successfully!');
  console.log('   Secret name: sui-payment-mnemonic');
  console.log('   Region:', process.env.AWS_REGION || 'us-east-1');

  // Delete local mnemonic file
  if (fs.existsSync(MNEMONIC_PATH)) {
    fs.unlinkSync(MNEMONIC_PATH);
    console.log('🗑️  Deleted local .mnemonic file');
  }

  console.log('\n⚠️  Remember to back up your mnemonic securely!\n');
}

async function main() {
  console.log('\n=== SUI Payment Agent - Secrets Setup ===\n');

  // Try reading from .mnemonic file first
  if (fs.existsSync(MNEMONIC_PATH)) {
    const mnemonic = fs.readFileSync(MNEMONIC_PATH, 'utf8').trim();
    console.log('Found .mnemonic file from generate-wallets.');
    await storeMnemonic(mnemonic);
    return;
  }

  // Fall back to interactive prompt
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Enter your 12-word mnemonic: ', async (input) => {
    const mnemonic = input.trim();
    const words = mnemonic.split(' ');
    if (words.length !== 12 && words.length !== 24) {
      console.log('\n❌ Invalid mnemonic. Must be 12 or 24 words.\n');
      rl.close();
      process.exit(1);
    }
    await storeMnemonic(mnemonic);
    rl.close();
  });
}

main().catch((err) => {
  if (err.name === 'ResourceNotFoundException') {
    console.error('\n❌ Secret "sui-payment-mnemonic" not found. Deploy the stack first: npm run deploy\n');
  } else {
    console.error('\n❌ Error:', err.message);
  }
  process.exit(1);
});
