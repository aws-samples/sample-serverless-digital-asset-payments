#!/bin/bash
set -e

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
  --query "Stacks[0].Outputs[?OutputKey=='SolanaWalletSeedSecretName'].OutputValue" --output text)

HOT_PK_SECRET=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='SolanaWalletHotPkSecretName'].OutputValue" --output text)

if [ -z "$MNEMONIC_SECRET" ] || [ -z "$HOT_PK_SECRET" ]; then
  echo "❌ Error: Could not fetch secret names from stack. Make sure the stack is deployed."
  exit 1
fi

AWS_REGION=$(aws configure get region)

if [ -z "$AWS_REGION" ]; then
  echo "❌ Error: AWS region not configured. Run 'aws configure' first."
  exit 1
fi

echo "📝 Generating new Solana mnemonic..."
MNEMONIC=$(node -e "const bip39 = require('bip39'); console.log(bip39.generateMnemonic());")

echo "💾 Storing mnemonic in Secrets Manager..."
aws secretsmanager put-secret-value \
  --secret-id "$MNEMONIC_SECRET" \
  --secret-string "{\"mnemonic\":\"$MNEMONIC\"}" \
  --region ${AWS_REGION:-us-east-1}

echo "💾 Storing hot wallet private key in Secrets Manager..."
aws secretsmanager put-secret-value \
  --secret-id "$HOT_PK_SECRET" \
  --secret-string "{\"pk\":\"$SOLANA_HOT_WALLET_PRIVATE_KEY\"}" \
  --region ${AWS_REGION:-us-east-1}

echo "✅ Secrets successfully stored in AWS Secrets Manager"
echo ""
echo "🔑 Mnemonic (save this securely): $MNEMONIC"
echo ""
echo "⚠️  IMPORTANT: Store this mnemonic in a secure location. It cannot be recovered from AWS."
