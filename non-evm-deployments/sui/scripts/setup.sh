#!/usr/bin/env bash

# SUI Payment Agent - End-to-End Setup Script
set -Eeuo pipefail

trap 'echo -e "\n❌ Error at line $LINENO"' ERR

STACK_NAME="SuiPaymentStack"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

print_header() {
    echo -e "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "  $1"
    echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
}

check_prerequisites() {
    print_header "Checking Prerequisites"

    local missing=()

    command -v node >/dev/null 2>&1      || missing+=("node")
    command -v npm >/dev/null 2>&1       || missing+=("npm")
    command -v aws >/dev/null 2>&1       || missing+=("aws-cli")
    command -v cdk >/dev/null 2>&1       || missing+=("aws-cdk (npm install -g aws-cdk)")
    command -v cargo >/dev/null 2>&1     || missing+=("rust (https://rustup.rs)")
    command -v cargo-lambda >/dev/null 2>&1 || missing+=("cargo-lambda (cargo install cargo-lambda)")

    if [ ${#missing[@]} -ne 0 ]; then
        echo "❌ Missing required tools:"
        for tool in "${missing[@]}"; do
            echo "   - $tool"
        done
        exit 1
    fi

    if ! aws sts get-caller-identity >/dev/null 2>&1; then
        echo "❌ AWS credentials not configured. Run: aws configure"
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

    if [ -f .env ] && grep -q "TREASURY_ADDRESS=0x" .env; then
        echo "Wallets already exist in .env"
        read -p "Regenerate? This will create a new mnemonic. (y/N): " -n 1 -r
        echo
        [[ ! $REPLY =~ ^[Yy]$ ]] && return
    fi

    npm run generate-wallets
    echo "✅ Wallets generated"
}

build_lambdas() {
    print_header "Building Lambda Functions"
    cd "$PROJECT_ROOT"
    ./build.sh
    echo "✅ Lambda functions built"
}

bootstrap_cdk() {
    print_header "CDK Bootstrap"
    cd "$PROJECT_ROOT"

    local aws_account detected_region
    aws_account=$(aws sts get-caller-identity --query Account --output text)
    detected_region=$(aws configure get region 2>/dev/null || echo "${AWS_DEFAULT_REGION:-us-east-1}")

    if aws cloudformation describe-stacks --stack-name CDKToolkit --region "$detected_region" >/dev/null 2>&1; then
        echo "✅ CDK already bootstrapped in $detected_region"
    else
        echo "Bootstrapping CDK for aws://$aws_account/$detected_region ..."
        cdk bootstrap "aws://$aws_account/$detected_region"
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

    local api_url api_key_id
    api_url=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" --output text)
    api_key_id=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='ApiKeyId'].OutputValue" --output text)

    echo "Your SUI Payment Agent is ready!"
    echo ""
    echo "API Endpoint: $api_url"
    echo ""
    echo "Get API Key:"
    echo "  aws apigateway get-api-key --api-key $api_key_id --include-value --query 'value' --output text"
    echo ""

    print_header "Test Payment"
    echo "Run the end-to-end test:"
    echo "  npm run test-payment"
    echo ""
    echo "Or fund the invoice address manually via the SUI testnet faucet:"
    echo "  https://faucet.testnet.sui.io"
}

main() {
    print_header "SUI Payment Agent Setup"

    echo "This will:"
    echo "  1. Check prerequisites"
    echo "  2. Install npm dependencies"
    echo "  3. Generate wallets (treasury address + mnemonic)"
    echo "  4. Build Rust Lambda functions"
    echo "  5. Bootstrap CDK (first time only)"
    echo "  6. Deploy AWS stack"
    echo "  7. Store mnemonic in Secrets Manager"
    echo ""

    read -p "Continue? (y/N): " -n 1 -r
    echo
    [[ ! $REPLY =~ ^[Yy]$ ]] && exit 0

    check_prerequisites
    install_dependencies
    generate_wallets
    build_lambdas
    bootstrap_cdk
    deploy_stack
    setup_secrets
    display_summary
}

trap 'echo "❌ Setup interrupted"; exit 1' INT
main "$@"
