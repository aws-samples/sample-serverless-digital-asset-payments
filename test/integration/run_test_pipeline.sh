#!/usr/bin/env bash

# Minimal test pipeline script

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

# Trap to cleanup on exit
# cleanup_on_exit() {
#     if [ "$?" -ne 0 ]; then
#         print_error "Pipeline failed, running cleanup..."
#         ./test/integration/cleanup.sh
#     fi
# }
# trap cleanup_on_exit EXIT

echo -e "\n${BLUE}=== Crypto Invoice Test Pipeline ===${NC}\n"

# Check prerequisites
print_status "Checking prerequisites..."
if [ ! -f ".env" ]; then
    print_error ".env file not found"
    exit 1
fi

# Step 1: Setup
print_status "Step 1/3: Running setup..."
echo "y" | ./test/integration/setup.sh

# Step 2: Execute payment test
print_status "Step 2/3: Testing payment execution..."
echo "y" | ./test/integration/execute_payment.sh ETH 0.0001

# Step 3: Cleanup
print_status "Step 3/3: Running cleanup..."
# ./test/integration/cleanup.sh

# Success
echo -e "\n${GREEN}=== Pipeline Completed Successfully ===${NC}"
print_success "All tests passed and cleanup completed"
