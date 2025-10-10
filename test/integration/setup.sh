#!/usr/bin/env bash

# Crypto Invoice CDK - End-to-End Setup Script
# This script performs a complete setup of the crypto invoice system

set -Eeuo pipefail
shopt -s inherit_errexit 2>/dev/null || true

trap 'print_error "Command failed: ${BASH_COMMAND} (exit $?) at line $LINENO"' ERR

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
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
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
    
    # Check Node.js
    if command_exists node; then
        NODE_VERSION=$(node --version)
        print_success "Node.js found: $NODE_VERSION"
        
        # Check if Node version is 18 or higher
        NODE_MAJOR=$(echo $NODE_VERSION | cut -d'.' -f1 | sed 's/v//')
        if [ "$NODE_MAJOR" -lt 18 ]; then
            print_error "Node.js version 18 or higher is required. Current: $NODE_VERSION"
            missing_deps+=("node>=18")
        fi
    else
        print_error "Node.js not found"
        missing_deps+=("node")
    fi
    
    # Check npm
    if command_exists npm; then
        NPM_VERSION=$(npm --version)
        print_success "npm found: $NPM_VERSION"
    else
        print_error "npm not found"
        missing_deps+=("npm")
    fi
    
    # Check AWS CLI
    if command_exists aws; then
        AWS_VERSION=$(aws --version 2>&1 | cut -d' ' -f1)
        print_success "AWS CLI found: $AWS_VERSION"
        
        # Check AWS credentials
        if aws sts get-caller-identity >/dev/null 2>&1; then
            AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
            AWS_REGION=$(aws configure get region)
            print_success "AWS credentials configured - Account: $AWS_ACCOUNT, Region: $AWS_REGION"
        else
            print_error "AWS credentials not configured"
            missing_deps+=("aws-credentials")
        fi
    else
        print_error "AWS CLI not found"
        missing_deps+=("aws-cli")
    fi
    
    # Check CDK CLI
    if command_exists cdk; then
        CDK_VERSION=$(cdk --version)
        print_success "AWS CDK found: $CDK_VERSION"
    else
        print_error "AWS CDK CLI not found"
        missing_deps+=("aws-cdk")
    fi
    
    # Check TypeScript
    if command_exists tsc; then
        TSC_VERSION=$(tsc --version)
        print_success "TypeScript found globally: $TSC_VERSION"
    elif [ -f "$PROJECT_ROOT/node_modules/.bin/tsc" ]; then
        TSC_VERSION=$("$PROJECT_ROOT/node_modules/.bin/tsc" --version)
        print_success "TypeScript found locally: $TSC_VERSION"
    else
        print_warning "TypeScript not found, will be installed with dependencies"
    fi
    
    if [ ${#missing_deps[@]} -ne 0 ]; then
        print_error "Missing dependencies: ${missing_deps[*]}"
        echo -e "\nPlease install the missing dependencies:"
        echo "- Node.js 18+: https://nodejs.org/"
        echo "- AWS CLI: https://aws.amazon.com/cli/"
        echo "- AWS CDK: npm install -g aws-cdk"
        echo "- Configure AWS credentials: aws configure"
        exit 1
    fi
    
    print_success "All prerequisites satisfied!"
}

# Function to validate environment variables
validate_environment() {
    print_header "Validating Environment Configuration"
    
    cd "$PROJECT_ROOT"
    
    # Check if .env file exists
    if [ ! -f ".env" ]; then
        print_error ".env file not found"
        echo "Please create a .env file based on .env-sample:"
        echo "cp .env-sample .env"
        echo "Then edit .env with your actual values"
        exit 1
    fi
    
    # Source the .env file
    set -a  # automatically export all variables
    source .env
    set +a
    
    # Validate required environment variables
    local missing_vars=()
    
    if [ -z "$RPC_URL" ]; then
        missing_vars+=("RPC_URL")
    else
        print_success "RPC_URL configured"
    fi
    
    if [ -z "$TREASURY_PUBLIC_ADDRESS" ]; then
        missing_vars+=("TREASURY_PUBLIC_ADDRESS")
    else
        print_success "TREASURY_PUBLIC_ADDRESS configured: $TREASURY_PUBLIC_ADDRESS"
    fi
    
    if [ -z "$HOT_WALLET_PK" ]; then
        missing_vars+=("HOT_WALLET_PK")
    else
        print_success "HOT_WALLET_PK configured (length: ${#HOT_WALLET_PK} chars)"
    fi
    
    if [ ${#missing_vars[@]} -ne 0 ]; then
        print_error "Missing environment variables: ${missing_vars[*]}"
        echo "Please update your .env file with the required values"
        exit 1
    fi
    
    # Validate RPC URL format
    if [[ ! "$RPC_URL" =~ ^https?:// ]]; then
        print_error "RPC_URL should start with http:// or https://"
        exit 1
    fi
    
    # Validate treasury address format
    if [[ ! "$TREASURY_PUBLIC_ADDRESS" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
        print_error "TREASURY_PUBLIC_ADDRESS should be a valid Ethereum address (0x followed by 40 hex characters)"
        exit 1
    fi
    
    # Validate hot wallet private key format
    if [[ ! "$HOT_WALLET_PK" =~ ^[a-fA-F0-9]{64}$ ]]; then
        print_error "HOT_WALLET_PK should be a 64-character hex string (without 0x prefix)"
        exit 1
    fi
    
    print_success "Environment configuration validated!"
}

# Function to install dependencies
install_dependencies() {
    print_header "Installing Dependencies"
    
    cd "$PROJECT_ROOT"
    
    if [ -f "package-lock.json" ]; then
        print_status "Installing npm dependencies..."
        npm ci
    else
        print_status "Installing npm dependencies..."
        npm install
    fi
    
    print_success "Dependencies installed!"
}

# Function to build the project
build_project() {
    print_header "Building Project"
    
    cd "$PROJECT_ROOT"
    
    print_status "Compiling TypeScript..."
    npm run build
    
    print_status "Synthesizing CDK stack..."
    npm run synth
    
    print_success "Project built successfully!"
}

# Function to bootstrap CDK (if needed)
bootstrap_cdk() {
    print_header "CDK Bootstrap Check"
    
    cd "$PROJECT_ROOT"
    
    AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
    AWS_REGION=$(aws configure get region)
    
    print_status "Checking if CDK is bootstrapped for account $AWS_ACCOUNT in region $AWS_REGION..."
    
    # Check if bootstrap stack exists
    if aws cloudformation describe-stacks --stack-name CDKToolkit --region "$AWS_REGION" >/dev/null 2>&1; then
        print_success "CDK already bootstrapped"
    else
        print_status "Bootstrapping CDK..."
        cdk bootstrap "aws://$AWS_ACCOUNT/$AWS_REGION"
        print_success "CDK bootstrapped successfully!"
    fi
}

# Function to deploy the stack
deploy_stack() {
    print_header "Deploying CDK Stack"
    
    cd "$PROJECT_ROOT"
    
    print_status "Deploying $STACK_NAME..."
    
    # Deploy with auto-approval for automation
    cdk deploy --require-approval never
    
    print_success "Stack deployed successfully!"
    
    # Get stack outputs
    print_status "Retrieving stack outputs..."
    
    INVOICE_API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='InvoiceApiUrl'].OutputValue" --output text)
    
    SNS_TOPIC_ARN=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='PaymentNotificationTopicArn'].OutputValue" --output text)
    
    INVOICE_FUNCTION_NAME=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='InvoiceFunctionName'].OutputValue" --output text)
    
    WATCHER_FUNCTION_NAME=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='WatcherFunctionName'].OutputValue" --output text)
    
    SWEEPER_FUNCTION_NAME=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='SweeperFunctionName'].OutputValue" --output text)
    
    echo -e "\n${GREEN}Stack Outputs:${NC}"
    echo "Invoice API URL: $INVOICE_API_URL"
    echo "SNS Topic ARN: $SNS_TOPIC_ARN"
    echo "Invoice Function: $INVOICE_FUNCTION_NAME"
    echo "Watcher Function: $WATCHER_FUNCTION_NAME"
    echo "Sweeper Function: $SWEEPER_FUNCTION_NAME"
}

# Function to setup secrets
setup_secrets() {
    print_header "Setting Up Secrets"
    
    cd "$PROJECT_ROOT"
    
    print_status "Running secrets setup..."
    npm run setup-secrets
    
    print_success "Secrets configured successfully!"
}

wait_for_api_ready() {
  local url="$1"
  local api_key="$2"
  local max_wait="${3:-180}"   # seconds
  local interval=5
  local deadline=$((SECONDS + max_wait))

  print_status "Waiting for API Gateway & API key to become active (up to ${max_wait}s)..."

  while :; do
    # Try a cheap POST; consider tiny amount to avoid creating noisy data
    local http_code
    http_code=$(curl -s -o /tmp/_apigw_body -w "%{http_code}" -X POST "$url" \
      -H "Content-Type: application/json" \
      -H "X-API-Key: $api_key" \
      -d '{"currency":"ETH","amount":"0.00000001"}' || true)

    # When propagation isn’t done yet, API Gateway often returns 403 Forbidden
    if [ "$http_code" != "403" ]; then
      print_success "API responded with HTTP $http_code — proceeding."
      break
    fi

    if [ $SECONDS -ge $deadline ]; then
      print_error "API Gateway still returning 403 after ${max_wait}s."
      echo "Last body: $(cat /tmp/_apigw_body)"
      return 1
    fi

    print_warning "API not ready yet (HTTP $http_code). Retrying in ${interval}s..."
    sleep $interval
  done
}

# Function to test the deployment
test_deployment() {
    print_header "Testing Deployment"
    
    cd "$PROJECT_ROOT"
    
    API_KEY_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
            --query "Stacks[0].Outputs[?OutputKey=='InvoiceApiKeyId'].OutputValue" --output text)

    # Get the actual API key value
    API_KEY_VALUE=$(aws apigateway get-api-key --api-key "$API_KEY_ID" --include-value \
        --query 'value' --output text 2>/dev/null)

    # Get API URL
    INVOICE_API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='InvoiceApiUrl'].OutputValue" --output text)
    
    if [ -z "$INVOICE_API_URL" ]; then
        print_error "Could not retrieve Invoice API URL"
        return 1
    fi
    wait_for_api_ready "$INVOICE_API_URL" "$API_KEY_VALUE" 180

    print_status "Testing invoice generation API..."
    
    # Test ETH invoice creation
    ETH_RESPONSE=$(curl -s -X POST "$INVOICE_API_URL" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $API_KEY_VALUE" \
        -d '{
            "currency": "ETH",
            "amount": "0.0001"
        }')
    
    if echo "$ETH_RESPONSE" | grep -q "invoiceId"; then
        print_success "ETH invoice creation test passed"
        ETH_INVOICE_ID=$(echo "$ETH_RESPONSE" | grep -o '"invoiceId":"[^"]*"' | cut -d'"' -f4)
        print_status "Created ETH invoice: $ETH_INVOICE_ID"
    else
        print_error "ETH invoice creation test failed"
        echo "Response: $ETH_RESPONSE"
        return 1
    fi
    
    # Test ERC20 invoice creation (using a common testnet USDC address)
    ERC20_RESPONSE=$(curl -s -X POST "$INVOICE_API_URL" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $API_KEY_VALUE" \
        -d '{
            "currency": "ERC20",
            "tokenAddress": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
            "tokenSymbol": "USDC",
            "amount": "5.00",
            "decimals": 6
        }')
    
    if echo "$ERC20_RESPONSE" | grep -q "invoiceId"; then
        print_success "ERC20 invoice creation test passed"
        ERC20_INVOICE_ID=$(echo "$ERC20_RESPONSE" | grep -o '"invoiceId":"[^"]*"' | cut -d'"' -f4)
        print_status "Created ERC20 invoice: $ERC20_INVOICE_ID"
    else
        print_error "ERC20 invoice creation test failed"
        echo "Response: $ERC20_RESPONSE"
        return 1
    fi
    
    # Test Lambda functions
    print_status "Testing Lambda functions..."
    
    # Test invoice function
    if aws lambda get-function --function-name "$INVOICE_FUNCTION_NAME" >/dev/null 2>&1; then
        print_success "Invoice Lambda function is accessible"
    else
        print_error "Invoice Lambda function is not accessible"
        return 1
    fi
    
    # Test watcher function
    if aws lambda get-function --function-name "$WATCHER_FUNCTION_NAME" >/dev/null 2>&1; then
        print_success "Watcher Lambda function is accessible"
    else
        print_error "Watcher Lambda function is not accessible"
        return 1
    fi
    
    # Test sweeper function
    if aws lambda get-function --function-name "$SWEEPER_FUNCTION_NAME" >/dev/null 2>&1; then
        print_success "Sweeper Lambda function is accessible"
    else
        print_error "Sweeper Lambda function is not accessible"
        return 1
    fi
    
    print_success "All deployment tests passed!"
}

# Function to setup SNS subscription (optional)
setup_sns_subscription() {
    print_header "Setting Up SNS Email Subscription (Optional)"
    
    SNS_TOPIC_ARN=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='PaymentNotificationTopicArn'].OutputValue" --output text)
    
    echo -e "\nWould you like to set up email notifications for payments?"
    read -p "Enter your email address (or press Enter to skip): " EMAIL_ADDRESS
    
    if [ -n "$EMAIL_ADDRESS" ]; then
        print_status "Creating SNS email subscription..."
        
        SUBSCRIPTION_ARN=$(aws sns subscribe \
            --topic-arn "$SNS_TOPIC_ARN" \
            --protocol email \
            --notification-endpoint "$EMAIL_ADDRESS" \
            --query 'SubscriptionArn' --output text)
        
        print_success "Email subscription created!"
        print_warning "Please check your email and confirm the subscription to receive payment notifications."
        echo "Subscription ARN: $SUBSCRIPTION_ARN"
    else
        print_status "Skipping email subscription setup"
    fi
}

# Function to display final summary
display_summary() {
    print_header "Setup Complete!"
    
    # Get stack outputs
    INVOICE_API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='InvoiceApiUrl'].OutputValue" --output text)
    
    SNS_TOPIC_ARN=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='PaymentNotificationTopicArn'].OutputValue" --output text)
    
    echo -e "${GREEN}🎉 Your Crypto Invoice System is ready to use!${NC}\n"
    
    echo -e "${BLUE}📋 System Information:${NC}"
    echo "• Stack Name: $STACK_NAME"
    echo "• Invoice API URL: $INVOICE_API_URL"
    echo "• SNS Topic ARN: $SNS_TOPIC_ARN"
    echo "• Treasury Address: $TREASURY_PUBLIC_ADDRESS"
    
    echo -e "\n${BLUE}🚀 Next Steps:${NC}"
    echo "1. Test invoice creation:"
    echo "   curl -X POST $INVOICE_API_URL \\"
    echo "     -H 'Content-Type: application/json' \\"
    echo "     -H 'X-API-Key: <your-api-key>' \\"
    echo "     -d '{\"currency\": \"ETH\", \"amount\": \"0.0001\"}'"

    echo "Note: Get your API Key from AWS Console → API Gateway → API Keys"

    echo -e "\n2. Monitor your system:"
    echo "   • Check CloudWatch logs for Lambda functions"
    echo "   • Monitor DynamoDB tables for invoice data"
    echo "   • Watch for SNS notifications on payments"
    
    echo -e "\n3. Fund your hot wallet for ERC-20 gas fees:"
    echo "   • Send some native tokens (ETH) to your hot wallet"
    echo "   • This is needed for ERC-20 token sweeping operations"
    
    echo -e "\n${BLUE}📚 Additional Resources:${NC}"
    echo "• README.md - Detailed documentation"
    echo "• test/integration/test-invoice-management-api.sh - API testing script"
    
    echo -e "\n${GREEN}✅ Setup completed successfully!${NC}"
}

# Main execution flow
main() {
    print_header "Crypto Invoice CDK - End-to-End Setup"
    
    echo "This script will:"
    echo "1. Check prerequisites"
    echo "2. Validate environment configuration"
    echo "3. Install dependencies"
    echo "4. Build the project"
    echo "5. Bootstrap CDK (if needed)"
    echo "6. Deploy the CDK stack"
    echo "7. Set up secrets"
    echo "8. Test the deployment"
    echo "9. Optionally set up email notifications"
    echo ""
    
    read -p "Do you want to continue? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_status "Setup cancelled by user"
        exit 0
    fi
    
    # Execute setup steps
    check_prerequisites
    validate_environment
    install_dependencies
    build_project
    bootstrap_cdk
    deploy_stack
    setup_secrets
    test_deployment
    setup_sns_subscription
    display_summary
}

# Handle script interruption
trap 'print_error "Setup interrupted by user"; exit 1' INT

# Run main function
main "$@"
