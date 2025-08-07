#!/bin/bash

# CDK Test Runner Script
# Ensures TypeScript is compiled before running CDK tests

set -e

echo "🔨 Compiling TypeScript..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ TypeScript compilation failed!"
    exit 1
fi

echo "📁 Checking compilation output..."
echo "Contents of dist directory:"
ls -la dist/ || echo "dist directory does not exist"

if [ -d "dist/lib" ]; then
    echo "Contents of dist/lib directory:"
    ls -la dist/lib/
else
    echo "dist/lib directory does not exist"
fi

# Check if compiled files exist
if [ ! -f "dist/lib/crypto-invoice-stack.js" ]; then
    echo "❌ Compiled JavaScript files not found in dist/lib/"
    echo "Expected: dist/lib/crypto-invoice-stack.js"
    echo ""
    echo "🔍 Debugging information:"
    echo "Current directory: $(pwd)"
    echo "TypeScript config:"
    cat tsconfig.json
    echo ""
    echo "Source files:"
    ls -la lib/
    echo ""
    echo "Attempting manual compilation..."
    npx tsc --listFiles
    exit 1
fi

echo "✅ TypeScript compilation successful"
echo "🧪 Running CDK component tests..."

# Set environment variables for tests
export RPC_URL="https://eth-sepolia.g.alchemy.com/v2/demo"
export TREASURY_PUBLIC_ADDRESS="0x1234567890123456789012345678901234567890"

npx jest test/unit/cdk/crypto-invoice-stack-simple.test.js --verbose

echo "✅ CDK tests completed!"
