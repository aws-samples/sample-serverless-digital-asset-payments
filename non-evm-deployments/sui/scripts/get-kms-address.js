#!/usr/bin/env node
/**
 * Derives the SUI address of the KMS Ed25519 hot wallet used to sponsor
 * gas fees for token payment sweeps. Fund this address with testnet SUI
 * before creating token invoices.
 *
 * Usage: npm run get-kms-address
 */

const { KMSClient, GetPublicKeyCommand } = require('@aws-sdk/client-kms');
const path = require('path');

// Load @noble/hashes blake2b from the local node_modules
const { blake2b } = require(path.join(__dirname, '../node_modules/@noble/hashes/blake2.js'));

async function main() {
  const region =
    process.env.CDK_DEFAULT_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    process.env.AWS_REGION ||
    'us-east-1';

  // Resolve KMS key ID: env var, or query CloudFormation stack output
  let kmsKeyId = process.env.KMS_KEY_ID;
  if (!kmsKeyId) {
    try {
      const { CloudFormationClient, DescribeStacksCommand } = require('@aws-sdk/client-cloudformation');
      const cfn = new CloudFormationClient({ region });
      const resp = await cfn.send(new DescribeStacksCommand({ StackName: 'SuiPaymentStack' }));
      const outputs = resp.Stacks[0].Outputs || [];
      kmsKeyId = outputs.find((o) => o.OutputKey === 'KmsKeyId')?.OutputValue;
    } catch (e) {
      console.error('Could not read KmsKeyId from CloudFormation:', e.message);
      console.error('Set KMS_KEY_ID env var and retry.');
      process.exit(1);
    }
  }

  if (!kmsKeyId) {
    console.error('KmsKeyId not found. Deploy the stack first or set KMS_KEY_ID.');
    process.exit(1);
  }

  const kms = new KMSClient({ region });
  const resp = await kms.send(new GetPublicKeyCommand({ KeyId: kmsKeyId }));

  const der = Buffer.from(resp.PublicKey);
  // DER-encoded SubjectPublicKeyInfo — raw Ed25519 key is the last 32 bytes
  const raw = der.slice(der.length - 32);

  // SUI address = BLAKE2b-256(0x00 || raw_pubkey), truncated to 32 bytes
  const input = Buffer.concat([Buffer.from([0x00]), raw]);
  const hash = blake2b(input, { dkLen: 32 });
  const address = '0x' + Buffer.from(hash).toString('hex');

  console.log('KMS Key ID:         ', kmsKeyId);
  console.log('KMS Hot Wallet SUI Address:', address);
  console.log('');
  console.log('Fund this address with testnet SUI before processing token payments.');
  console.log('Faucet: https://faucet.testnet.sui.io');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
