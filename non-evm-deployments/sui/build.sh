#!/bin/bash
set -e

echo "Building Lambda functions..."

# Build each lambda separately and organize into directories
for lambda in invoice-generator invoice-manager watcher sweeper; do
    echo "Building $lambda..."
    cargo lambda build --release --arm64 --package $lambda
    
    # Create directory and move binary
    mkdir -p target/lambda/$lambda
    cp target/lambda/bootstrap/bootstrap target/lambda/$lambda/bootstrap
done

echo "Build complete. Binaries are in target/lambda/"
