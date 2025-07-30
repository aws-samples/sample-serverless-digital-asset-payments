#!/usr/bin/env bash

# Minimal cleanup script for integration tests

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

print_status "Cleaning up test resources..."

# Destroy CDK stack
if aws cloudformation describe-stacks --stack-name CryptoInvoiceStack >/dev/null 2>&1; then
    print_status "Destroying CDK stack..."
    cdk destroy --force
    print_success "Stack destroyed"
else
    print_status "Stack not found, skipping destruction"
fi

# Clean local artifacts
print_status "Cleaning local artifacts..."
rm -rf cdk.out/ dist/ /tmp/invoice_*_qr.png 2>/dev/null || true

print_success "Cleanup complete"
