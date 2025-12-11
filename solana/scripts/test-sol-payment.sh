#!/bin/bash
set -e

source .env

export STACK_NAME="SolanaInvoiceStack"
export API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='SolanaInvoiceApiBaseUrl'].OutputValue" --output text)
export API_KEY_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='SolanaInvoiceApiKeyId'].OutputValue" --output text)
export API_KEY=$(aws apigateway get-api-key --api-key "$API_KEY_ID" --include-value \
  --query 'value' --output text 2>/dev/null)

AMOUNT=${1:-0.01}

echo "🧪 Testing SOL Payment (${AMOUNT} SOL)"
echo ""

echo "📝 Creating invoice..."
INVOICE_RESPONSE=$(curl -s -X POST "${API_URL}generateInvoice" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d "{\"currency\": \"SOL\", \"amount\": \"${AMOUNT}\"}")

INVOICE_ID=$(echo $INVOICE_RESPONSE | grep -o '"invoiceId":"[^"]*' | cut -d'"' -f4)
INVOICE_ADDRESS=$(echo $INVOICE_RESPONSE | grep -o '"address":"[^"]*' | cut -d'"' -f4)

echo "✅ Invoice: $INVOICE_ID"
echo "📍 Address: $INVOICE_ADDRESS"
echo ""

echo "💸 Sending payment..."
node scripts/send-payment.js "$INVOICE_ADDRESS" "$AMOUNT"
echo ""

echo "⏳ Waiting 5s for transaction confirmation..."
sleep 5

echo "🔍 Invoking watcher Lambda..."
WATCHER_FUNCTION=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='SolanaWatcherFunctionName'].OutputValue" --output text)
aws lambda invoke --function-name "$WATCHER_FUNCTION" /dev/null > /dev/null 2>&1

echo "⏳ Waiting 5s for sweeper to process..."
sleep 5

echo "🔍 Checking status..."
curl -s -X GET "${API_URL}invoices/${INVOICE_ID}" -H "X-API-Key: $API_KEY" | python3 -m json.tool
