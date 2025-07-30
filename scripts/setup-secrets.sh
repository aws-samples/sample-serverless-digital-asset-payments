#!/usr/bin/env bash
set -e
STACK='CryptoInvoiceStack' 
echo "[*] Fetching outputs…"

SECRET_NAME=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='WalletSeedSecretName'].OutputValue" --output text)

HOT_PK_SECRET_NAME=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='WalletHotPkSecretName'].OutputValue" --output text)

AWS_REGION=$(aws configure get region)


SECRET_NAME="$SECRET_NAME" \
HOT_PK_SECRET_NAME="$HOT_PK_SECRET_NAME" \
AWS_REGION="$AWS_REGION" \
node scripts/setup-secrets.js
