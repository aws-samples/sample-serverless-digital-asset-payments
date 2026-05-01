#!/usr/bin/env node

/**
 * Generate Wallets - Creates mnemonic and derives treasury address
 *
 * This script generates a new mnemonic and populates .env with
 * the treasury address (derived at index 0). Invoice addresses
 * start at index 1+ and are generated at runtime by the Lambda.
 */

const { Ed25519Keypair } = require('@mysten/sui/keypairs/ed25519');
const { generateMnemonic } = require('bip39');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');
const ENV_SAMPLE_PATH = path.join(__dirname, '..', '.env-sample');

function deriveAddress(mnemonic, index) {
  const kp = Ed25519Keypair.deriveKeypair(mnemonic, `m/44'/784'/0'/0'/${index}'`);
  return kp.getPublicKey().toSuiAddress();
}

function main() {
  console.log('\n=== SUI Payment Agent - Wallet Generator ===\n');

  // Generate mnemonic
  const mnemonic = generateMnemonic(128); // 12 words
  const treasuryAddress = deriveAddress(mnemonic, 0);

  console.log('✅ Generated new wallet\n');
  console.log(`  Mnemonic:         ${mnemonic}`);
  console.log(`  Treasury Address: ${treasuryAddress} (index 0)`);
  console.log(`  Invoice addresses will be derived at index 1+ during runtime.\n`);

  // Write .env
  let envContent;
  if (fs.existsSync(ENV_SAMPLE_PATH)) {
    envContent = fs.readFileSync(ENV_SAMPLE_PATH, 'utf8');
  } else {
    envContent =
      'TREASURY_ADDRESS=\nALERT_EMAIL=\nSUI_RPC_URL=https://fullnode.testnet.sui.io:443\nSUI_NETWORK=testnet\n';
  }
  envContent = envContent.replace(/^TREASURY_ADDRESS=.*$/m, `TREASURY_ADDRESS=${treasuryAddress}`);
  fs.writeFileSync(ENV_PATH, envContent);
  console.log('✅ Updated .env with TREASURY_ADDRESS\n');

  // Save mnemonic to a local file for setup-secrets
  const mnemonicPath = path.join(__dirname, '..', '.mnemonic');
  fs.writeFileSync(mnemonicPath, mnemonic, { mode: 0o600 });
  console.log('✅ Saved mnemonic to .mnemonic (used by setup-secrets)\n');

  console.log(
    '⚠️  IMPORTANT: Back up your mnemonic securely and delete .mnemonic after deployment.\n'
  );
  console.log('Next steps:');
  console.log('  1. Fund treasury on testnet: https://faucet.sui.io/?network=testnet');
  console.log(`     Address: ${treasuryAddress}`);
  console.log('  2. Deploy:        npm run deploy');
  console.log('  3. Store secret:  npm run setup-secrets\n');
}

main();
