#!/bin/bash

STACK_NAME="SolanaInvoiceStack"

echo "🔐 Setting up Solana secrets and KMS key..."

# Load AWS_REGION from .env file
if [ -f .env ]; then
  export $(grep -v '^#' .env | grep AWS_REGION | xargs)
fi

# Fallback to AWS CLI configured region or AWS_REGION env variable (CloudShell)
if [ -z "$AWS_REGION" ]; then
  AWS_REGION=$(aws configure get region 2>/dev/null)
fi

if [ -z "$AWS_REGION" ]; then
  echo "❌ Error: AWS region not configured. Set AWS_REGION in .env or run 'aws configure'."
  exit 1
fi

echo "📍 Using region: $AWS_REGION"

echo "📝 Fetching outputs from stack..."
MNEMONIC_SECRET=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='SolanaWalletSeedSecretName'].OutputValue" --output text 2>&1)

if [ $? -ne 0 ]; then
  echo "❌ Error: Failed to fetch mnemonic secret name from stack"
  echo "$MNEMONIC_SECRET"
  exit 1
fi

KMS_KEY_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='SolanaHotWalletKmsKeyId'].OutputValue" --output text 2>&1)

if [ $? -ne 0 ]; then
  echo "❌ Error: Failed to fetch KMS key ID from stack"
  echo "$KMS_KEY_ID"
  exit 1
fi

if [ -z "$MNEMONIC_SECRET" ] || [ -z "$KMS_KEY_ID" ]; then
  echo "❌ Error: Could not fetch outputs from stack. Make sure the stack is deployed."
  exit 1
fi

echo "📝 Generating new Solana mnemonic..."
MNEMONIC=$(node -e "const bip39 = require('bip39'); console.log(bip39.generateMnemonic());" 2>&1)

if [ $? -ne 0 ]; then
  echo "❌ Error: Failed to generate mnemonic"
  echo "$MNEMONIC"
  exit 1
fi

echo "💾 Storing mnemonic in Secrets Manager..."
RESULT=$(aws secretsmanager put-secret-value \
  --secret-id "$MNEMONIC_SECRET" \
  --secret-string "{\"mnemonic\":\"$MNEMONIC\"}" \
  --region "${AWS_REGION}" 2>&1)

if [ $? -ne 0 ]; then
  echo "❌ Error: Failed to store mnemonic in Secrets Manager"
  echo "$RESULT"
  exit 1
fi

echo "🔑 Getting KMS public key for hot wallet..."
KMS_PUBKEY=$(aws kms get-public-key --key-id "$KMS_KEY_ID" --region "${AWS_REGION}" \
  --query 'PublicKey' --output text 2>&1)

if [ $? -ne 0 ]; then
  echo "❌ Error: Failed to get KMS public key"
  echo "$KMS_PUBKEY"
  exit 1
fi

SOLANA_PUBKEY=$(node -e "
const pubkeyDer = Buffer.from('$KMS_PUBKEY', 'base64');
const pubkeyBytes = pubkeyDer.slice(-32);
const { PublicKey } = require('@solana/web3.js');
const pk = new PublicKey(pubkeyBytes);
console.log(pk.toBase58());
" 2>&1)

if [ $? -ne 0 ]; then
  echo "❌ Error: Failed to derive Solana public key"
  echo "$SOLANA_PUBKEY"
  exit 1
fi

echo "✅ Setup complete!"
echo ""
echo "📋 Hot Wallet Address (fund this with SOL): $SOLANA_PUBKEY"
echo "🔑 KMS Key ID: $KMS_KEY_ID"
