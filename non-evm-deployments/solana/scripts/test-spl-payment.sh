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

AMOUNT=${1:-1.00}
TOKEN_MINT=${2:-4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU}
TOKEN_SYMBOL=${3:-USDC}

echo "🧪 Testing SPL Payment (${AMOUNT} ${TOKEN_SYMBOL})"
echo ""

echo "📝 Creating invoice..."
INVOICE_RESPONSE=$(curl -s -X POST "${API_URL}generateInvoice" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d "{\"currency\": \"SPL\", \"tokenMint\": \"${TOKEN_MINT}\", \"tokenSymbol\": \"${TOKEN_SYMBOL}\", \"amount\": \"${AMOUNT}\"}")

INVOICE_ID=$(echo $INVOICE_RESPONSE | grep -o '"invoiceId":"[^"]*' | cut -d'"' -f4)
INVOICE_ADDRESS=$(echo $INVOICE_RESPONSE | grep -o '"address":"[^"]*' | cut -d'"' -f4)

echo "✅ Invoice: $INVOICE_ID"
echo "📍 Address: $INVOICE_ADDRESS"
echo ""

echo "💸 Sending payment..."
node scripts/send-spl-payment.js "$INVOICE_ADDRESS" "$AMOUNT" "$TOKEN_MINT"
echo ""

echo "⏳ Waiting 5s for transaction confirmation..."
sleep 5

echo "🔍 Invoking watcher Lambda..."
WATCHER_FUNCTION=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='SolanaWatcherFunctionName'].OutputValue" --output text)
aws lambda invoke --function-name "$WATCHER_FUNCTION" /dev/null > /dev/null 2>&1

echo "⏳ Waiting 10s for sweeper to process..."
sleep 10

echo "🔍 Checking status..."
curl -s -X GET "${API_URL}invoices/${INVOICE_ID}" -H "X-API-Key: $API_KEY" | python3 -m json.tool
