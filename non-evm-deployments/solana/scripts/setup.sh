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
    
    if [ -f .env ] && grep -q "SOLANA_TREASURY_PUBLIC_KEY" .env; then
        echo "⚠️  Wallets already exist in .env"
        read -p "Regenerate? (y/N): " -n 1 -r
        echo
        [[ ! $REPLY =~ ^[Yy]$ ]] && return
    fi
    
    npm run generate-wallets
    
    # Add AWS_REGION to .env if not present
    if [ -f .env ] && ! grep -q "AWS_REGION" .env; then
        DETECTED_REGION=$(aws configure get region 2>/dev/null || echo "$AWS_REGION")
        if [ -n "$DETECTED_REGION" ]; then
            sed -i.bak '1s/^/AWS_REGION='"$DETECTED_REGION"'\n/' .env && rm .env.bak
            echo "✅ Added AWS_REGION=$DETECTED_REGION to .env"
        fi
    fi
    
    echo "✅ Wallets generated"
}

bootstrap_cdk() {
    print_header "CDK Bootstrap"
    cd "$PROJECT_ROOT"
    
    AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
    DETECTED_REGION=$(aws configure get region 2>/dev/null || echo "$AWS_REGION")
    
    if aws cloudformation describe-stacks --stack-name CDKToolkit --region "$DETECTED_REGION" >/dev/null 2>&1; then
        echo "✅ CDK already bootstrapped"
    else
        echo "Bootstrapping CDK..."
        cdk bootstrap "aws://$AWS_ACCOUNT/$DETECTED_REGION"
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

subscribe_sns_notifications() {
    print_header "SNS Email Notifications (Optional)"
    
    read -p "Subscribe to payment notifications via email? (y/N): " -n 1 -r
    echo
    [[ ! $REPLY =~ ^[Yy]$ ]] && return
    
    read -p "Enter email address: " email
    
    if [[ -z "$email" ]]; then
        echo "⚠️  No email provided, skipping"
        return
    fi
    
    SNS_TOPIC_ARN=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='SolanaPaymentNotificationTopicArn'].OutputValue" --output text)
    
    aws sns subscribe \
        --topic-arn "$SNS_TOPIC_ARN" \
        --protocol email \
        --notification-endpoint "$email" >/dev/null
    
    echo "✅ Subscription request sent to $email"
    echo "⚠️  Check your email and confirm the subscription"
}

display_summary() {
    print_header "Setup Complete!"
    
    API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='SolanaInvoiceApiBaseUrl'].OutputValue" --output text)
    
    API_KEY_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='SolanaInvoiceApiKeyId'].OutputValue" --output text)
    
    KMS_KEY_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='SolanaHotWalletKmsKeyId'].OutputValue" --output text)
    
    echo "🎉 Your Solana Invoice System is ready!"
    echo ""
    
    print_header "⚠️  IMPORTANT: Fund Your Wallets"
    npm run wallet-info
    
    print_header "API Information"
    echo "API URL: $API_URL"
    echo ""
    echo "Get API Key:"
    echo "  aws apigateway get-api-key --api-key $API_KEY_ID --include-value --query 'value' --output text"
    echo ""
    echo "KMS Hot Wallet Key ID: $KMS_KEY_ID"
    echo ""
    
    print_header "Test Payments"
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
    echo "3. Generate wallets (treasury & test payer)"
    echo "4. Bootstrap CDK"
    echo "5. Deploy stack (creates KMS hot wallet)"
    echo "6. Setup secrets (mnemonic & KMS key)"
    echo "7. Display hot wallet address for funding"
    echo "8. Subscribe to SNS notifications (optional)"
    echo ""
    
    read -p "Continue? (y/N): " -n 1 -r
    echo
    [[ ! $REPLY =~ ^[Yy]$ ]] && exit 0
    
    check_prerequisites
    install_dependencies
    generate_wallets
    bootstrap_cdk
    deploy_stack
    setup_secrets
    subscribe_sns_notifications
    display_summary
}

trap 'echo "❌ Setup interrupted"; exit 1' INT
main "$@"
