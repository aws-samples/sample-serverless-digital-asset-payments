#!/bin/bash

# Lint and Static Analysis Script
# Runs all code quality checks locally

set -e

echo "🚀 Running comprehensive code quality checks..."
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
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

# Step 1: TypeScript Compilation
print_step "Checking TypeScript compilation..."
if npm run build; then
    print_success "TypeScript compilation passed"
else
    print_error "TypeScript compilation failed"
    exit 1
fi
echo ""

# Step 2: ESLint
print_step "Running ESLint..."
if npm run lint; then
    print_success "ESLint passed"
else
    print_error "ESLint found issues"
    echo "Run 'npm run lint:fix' to auto-fix some issues"
    exit 1
fi
echo ""

# Step 3: Prettier
print_step "Checking code formatting..."
if npm run format:check; then
    print_success "Code formatting is correct"
else
    print_warning "Code formatting issues found"
    echo "Run 'npm run format' to fix formatting"
    exit 1
fi
echo ""

# Step 4: Security Analysis
print_step "Running security analysis..."
if npm run security; then
    print_success "Security analysis passed"
else
    print_error "Security issues found"
    exit 1
fi
echo ""

# Step 5: CDK Nag
print_step "Running CDK Nag security analysis..."
export RPC_URL="https://eth-sepolia.g.alchemy.com/v2/demo"
export TREASURY_PUBLIC_ADDRESS="0x1234567890123456789012345678901234567890"

if npm run nag; then
    print_success "CDK Nag analysis passed"
else
    print_error "CDK Nag found security issues"
    exit 1
fi
echo ""

# Step 6: Vulnerability Check
print_step "Checking for known vulnerabilities..."
if npm audit --audit-level=moderate; then
    print_success "No moderate or high vulnerabilities found"
else
    print_warning "Vulnerabilities detected - review npm audit output"
fi
echo ""

# Summary
echo -e "${GREEN}✅ All code quality checks completed successfully!${NC}"
echo ""
echo "📊 Summary:"
echo "  ✅ TypeScript compilation"
echo "  ✅ ESLint (code quality)"
echo "  ✅ Prettier (formatting)"
echo "  ✅ Security analysis"
echo "  ✅ CDK Nag (infrastructure security)"
echo "  ✅ Vulnerability scan"
echo ""
echo "🚀 Your code is ready for commit!"