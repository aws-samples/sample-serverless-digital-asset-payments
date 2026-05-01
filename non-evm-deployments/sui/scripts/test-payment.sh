#!/bin/bash

# Test SUI Payment - End-to-end test script
# Creates invoice, funds it, and verifies sweep

set -e

AMOUNT=${1:-0.1}  # Default 0.1 SUI (human-readable)

echo "=== SUI Payment Agent - End-to-End Test ==="
echo ""

# Get API credentials
STACK_NAME="SuiPaymentStack"
API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" --output text)
API_KEY_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiKeyId'].OutputValue" --output text)
API_KEY=$(aws apigateway get-api-key --api-key "$API_KEY_ID" --include-value \
  --query 'value' --output text 2>/dev/null)

echo "📝 Creating invoice for $AMOUNT SUI..."
RESPONSE=$(curl -s -X POST "${API_URL}create-invoice" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d "{\"amount\": $AMOUNT, \"reference_id\": \"test-$(date +%s)\", \"expiry_seconds\": 3600}")

INVOICE_ID=$(echo "$RESPONSE" | jq -r '.invoice_id')
ADDRESS=$(echo "$RESPONSE" | jq -r '.recipient_address')

if [ "$INVOICE_ID" == "null" ] || [ -z "$INVOICE_ID" ]; then
  echo "❌ Failed to create invoice"
  echo "$RESPONSE"
  exit 1
fi

echo "✅ Invoice created!"
echo "   Invoice ID: $INVOICE_ID"
echo "   Address:    $ADDRESS"
echo "   Amount:     $AMOUNT SUI"
echo ""

echo "💰 Fund this address with testnet SUI:"
echo "   Web faucet: https://faucet.testnet.sui.io"
echo "   Address:    $ADDRESS"
echo ""

read -p "Press Enter after funding the address..."

echo ""
echo "🔍 Waiting for payment detection (watcher runs every minute)..."

for i in $(seq 1 8); do
  sleep 15
  STATUS=$(aws dynamodb get-item --table-name SuiInvoices \
    --key "{\"invoice_id\": {\"S\": \"$INVOICE_ID\"}}" \
    --query 'Item.status.S' --output text)
  echo "   $(date '+%H:%M:%S') status: $STATUS"
  if [ "$STATUS" == "swept" ]; then
    break
  fi
done

STATUS=$(aws dynamodb get-item --table-name SuiInvoices \
  --key "{\"invoice_id\": {\"S\": \"$INVOICE_ID\"}}" \
  --query 'Item.status.S' --output text)

if [ "$STATUS" == "swept" ]; then
  TX_DIGEST=$(aws dynamodb get-item --table-name SuiInvoices \
    --key "{\"invoice_id\": {\"S\": \"$INVOICE_ID\"}}" \
    --query 'Item.tx_digest.S' --output text)
  echo ""
  echo "✅ Test successful! Invoice swept to treasury."
  echo "   Transaction: https://suiscan.xyz/testnet/tx/$TX_DIGEST"
else
  echo ""
  echo "⚠️  Invoice status: $STATUS (expected: swept)"
  echo "   Check CloudWatch logs for errors"
  exit 1
fi

echo ""
echo "=== Test Complete ==="
