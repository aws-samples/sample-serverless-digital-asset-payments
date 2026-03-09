#!/usr/bin/env node

/**
 * Setup Secrets - Stores mnemonic in AWS Secrets Manager
 * 
 * This script should be run after CDK deployment to store the mnemonic
 * in AWS Secrets Manager. The mnemonic is used for HD wallet derivation.
 */

const { SecretsManagerClient, PutSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function setupSecrets() {
  console.log('\n=== SUI Payment Agent - Secrets Setup ===\n');
  
  console.log('This script will store your mnemonic in AWS Secrets Manager.');
  console.log('The mnemonic is used to derive invoice addresses.\n');
  
  console.log('⚠️  IMPORTANT: Keep your mnemonic secure!');
  console.log('   - Write it down on paper');
  console.log('   - Store in a safe location');
  console.log('   - Never share it with anyone\n');
  
  rl.question('Enter your 12-word mnemonic (or press Enter to generate new): ', async (mnemonic) => {
    let finalMnemonic = mnemonic.trim();
    
    if (!finalMnemonic) {
      console.log('\n❌ Mnemonic generation not implemented in this script.');
      console.log('   Please generate a mnemonic using SUI CLI:');
      console.log('   sui client new-address ed25519\n');
      rl.close();
      process.exit(1);
    }
    
    // Validate mnemonic (basic check)
    const words = finalMnemonic.split(' ');
    if (words.length !== 12 && words.length !== 24) {
      console.log('\n❌ Invalid mnemonic. Must be 12 or 24 words.\n');
      rl.close();
      process.exit(1);
    }
    
    try {
      const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
      
      console.log('\n📝 Storing mnemonic in AWS Secrets Manager...');
      
      await client.send(new PutSecretValueCommand({
        SecretId: 'sui-payment-mnemonic',
        SecretString: finalMnemonic
      }));
      
      console.log('✅ Mnemonic stored successfully!\n');
      console.log('Secret name: sui-payment-mnemonic');
      console.log('Region:', process.env.AWS_REGION || 'us-east-1');
      console.log('\n⚠️  Remember to write down your mnemonic for backup!\n');
      
    } catch (error) {
      if (error.name === 'ResourceNotFoundException') {
        console.log('\n❌ Secret "sui-payment-mnemonic" not found.');
        console.log('   Please deploy the CDK stack first: npm run deploy\n');
      } else {
        console.error('\n❌ Error storing secret:', error.message);
      }
      process.exit(1);
    }
    
    rl.close();
  });
}

setupSecrets();
