#!/usr/bin/env bash

# Solana Invoice CDK - End-to-End Setup Script
set -Eeuo pipefail

trap 'echo -e "\n❌ Error at line $LINENO"' ERR

STACK_NAME="SolanaInvoiceStack"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

print_header() {
    echo -e "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "  $1"
    echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
}

check_prerequisites() {
    print_header "Checking Prerequisites"
    
    local missing=()
    
    command -v node >/dev/null 2>&1 || missing+=("node")
    command -v npm >/dev/null 2>&1 || missing+=("npm")
    command -v aws >/dev/null 2>&1 || missing+=("aws-cli")
    command -v cdk >/dev/null 2>&1 || missing+=("aws-cdk")
    
    if [ ${#missing[@]} -ne 0 ]; then
        echo "❌ Missing: ${missing[*]}"
        exit 1
    fi
    
    if ! aws sts get-caller-identity >/dev/null 2>&1; then
        echo "❌ AWS credentials not configured"
        exit 1
    fi
    
    echo "✅ All prerequisites satisfied"
}

install_dependencies() {
    print_header "Installing Dependencies"
    cd "$PROJECT_ROOT"
    npm install
    echo "✅ Dependencies installed"
}

generate_wallets() {
    print_header "Generating Wallets"
    cd "$PROJECT_ROOT"
    
    if [ -f .env ] && grep -q "SOLANA_HOT_WALLET_PRIVATE_KEY" .env; then
        echo "⚠️  Wallets already exist in .env"
        read -p "Regenerate? (y/N): " -n 1 -r
        echo
        [[ ! $REPLY =~ ^[Yy]$ ]] && return
    fi
    
    npm run generate-wallets
    echo "✅ Wallets generated"
}

prompt_funding() {
    print_header "Fund Wallets"
    
    cd "$PROJECT_ROOT"
    npm run wallet-info
    
    echo ""
    read -p "Press Enter when wallets are funded..."
}

bootstrap_cdk() {
    print_header "CDK Bootstrap"
    cd "$PROJECT_ROOT"
    
    AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
    AWS_REGION=$(aws configure get region)
    
    if aws cloudformation describe-stacks --stack-name CDKToolkit --region "$AWS_REGION" >/dev/null 2>&1; then
        echo "✅ CDK already bootstrapped"
    else
        echo "Bootstrapping CDK..."
        cdk bootstrap "aws://$AWS_ACCOUNT/$AWS_REGION"
        echo "✅ CDK bootstrapped"
    fi
}

deploy_stack() {
    print_header "Deploying Stack"
    cd "$PROJECT_ROOT"
    npm run deploy
    echo "✅ Stack deployed"
}

setup_secrets() {
    print_header "Setting Up Secrets"
    cd "$PROJECT_ROOT"
    npm run setup-secrets
    echo "✅ Secrets configured"
}

display_summary() {
    print_header "Setup Complete!"
    
    API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='SolanaInvoiceApiBaseUrl'].OutputValue" --output text)
    
    API_KEY_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='SolanaInvoiceApiKeyId'].OutputValue" --output text)
    
    echo "🎉 Your Solana Invoice System is ready!"
    echo ""
    echo "API URL: $API_URL"
    echo ""
    echo "Get API Key:"
    echo "  aws apigateway get-api-key --api-key $API_KEY_ID --include-value --query 'value' --output text"
    echo ""
    echo "Test SOL payment:"
    echo "  ./scripts/test-sol-payment.sh"
    echo ""
    echo "Test USDC payment:"
    echo "  ./scripts/test-spl-payment.sh"
}

main() {
    print_header "Solana Invoice Setup"
    
    echo "This will:"
    echo "1. Check prerequisites"
    echo "2. Install dependencies"
    echo "3. Generate wallets"
    echo "4. Prompt for funding"
    echo "5. Bootstrap CDK"
    echo "6. Deploy stack"
    echo "7. Setup secrets"
    echo ""
    
    read -p "Continue? (y/N): " -n 1 -r
    echo
    [[ ! $REPLY =~ ^[Yy]$ ]] && exit 0
    
    check_prerequisites
    install_dependencies
    generate_wallets
    prompt_funding
    bootstrap_cdk
    deploy_stack
    setup_secrets
    display_summary
}

trap 'echo "❌ Setup interrupted"; exit 1' INT
main "$@"
