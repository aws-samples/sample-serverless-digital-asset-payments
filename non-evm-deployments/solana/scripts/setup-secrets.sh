#!/bin/bash

STACK_NAME="SolanaInvoiceStack"

echo "🔐 Setting up Solana secrets in AWS Secrets Manager..."

if [ ! -f .env ]; then
  echo "❌ Error: .env file not found. Please run 'npm run generate-wallets' first."
  exit 1
fi

source .env

if [ -z "$SOLANA_HOT_WALLET_PRIVATE_KEY" ]; then
  echo "❌ Error: SOLANA_HOT_WALLET_PRIVATE_KEY not set in .env"
  exit 1
fi

echo "📝 Fetching secret names from stack outputs..."
MNEMONIC_SECRET=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='SolanaWalletSeedSecretName'].OutputValue" --output text 2>&1)

if [ $? -ne 0 ]; then
  echo "❌ Error: Failed to fetch mnemonic secret name from stack"
  echo "$MNEMONIC_SECRET"
  exit 1
fi

HOT_PK_SECRET=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='SolanaWalletHotPkSecretName'].OutputValue" --output text 2>&1)

if [ $? -ne 0 ]; then
  echo "❌ Error: Failed to fetch hot wallet secret name from stack"
  echo "$HOT_PK_SECRET"
  exit 1
fi

if [ -z "$MNEMONIC_SECRET" ] || [ -z "$HOT_PK_SECRET" ]; then
  echo "❌ Error: Could not fetch secret names from stack. Make sure the stack is deployed."
  exit 1
fi

AWS_REGION=$(aws configure get region 2>&1)

if [ $? -ne 0 ] || [ -z "$AWS_REGION" ]; then
  echo "❌ Error: AWS region not configured. Run 'aws configure' first."
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

echo "💾 Storing hot wallet private key in Secrets Manager..."
RESULT=$(aws secretsmanager put-secret-value \
  --secret-id "$HOT_PK_SECRET" \
  --secret-string "{\"pk\":\"$SOLANA_HOT_WALLET_PRIVATE_KEY\"}" \
  --region "${AWS_REGION}" 2>&1)

if [ $? -ne 0 ]; then
  echo "❌ Error: Failed to store hot wallet private key in Secrets Manager"
  echo "$RESULT"
  exit 1
fi

echo "✅ Secrets successfully stored in AWS Secrets Manager"
