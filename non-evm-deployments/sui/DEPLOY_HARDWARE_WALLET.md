# Deployment Guide - Hardware Wallet Treasury

## Quick Start

### 1. Generate Hardware Wallet Address

**Option A: Use SUI CLI (Recommended for Testing)**
```bash
# Install SUI CLI
cargo install --locked --git https://github.com/MystenLabs/sui.git --branch testnet sui

# Generate new address
sui client new-address ed25519

# Save the output:
# - Address: 0x... (use this for TREASURY_ADDRESS)
# - Recovery phrase: 12 words (write down and store securely)
```

**Option B: Use Hardware Wallet (Recommended for Production)**
- Connect Ledger/Trezor
- Open SUI app
- Get your SUI address
- Use that address for TREASURY_ADDRESS

### 2. Deploy with Hardware Wallet Treasury

```bash
cd /Users/rwricard/sui-payment-agent

# Set treasury address
export TREASURY_ADDRESS="0xYOUR_HARDWARE_WALLET_ADDRESS"

# Build Lambda functions
./build.sh

# Deploy infrastructure
npx cdk deploy --require-approval never
```

### 3. Verify Configuration

```bash
# Check sweeper Lambda environment
aws lambda get-function-configuration \
  --function-name $(aws cloudformation describe-stack-resources \
    --stack-name SuiPaymentStack \
    --query 'StackResources[?LogicalResourceId==`Sweeper`].PhysicalResourceId' \
    --output text) \
  --query 'Environment.Variables.TREASURY_ADDRESS' \
  --output text
```

Should output your hardware wallet address.

### 4. Test End-to-End

```bash
# Create invoice
curl -X POST https://aa4ipn64z1.execute-api.us-east-1.amazonaws.com/prod/create-invoice \
  -H "x-api-key: YOUR_API_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"amount": 100000000, "reference_id": "test-hw-wallet", "expiry_seconds": 3600}'

# Fund the returned address via Discord faucet

# Manually mark as paid (watcher workaround)
aws dynamodb update-item --table-name SuiInvoices \
  --key '{"invoice_id": {"S": "INVOICE_ID_FROM_RESPONSE"}}' \
  --update-expression "SET #s = :paid" \
  --expression-attribute-names '{"#s": "status"}' \
  --expression-attribute-values '{":paid": {"S": "paid"}}'

# Wait ~30 seconds for sweep

# Check treasury balance
curl -s -X POST https://fullnode.testnet.sui.io:443 \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\":\"2.0\",
    \"id\":1,
    \"method\":\"suix_getBalance\",
    \"params\":[\"$TREASURY_ADDRESS\"]
  }" | jq -r '.result.totalBalance'
```

## Migration from Current Setup

If you're already deployed with the default treasury (index 0):

### 1. Generate New Hardware Wallet

```bash
sui client new-address ed25519
# Save the address and recovery phrase
```

### 2. Update and Redeploy

```bash
export TREASURY_ADDRESS="0xNEW_HARDWARE_WALLET_ADDRESS"
npx cdk deploy --require-approval never
```

### 3. Transfer Existing Funds (Optional)

If the old treasury has funds:

```bash
# Check old treasury balance
OLD_TREASURY="0x09e66c87d06058ee3d292bbb6284b2b9ac31bbeab0da5e1f75cec4ddf6e00b52"
curl -s -X POST https://fullnode.testnet.sui.io:443 \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\":\"2.0\",
    \"id\":1,
    \"method\":\"suix_getBalance\",
    \"params\":[\"$OLD_TREASURY\"]
  }" | jq -r '.result.totalBalance'

# If balance > 0, transfer manually using SUI CLI or wallet
# You'll need the mnemonic from AWS Secrets Manager to access old treasury
```

### 4. Verify New Setup

All future sweeps will go to the new hardware wallet address.

## Rollback

To revert to the default treasury (testing only):

```bash
unset TREASURY_ADDRESS
npx cdk deploy --require-approval never
```

## Troubleshooting

**Q: Deployment fails with "Invalid address"**  
A: Ensure your address starts with `0x` and is a valid SUI address (66 characters total)

**Q: Sweeps still going to old address**  
A: Check Lambda environment variable was updated:
```bash
aws lambda get-function-configuration --function-name <sweeper-name> \
  --query 'Environment.Variables.TREASURY_ADDRESS'
```

**Q: How do I spend from the hardware wallet?**  
A: Use your hardware wallet's interface or SUI CLI with the recovery phrase. The system only sends TO the treasury, it doesn't spend FROM it.

## Security Checklist

- [ ] Treasury address is from hardware wallet or securely generated
- [ ] Recovery phrase written down and stored securely (not digitally)
- [ ] `TREASURY_ADDRESS` environment variable set before deployment
- [ ] Verified sweeper Lambda has correct treasury address
- [ ] Tested end-to-end sweep to new treasury
- [ ] Old treasury funds transferred (if applicable)
- [ ] Recovery phrase stored in safe location (not on computer)

## Cost Impact

No change in AWS costs - this is purely a configuration change.

## Next Steps

1. ✅ Deploy with hardware wallet treasury
2. ⏳ Fix watcher Lambda
3. ⏳ Subscribe to email alerts
4. ⏳ Set up monitoring dashboard
5. ⏳ Plan mainnet deployment
