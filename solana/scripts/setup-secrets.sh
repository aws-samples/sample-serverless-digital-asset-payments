#!/bin/bash
set -e

echo "🔐 Setting up Solana secrets in AWS Secrets Manager..."

if [ ! -f .env ]; then
  echo "❌ Error: .env file not found. Please copy .env-sample to .env and configure it."
  exit 1
fi

source .env

if [ -z "$SOLANA_HOT_WALLET_PRIVATE_KEY" ]; then
  echo "❌ Error: SOLANA_HOT_WALLET_PRIVATE_KEY not set in .env"
  exit 1
fi

echo "📝 Generating new Solana mnemonic..."
MNEMONIC=$(node -e "const bip39 = require('bip39'); console.log(bip39.generateMnemonic());")

echo "💾 Storing mnemonic in Secrets Manager..."
aws secretsmanager put-secret-value \
  --secret-id solana-wallet-mnemonic \
  --secret-string "{\"mnemonic\":\"$MNEMONIC\"}" \
  --region ${AWS_REGION:-us-east-1} 2>/dev/null || \
aws secretsmanager create-secret \
  --name solana-wallet-mnemonic \
  --description "Solana wallet mnemonic for invoice generation" \
  --secret-string "{\"mnemonic\":\"$MNEMONIC\"}" \
  --region ${AWS_REGION:-us-east-1}

echo "💾 Storing hot wallet private key in Secrets Manager..."
aws secretsmanager put-secret-value \
  --secret-id solana-wallet/hot-pk \
  --secret-string "{\"pk\":\"$SOLANA_HOT_WALLET_PRIVATE_KEY\"}" \
  --region ${AWS_REGION:-us-east-1} 2>/dev/null || \
aws secretsmanager create-secret \
  --name solana-wallet/hot-pk \
  --description "Solana hot wallet private key for gas top-ups" \
  --secret-string "{\"pk\":\"$SOLANA_HOT_WALLET_PRIVATE_KEY\"}" \
  --region ${AWS_REGION:-us-east-1}

echo "✅ Secrets successfully stored in AWS Secrets Manager"
