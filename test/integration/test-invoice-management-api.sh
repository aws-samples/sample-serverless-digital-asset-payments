#!/bin/bash

# Test script for Invoice Management API endpoints
# Usage: ./test-invoice-management-api.sh

set -e # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
STACK_NAME="CryptoInvoiceStack"

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1" >&2
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1" >&2
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

print_header() {
    echo -e "\n${BLUE}================================${NC}"
    echo -e "${BLUE} $1${NC}"
    echo -e "${BLUE}================================${NC}\n"
}

# Function to get API URLs and key automatically
get_api_details() {
    print_status "Retrieving API details from CDK stack..."
    
    # Check if stack exists
    if ! aws cloudformation describe-stacks --stack-name "$STACK_NAME" >/dev/null 2>&1; then
        print_error "CDK stack '$STACK_NAME' not found. Please deploy the stack first."
        echo "Run: npm run setup"
        exit 1
    fi

    # Get API URLs from stack outputs
    INVOICE_API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='InvoiceApiUrl'].OutputValue" --output text)

    INVOICE_API_BASE_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='InvoiceApiBaseUrl'].OutputValue" --output text)

    API_KEY_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='InvoiceApiKeyId'].OutputValue" --output text)

    if [ -z "$INVOICE_API_URL" ] || [ -z "$INVOICE_API_BASE_URL" ] || [ -z "$API_KEY_ID" ]; then
        print_error "Could not retrieve Invoice API URLs or API Key from stack outputs"
        exit 1
    fi

    # Get the actual API key value
    API_KEY_VALUE=$(aws apigateway get-api-key --api-key "$API_KEY_ID" --include-value \
        --query 'value' --output text 2>/dev/null)

    if [ -z "$API_KEY_VALUE" ]; then
        print_error "Could not retrieve API Key value"
        exit 1
    fi

    print_success "Invoice API URL: $INVOICE_API_URL"
    print_success "Invoice API Base URL: $INVOICE_API_BASE_URL"
    print_success "API Key retrieved successfully"
}

print_header "Invoice Management API Testing"

print_status "Testing Invoice Management API endpoints..."

# Get API details automatically
get_api_details

echo

# Test 1: Create an invoice first
print_status "1. Creating a test invoice..."
INVOICE_RESPONSE=$(curl -s -X POST "$INVOICE_API_URL" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY_VALUE" \
  -d '{
    "currency": "ETH",
    "amount": "0.0001"
  }')

# Check if invoice creation was successful
if ! echo "$INVOICE_RESPONSE" | jq -e '.invoiceId' >/dev/null 2>&1; then
    print_error "Failed to create invoice"
    echo "Response: $INVOICE_RESPONSE"
    exit 1
fi

INVOICE_ID=$(echo "$INVOICE_RESPONSE" | jq -r '.invoiceId')
print_success "Created invoice ID: $INVOICE_ID"
echo

# Test 2: Get all invoices
print_status "2. Getting all invoices..."
curl -s -X GET "$INVOICE_API_BASE_URL/invoices" \
  -H "X-API-Key: $API_KEY_VALUE" | jq '.'
echo

# Test 3: Get specific invoice
print_status "3. Getting specific invoice..."
curl -s -X GET "$INVOICE_API_BASE_URL/invoices/$INVOICE_ID" \
  -H "X-API-Key: $API_KEY_VALUE" | jq '.'
echo

# Test 4: Get pending invoices only
print_status "4. Getting pending invoices only..."
curl -s -X GET "$INVOICE_API_BASE_URL/invoices?status=pending" \
  -H "X-API-Key: $API_KEY_VALUE" | jq '.'
echo

# Test 5: Update invoice status
print_status "5. Updating invoice status to cancelled..."
curl -s -X PUT "$INVOICE_API_BASE_URL/invoices/$INVOICE_ID" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY_VALUE" \
  -d '{"status": "cancelled"}' | jq '.'
echo

# Test 6: Verify status update
print_status "6. Verifying status update..."
STATUS_RESPONSE=$(curl -s -X GET "$INVOICE_API_BASE_URL/invoices/$INVOICE_ID" \
  -H "X-API-Key: $API_KEY_VALUE")
CURRENT_STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.status')
print_success "Current status: $CURRENT_STATUS"
echo

# Test 7: Try to delete the invoice
print_status "7. Attempting to delete the invoice..."
DELETE_RESPONSE=$(curl -s -X DELETE "$INVOICE_API_BASE_URL/invoices/$INVOICE_ID" \
  -H "X-API-Key: $API_KEY_VALUE")
echo "$DELETE_RESPONSE" | jq '.'
echo

# Test 8: Verify deletion
print_status "8. Verifying deletion (should return 404)..."
VERIFY_RESPONSE=$(curl -s -X GET "$INVOICE_API_BASE_URL/invoices/$INVOICE_ID" \
  -H "X-API-Key: $API_KEY_VALUE")
echo "$VERIFY_RESPONSE" | jq '.'
echo

print_success "🎉 Invoice Management API testing completed!"
