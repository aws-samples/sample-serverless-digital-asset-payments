#!/bin/bash

# CDK Test Runner Script
# Ensures TypeScript is compiled before running CDK tests

set -e

echo "Compiling TypeScript..."
npm run build

if [ $? -ne 0 ]; then
    echo "TypeScript compilation failed!"
    exit 1
fi

# Check if compiled files exist
if [ ! -f "dist/lib/crypto-invoice-stack.js" ]; then
    echo "Compiled JavaScript files not found in dist/lib/"
    echo "Expected: dist/lib/crypto-invoice-stack.js"
    exit 1
fi

echo "TypeScript compilation successful"
echo "Running CDK component tests..."
npx jest test/unit/cdk --verbose

echo "CDK tests completed!"
