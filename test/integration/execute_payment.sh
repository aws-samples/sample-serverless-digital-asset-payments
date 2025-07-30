#!/usr/bin/env bash

# Execute Payment Script
# This script creates an invoice, reads the invoice data, and executes a payment using eth-cli

set -e # Exit on any error
set +x

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
STACK_NAME="CryptoInvoiceStack"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1" >&2
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1" >&2
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1" >&2
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

print_header() {
    echo -e "\n${BLUE}================================${NC}"
    echo -e "${BLUE} $1${NC}"
    echo -e "${BLUE}================================${NC}\n"
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to check prerequisites
check_prerequisites() {
    print_header "Checking Prerequisites"

    local missing_deps=()

    # Check if stack is deployed
    if ! aws cloudformation describe-stacks --stack-name "$STACK_NAME" >/dev/null 2>&1; then
        print_error "CDK stack '$STACK_NAME' not found. Please deploy the stack first."
        echo "Run: npm run setup"
        exit 1
    fi

    # Check curl
    if ! command_exists curl; then
        missing_deps+=("curl")
    fi

    # Check jq for JSON parsing
    if ! command_exists jq; then
        missing_deps+=("jq")
    fi

    # Check bc for calculations
    if ! command_exists bc; then
        missing_deps+=("bc")
    fi

    # Check eth-cli
    if ! command_exists eth; then
        # Check if it's available locally
        if [ -f "$PROJECT_ROOT/node_modules/.bin/eth" ]; then
            print_success "eth-cli found locally"
        else
            missing_deps+=("eth-cli")
        fi
    else
        print_success "eth-cli found globally"
    fi

    if [ ${#missing_deps[@]} -ne 0 ]; then
        print_error "Missing dependencies: ${missing_deps[*]}"
        echo -e "\nPlease install the missing dependencies:"
        echo "- curl: Usually pre-installed on most systems"
        echo "- jq: brew install jq (macOS) or apt-get install jq (Ubuntu)"
        echo "- bc: brew install bc (macOS) or apt-get install bc (Ubuntu)"
        echo "- eth-cli: npm install -g eth-cli or use local version"
        exit 1
    fi

    print_success "All prerequisites satisfied!"
}

# Function to validate environment
validate_environment() {
    print_header "Validating Environment"

    cd "$PROJECT_ROOT"

    # Check if .env file exists
    if [ ! -f ".env" ]; then
        print_error ".env file not found"
        echo "Please create a .env file based on .env-sample"
        exit 1
    fi

    # Source the .env file
    set -a # automatically export all variables
    source .env
    set +a

    # Validate required environment variables
    local missing_vars=()

    if [ -z "$RPC_URL" ]; then
        missing_vars+=("RPC_URL")
    fi

    if [ -z "$PAYER_PRIVATE_KEY" ]; then
        missing_vars+=("PAYER_PRIVATE_KEY")
    fi

    if [ ${#missing_vars[@]} -ne 0 ]; then
        print_error "Missing environment variables: ${missing_vars[*]}"
        echo "Please update your .env file with the required values"
        exit 1
    fi

    # Validate payer private key format
    if [[ ! "$PAYER_PRIVATE_KEY" =~ ^[a-fA-F0-9]{64}$ ]]; then
        print_error "PAYER_PRIVATE_KEY should be a 64-character hex string (without 0x prefix)"
        exit 1
    fi

    print_success "Environment validated!"
}

# Function to get API URLs and key
get_api_url() {
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
    print_success "API Key configured"
}

# Function to create invoice
create_invoice() {
    print_header "Creating Invoice"

    local currency="${1:-ETH}"
    local amount="${2:-0.0001}"
    local token_address="${3:-}"
    local token_symbol="${4:-}"
    local decimals="${5:-}"

    print_status "Creating $currency invoice for $amount..."

    # Prepare JSON payload
    if [ "$currency" = "ETH" ]; then
        PAYLOAD=$(
            cat <<EOF
{
    "currency": "ETH",
    "amount": "$amount"
}
EOF
        )
    else
        PAYLOAD=$(
            cat <<EOF
{
    "currency": "ERC20",
    "tokenAddress": "$token_address",
    "tokenSymbol": "$token_symbol",
    "amount": "$amount",
    "decimals": $decimals
}
EOF
        )
    fi

    # Create invoice
    INVOICE_RESPONSE=$(curl -s -X POST "$INVOICE_API_URL" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $API_KEY_VALUE" \
        -d "$PAYLOAD")

    # Check if invoice creation was successful
    if ! echo "$INVOICE_RESPONSE" | jq -e '.invoiceId' >/dev/null 2>&1; then
        print_error "Failed to create invoice"
        echo "Response: $INVOICE_RESPONSE"
        exit 1
    fi

    # Extract invoice details
    INVOICE_ID=$(echo "$INVOICE_RESPONSE" | jq -r '.invoiceId')
    INVOICE_ADDRESS=$(echo "$INVOICE_RESPONSE" | jq -r '.address')
    INVOICE_INDEX=$(echo "$INVOICE_RESPONSE" | jq -r '.index')

    print_success "Invoice created successfully!"
    echo "Invoice ID: $INVOICE_ID"
    echo "Payment Address: $INVOICE_ADDRESS"
    echo "HD Index: $INVOICE_INDEX"

    # Save QR code if present
    if echo "$INVOICE_RESPONSE" | jq -e '.qrcodeBase64' >/dev/null 2>&1; then
        QR_CODE=$(echo "$INVOICE_RESPONSE" | jq -r '.qrcodeBase64')
        echo "$QR_CODE" | base64 -d >"/tmp/invoice_${INVOICE_ID}_qr.png" 2>/dev/null || true
        print_status "QR code saved to /tmp/invoice_${INVOICE_ID}_qr.png"
    fi
}

# Function to get payer balance
get_payer_balance() {
    print_header "Checking Payer Balance"

    # Get payer address from private key using our Node.js script
    PAYER_ADDRESS=$(node "$PROJECT_ROOT/scripts/derive-address.js" "$PAYER_PRIVATE_KEY" 2>/dev/null)

    if [ -z "$PAYER_ADDRESS" ]; then
        print_error "Could not derive payer address from private key"
        exit 1
    fi

    print_success "Payer Address: $PAYER_ADDRESS"

    # Get balance using eth-cli
    if command_exists eth; then
        ETH_CMD="eth"
    else
        ETH_CMD="$PROJECT_ROOT/node_modules/.bin/eth"
    fi

    PAYER_BALANCE=$($ETH_CMD address:balance "$PAYER_ADDRESS" --network="$RPC_URL" 2>/dev/null || echo "0")

    print_status "Payer Balance: $PAYER_BALANCE ETH"

    # Check if balance is sufficient (rough check)
    if [ "$PAYER_BALANCE" = "0" ] || [ "$PAYER_BALANCE" = "0.0" ]; then
        print_warning "Payer balance appears to be zero. Make sure the wallet has testnet funds."
        read -p "Do you want to continue anyway? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            print_status "Payment cancelled by user"
            exit 0
        fi
    fi
}

# Function to get optimal gas price via direct RPC call
get_optimal_gas_price() {
    print_status "Getting current network gas price..."

    # Direct RPC call to get current gas price
    local gas_price_hex
    gas_price_hex=$(curl -s -X POST "$RPC_URL" \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"eth_gasPrice","params":[],"id":1}' |
        jq -r '.result' 2>/dev/null)

    if [ "$gas_price_hex" != "null" ] && [ "$gas_price_hex" != "0x0" ] && [ -n "$gas_price_hex" ]; then
        local gas_price_dec
        gas_price_dec=$(printf "%d" "$gas_price_hex" 2>/dev/null)
        local gas_price_gwei
        gas_price_gwei=$(echo "scale=6; $gas_price_dec / 1000000000" | bc -l 2>/dev/null)

        if [ -n "$gas_price_gwei" ]; then
            print_success "Current gas price: $gas_price_gwei gwei"
            echo "$gas_price_gwei"
            return 0
        fi
    fi

    # Fallback if RPC call fails
    print_warning "Could not get gas price from RPC, using default"
    echo "20"
    return 1
}
execute_payment() {
    print_header "Executing Payment"

    local currency="${1:-ETH}"
    local amount=$(echo "scale=0; ${2:-0.0001} * 1000000000000000000/1" | bc -l 2>/dev/null)

    if command_exists eth; then
        ETH_CMD="eth"
    else
        ETH_CMD="$PROJECT_ROOT/node_modules/.bin/eth"
    fi

    print_status "Sending $amount wei to $INVOICE_ADDRESS..."

    if [ "$currency" = "ETH" ]; then
        # Get current network gas price
        local optimal_gas_price
        optimal_gas_price=$(get_optimal_gas_price)
        local gas_price_status=$?

        if [ $gas_price_status -eq 0 ] && [ -n "$optimal_gas_price" ]; then
            print_success "Using gas price: $optimal_gas_price gwei"

            local gas_price_wei
            # Add 20% buffer for reliable mining
            gas_price_wei=$(echo "scale=0; $optimal_gas_price * 1.2 * 1000000000/1" | bc -l 2>/dev/null)

            if [ -n "$gas_price_wei" ]; then
                TX_HASH=$($ETH_CMD tx:send \
                    --to "$INVOICE_ADDRESS" \
                    --value "$amount" \
                    --pk "$PAYER_PRIVATE_KEY" \
                    --network "$RPC_URL" \
                    --gasPrice "$gas_price_wei" \
                    2>/dev/null || echo "")
            fi
        else
            print_warning "Gas price detection failed, using default settings"
        fi

        if [ -z "$TX_HASH" ]; then
            print_error "Failed to send ETH payment with all attempted methods"
            print_status "Debugging information:"
            echo "  - Invoice Address: $INVOICE_ADDRESS"
            echo "  - Amount: $amount"
            echo "  - RPC URL: $RPC_URL"
            echo "  - Gas Price: ${optimal_gas_price:-'not determined'} gwei"
            exit 1
        fi

        print_success "ETH payment sent successfully!"
        echo "Transaction Hash: $TX_HASH"

        if [ -n "$optimal_gas_price" ]; then
            echo "Gas Price Used: $optimal_gas_price gwei"
        fi

    else
        print_error "ERC20 payments not yet implemented in this script"
        echo "Please send ERC20 tokens manually to: $INVOICE_ADDRESS"
        return 1
    fi

    # Wait a moment for transaction to propagate
    print_status "Waiting for transaction to propagate..."
    sleep 5

    # Get transaction receipt with enhanced analysis
    print_status "Retrieving transaction receipt..."
    TX_RECEIPT=$($ETH_CMD receipt "$TX_HASH" --rpc "$RPC_URL" 2>/dev/null || echo "")

    if [ -n "$TX_RECEIPT" ]; then
        TX_STATUS=$(echo "$TX_RECEIPT" | jq -r '.status // "unknown"' 2>/dev/null || echo "unknown")
        if [ "$TX_STATUS" = "0x1" ] || [ "$TX_STATUS" = "1" ]; then
            print_success "Transaction confirmed successfully!"
        else
            print_warning "Transaction status unclear: $TX_STATUS"
        fi

        # Extract detailed transaction information
        BLOCK_NUMBER=$(echo "$TX_RECEIPT" | jq -r '.blockNumber // "unknown"' 2>/dev/null || echo "unknown")
        GAS_USED=$(echo "$TX_RECEIPT" | jq -r '.gasUsed // "unknown"' 2>/dev/null || echo "unknown")
        EFFECTIVE_GAS_PRICE=$(echo "$TX_RECEIPT" | jq -r '.effectiveGasPrice // "unknown"' 2>/dev/null || echo "unknown")

        echo ""
        echo "=== Transaction Details ==="
        echo "Block Number: $BLOCK_NUMBER"
        echo "Gas Used: $GAS_USED"

        if [ "$EFFECTIVE_GAS_PRICE" != "unknown" ] && [ "$EFFECTIVE_GAS_PRICE" != "null" ]; then
            EFFECTIVE_GAS_PRICE_DEC=$(printf "%d" "$EFFECTIVE_GAS_PRICE" 2>/dev/null || echo "0")
            if [ "$EFFECTIVE_GAS_PRICE_DEC" != "0" ]; then
                EFFECTIVE_GAS_PRICE_GWEI=$(echo "scale=6; $EFFECTIVE_GAS_PRICE_DEC / 1000000000" | bc -l 2>/dev/null || echo "unknown")
                echo "Effective Gas Price: $EFFECTIVE_GAS_PRICE_GWEI gwei"

                # Calculate total transaction cost
                if [ "$GAS_USED" != "unknown" ] && [ "$GAS_USED" != "null" ]; then
                    GAS_USED_DEC=$(printf "%d" "$GAS_USED" 2>/dev/null || echo "0")
                    if [ "$GAS_USED_DEC" != "0" ]; then
                        TOTAL_GAS_COST_WEI=$((EFFECTIVE_GAS_PRICE_DEC * GAS_USED_DEC))
                        TOTAL_GAS_COST_ETH=$(echo "scale=8; $TOTAL_GAS_COST_WEI / 1000000000000000000" | bc -l 2>/dev/null || echo "unknown")
                        echo "Total Gas Cost: $TOTAL_GAS_COST_ETH ETH"
                    fi
                fi
            fi
        fi

        # Compare requested vs actual gas price
        if [ -n "$optimal_gas_price" ] && [ "$EFFECTIVE_GAS_PRICE_GWEI" != "unknown" ]; then
            echo ""
            echo "=== Gas Price Analysis ==="
            echo "Requested Gas Price: $optimal_gas_price gwei"
            echo "Effective Gas Price: $EFFECTIVE_GAS_PRICE_GWEI gwei"

            # Calculate difference
            local price_diff
            price_diff=$(echo "scale=6; $EFFECTIVE_GAS_PRICE_GWEI - $optimal_gas_price" | bc -l 2>/dev/null)
            if [ -n "$price_diff" ]; then
                if [ "$(echo "$price_diff >= 0" | bc -l)" -eq 1 ]; then
                    echo "Price Difference: +$price_diff gwei (paid more)"
                else
                    echo "Price Difference: $price_diff gwei (paid less)"
                fi
            fi
        fi

    else
        print_warning "Could not retrieve transaction receipt"
        print_status "Transaction may still be pending. Check manually with:"
        echo "  $ETH_CMD receipt $TX_HASH --rpc $RPC_URL"
    fi
}

# Function to check invoice status via REST API
check_invoice_status() {
    local invoice_id="$1"
    local invoice_response

    invoice_response=$(curl -s -X GET "${INVOICE_API_BASE_URL}invoices/${invoice_id}" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $API_KEY_VALUE" 2>/dev/null)

    if [ $? -eq 0 ] && echo "$invoice_response" | jq -e '.invoiceId' >/dev/null 2>&1; then
        local status
        status=$(echo "$invoice_response" | jq -r '.status')
        echo "$status"
        return 0
    else
        echo "error"
        return 1
    fi
}

# Function to monitor payment detection using REST API
monitor_payment() {
    print_header "Monitoring Payment Detection"

    print_status "Waiting for payment detection system to process the payment..."
    print_status "This may take up to 1-2 minutes (watcher runs every minute)..."

    local max_attempts=8
    local attempt=1
    local current_status="pending"

    while [ $attempt -le $max_attempts ]; do
        print_status "Check $attempt/$max_attempts - Checking invoice status..."

        # Check invoice status via REST API
        current_status=$(check_invoice_status "$INVOICE_ID")

        if [ "$current_status" = "error" ]; then
            print_warning "Failed to check invoice status via API"
        else
            print_status "Current invoice status: $current_status"

            case "$current_status" in
            "paid")
                print_success "Payment detected! Invoice status: PAID"
                print_status "Waiting for fund sweeping to complete..."

                # Wait a bit more for sweeping
                local sweep_attempts=8
                local sweep_attempt=1

                while [ $sweep_attempt -le $sweep_attempts ]; do
                    sleep 15
                    current_status=$(check_invoice_status "$INVOICE_ID")
                    print_status "Sweep check $sweep_attempt/$sweep_attempts - Status: $current_status"

                    if [ "$current_status" = "swept" ]; then
                        print_success "Fund sweeping completed! Invoice status: SWEPT"
                        return 0
                    fi

                    sweep_attempt=$((sweep_attempt + 1))
                done

                print_warning "Payment detected but sweeping may still be in progress"
                return 0
                ;;
            "swept")
                print_success "Payment detected and funds swept! Invoice status: SWEPT"
                return 0
                ;;
            "pending")
                print_status "Payment not yet detected, waiting..."
                ;;
            "cancelled")
                print_error "Invoice was cancelled"
                return 1
                ;;
            *)
                print_status "Unknown status: $current_status"
                ;;
            esac
        fi

        if [ $attempt -lt $max_attempts ]; then
            print_status "Waiting 20 seconds before next check..."
            sleep 20
        fi

        attempt=$((attempt + 1))
    done

    print_warning "Payment detection monitoring completed"
    print_status "Final invoice status: $current_status"

    if [ "$current_status" = "pending" ]; then
        print_warning "Payment may still be processing. Check manually:"
        echo "curl -X GET \"${INVOICE_API_BASE_URL}invoices/${INVOICE_ID}\""
        return 1
    fi

    return 0
}

# Function to display final invoice details
display_final_invoice_details() {
    print_header "Final Invoice Details"

    print_status "Fetching final invoice details..."

    local final_invoice_response
    final_invoice_response=$(curl -s -X GET "${INVOICE_API_BASE_URL}invoices/${INVOICE_ID}" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $API_KEY_VALUE" 2>/dev/null)

    if [ $? -eq 0 ] && echo "$final_invoice_response" | jq -e '.invoiceId' >/dev/null 2>&1; then
        echo -e "${BLUE} Final Invoice Status:${NC}"
        echo "$final_invoice_response" | jq -r '
            "• Invoice ID: " + .invoiceId +
            "\n• Address: " + .address +
            "\n• Status: " + .status +
            "\n• Currency: " + .currency +
            "\n• Amount: " + .amount + " " + .tokenSymbol +
            "\n• Created: " + .createdAt +
            (if .paidAt then "\n• Paid At: " + .paidAt else "" end) +
            (if .sweptAt then "\n• Swept At: " + .sweptAt else "" end)
        '
    else
        print_warning "Could not fetch final invoice details"
    fi
}

# Function to display summary
display_summary() {
    print_header "Payment Execution Summary"

    echo -e "${GREEN} Payment execution completed!${NC}\n"

    echo -e "${BLUE} Transaction Details:${NC}"
    echo "• Invoice ID: $INVOICE_ID"
    echo "• Payment Address: $INVOICE_ADDRESS"
    echo "• Payer Address: $PAYER_ADDRESS"
    echo "• Amount: $PAYMENT_AMOUNT $PAYMENT_CURRENCY"
    if [ -n "$TX_HASH" ]; then
        echo "• Transaction Hash: $TX_HASH"
    fi

    # Display final invoice details from API
    display_final_invoice_details

    echo -e "\n${BLUE} Manual Monitoring Commands:${NC}"
    echo "• Check invoice status:"
    echo "  curl -X GET \"${INVOICE_API_BASE_URL}invoices/${INVOICE_ID}\" -H \"X-API-Key: $API_KEY_VALUE\""
    echo ""
    echo "• List all invoices:"
    echo "  curl -X GET \"${INVOICE_API_BASE_URL}invoices\" -H \"X-API-Key: $API_KEY_VALUE\""
    echo ""
    echo "• Filter by status:"
    echo "  curl -X GET \"${INVOICE_API_BASE_URL}invoices?status=paid\" -H \"X-API-Key: $API_KEY_VALUE\""

    echo -e "\n${BLUE} Monitoring Resources:${NC}"
    echo "• Invoice Management API: ${INVOICE_API_BASE_URL}invoices"
    echo "• CloudWatch Log Groups:"
    echo "  - /aws/lambda/CryptoInvoiceStack-InvoiceFunction*"
    echo "  - /aws/lambda/CryptoInvoiceStack-WatcherFunction*"
    echo "  - /aws/lambda/CryptoInvoiceStack-SweeperFunction*"

    if [ -n "$TREASURY_PUBLIC_ADDRESS" ]; then
        echo -e "\n• Treasury Address: $TREASURY_PUBLIC_ADDRESS"
    fi
}

# Main execution flow
main() {
    print_header "Execute Payment - End-to-End Test"

    # Parse command line arguments
    PAYMENT_CURRENCY="${1:-ETH}"
    PAYMENT_AMOUNT="${2:-0.0001}"
    TOKEN_ADDRESS="${3:-}"
    TOKEN_SYMBOL="${4:-}"
    DECIMALS="${5:-}"

    echo "This script will:"
    echo "1. Create a new $PAYMENT_CURRENCY invoice for $PAYMENT_AMOUNT"
    echo "2. Check payer wallet balance"
    echo "3. Execute payment using eth-cli"
    echo "4. Monitor payment detection"
    echo ""

    read -p "Do you want to continue? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_status "Payment execution cancelled by user"
        exit 0
    fi

    # Execute steps
    check_prerequisites
    validate_environment
    get_api_url
    create_invoice "$PAYMENT_CURRENCY" "$PAYMENT_AMOUNT" "$TOKEN_ADDRESS" "$TOKEN_SYMBOL" "$DECIMALS"
    get_payer_balance
    execute_payment "$PAYMENT_CURRENCY" "$PAYMENT_AMOUNT"
    monitor_payment
    display_summary
}

# Handle script interruption
trap 'print_error "Payment execution interrupted by user"; exit 1' INT

# Show usage if help requested
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
    echo "Usage: $0 [CURRENCY] [AMOUNT] [TOKEN_ADDRESS] [TOKEN_SYMBOL] [DECIMALS]"
    echo ""
    echo "Examples:"
    echo "  $0                                    # Create ETH invoice for 0.0001 ETH"
    echo "  $0 ETH 0.00005                         # Create ETH invoice for 0.00005 ETH"
    echo "  $0 ERC20 5.0 0x1c7D4B... USDC 6     # Create ERC20 invoice (not yet supported for payment)"
    echo ""
    echo "Environment variables required in .env:"
    echo "  RPC_URL - Ethereum RPC endpoint"
    echo "  PAYER_PRIVATE_KEY - Private key of wallet with testnet funds"
    echo ""
    exit 0
fi

# Run main function
main "$@"
