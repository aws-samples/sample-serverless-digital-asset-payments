# Processing SUI Digital Asset Payments on AWS

This is a SUI-specific implementation of the serverless digital asset payment system, based on the [AWS EVM-compatible blueprint](https://aws.amazon.com/blogs/web3/processing-digital-asset-payments-on-aws/).

## Table of Contents

- [Architecture](#architecture)
- [How It Works](#how-it-works)
- [Key Differences from EVM Implementation](#key-differences-from-evm-implementation)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Deployment](#deployment)
- [Usage](#usage)
- [API Reference](#api-reference)
- [Payment Flow](#payment-flow)
- [Clean Up](#clean-up)
- [Security Notes](#security-notes)
- [Troubleshooting](#troubleshooting)

## Architecture

The SUI implementation follows the same architecture as the EVM version but uses SUI-specific libraries and transaction structures:

- **Native SUI payments** instead of ETH
- **Token payments** (USDC, USDT, custom SUI tokens) with whitelist validation
- **SUI Move programmable transactions** for token transfers
- **Ed25519 key derivation** (SLIP-0010) instead of secp256k1
- **SUI JSON RPC** instead of Ethereum JSON RPC

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │ POST /create-invoice
       ▼
┌─────────────────────────────────────┐
│          API Gateway                │
│  https://<your-api-id>.execute-api  │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────┐      ┌──────────────┐
│ Invoice         │─────▶│  DynamoDB    │
│ Generator       │      │  SuiInvoices │
│ Lambda          │      └──────┬───────┘
└─────────────────┘             │
                                │ DynamoDB Stream
       ┌────────────────────────┤
       │                        │
       ▼                        ▼
┌─────────────────┐      ┌──────────────┐
│ Watcher         │      │   Sweeper    │
│ Lambda          │      │   Lambda     │
│ (every minute)  │      │ (on payment) │
└────────┬────────┘      └──────────────┘
         │
         ▼
   ┌──────────┐
   │   SUI    │
   │ Testnet  │
   └──────────┘
```

## How It Works

### Wallet Architecture

This system uses two types of wallets with different security models:

**Invoice Addresses (Hot Wallets):**
- Automatically generated from your mnemonic using BIP44 derivation path `m/44'/784'/0'/0'/x'`
- Each invoice gets a unique address (index 0, 1, 2, ...)
- Private keys stored in AWS Secrets Manager (encrypted at rest)
- Funds are automatically swept after payment detection
- These are temporary addresses for receiving payments only

**Treasury Address (Cold Wallet):**
- Your destination wallet where all swept funds accumulate
- Should be a hardware wallet (Ledger, Trezor) for production
- Only the public address is stored in AWS (no private key)
- You maintain full control of this wallet offline

### What You Provide

1. **Mnemonic** (12 words) - Generates invoice addresses
   - Create new: `sui client new-address ed25519`
   - Or use existing SUI wallet mnemonic
   - Stored securely in AWS Secrets Manager

2. **Treasury Address** (0x...) - Receives all swept funds
   - For production: Use hardware wallet address
   - For testing: Leave empty (uses default test address)

### What the System Generates

- Unique invoice addresses for each payment request
- API endpoint and key for creating invoices
- QR codes for customer payments
- Automatic payment detection and fund sweeping

## Key Differences from EVM Implementation

1. **Wallet Derivation**: Uses BIP44 path `m/44'/784'/0'/0'/x'` for SUI (SLIP-0010)
2. **Transaction Structure**: SUI transactions with programmable transaction blocks
3. **Gas Model**: MIST for gas (1 SUI = 1,000,000,000 MIST)
4. **Account Model**: SUI's object-based model vs Ethereum's account model
5. **Treasury Security**: Supports external hardware wallets (Ledger, Trezor)

## Prerequisites

1. AWS Account with appropriate permissions
2. Node.js 18.x or later
3. AWS CDK CLI installed (`npm install -g aws-cdk`)
4. AWS CLI configured (`aws configure`)
5. Rust toolchain (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
6. Cargo Lambda (`cargo install cargo-lambda`)

## Quick Start

```bash
# Clone and navigate to project
cd sui-payment-agent

# Install dependencies
npm install

# Configure environment
cp .env-sample .env
# Edit .env with your TREASURY_ADDRESS (optional for testing)

# Build and deploy
./build.sh
npm run deploy

# Setup mnemonic in AWS Secrets Manager
npm run setup-secrets
```

**After deployment, proceed to [Usage](#usage) to start creating invoices.**

## Deployment

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy the sample configuration:

```bash
cp .env-sample .env
```

Update `.env` with your values:

```bash
# Required for production, optional for testing
TREASURY_ADDRESS=0xYOUR_HARDWARE_WALLET_ADDRESS

# Optional
ALERT_EMAIL=your-email@example.com
SUI_RPC_URL=https://fullnode.testnet.sui.io:443
```

**Important:** For production, use a hardware wallet address for `TREASURY_ADDRESS`.

### 3. Build Lambda Functions

```bash
./build.sh
```

This builds all Rust Lambda functions using cargo-lambda.

### 4. Bootstrap CDK (First Time Only)

```bash
npx cdk bootstrap
```

### 5. Deploy Stack

```bash
npm run deploy
```

### 6. Setup Secrets

```bash
npm run setup-secrets
```

This stores your mnemonic in AWS Secrets Manager. You'll be prompted to:
- Enter an existing 12-word mnemonic, OR
- Generate a new one using SUI CLI

## Usage

### Retrieve API Credentials

After deployment, get your API endpoint and key:

```bash
export STACK_NAME="SuiPaymentStack"
export API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" --output text)
export API_KEY_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiKeyId'].OutputValue" --output text)
export API_KEY=$(aws apigateway get-api-key --api-key "$API_KEY_ID" --include-value \
  --query 'value' --output text)

echo "API URL: $API_URL"
echo "API Key: $API_KEY"
```

### Create Invoice

Create a native SUI payment invoice:

```bash
curl -X POST "${API_URL}create-invoice" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "amount": 100000000,
    "reference_id": "order-123",
    "expiry_seconds": 3600
  }'
```

Create a token payment invoice (USDC example):

```bash
curl -X POST "${API_URL}create-invoice" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "amount": 1000000,
    "reference_id": "order-124",
    "expiry_seconds": 3600,
    "token_type": "token",
    "token_address": "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
    "token_symbol": "USDC",
    "token_decimals": 6
  }'
```

Response:

```json
{
  "invoice_id": "550e8400-e29b-41d4-a716-446655440000",
  "recipient_address": "0xabc123...",
  "amount": 100000000,
  "expiry": 1234567890,
  "qr_code_base64": "data:image/png;base64,iVBORw0KG..."
}
```

### List Invoices

```bash
# List all invoices
curl -X GET "${API_URL}invoices" \
  -H "x-api-key: $API_KEY"

# Filter by status
curl -X GET "${API_URL}invoices?status=pending" \
  -H "x-api-key: $API_KEY"

# Pagination
curl -X GET "${API_URL}invoices?limit=10" \
  -H "x-api-key: $API_KEY"
```

### Get Invoice Details

```bash
curl -X GET "${API_URL}invoices/{invoiceId}" \
  -H "x-api-key: $API_KEY"
```

### Cancel Invoice

```bash
curl -X PUT "${API_URL}invoices/{invoiceId}" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status": "cancelled"}'
```

**Note:** Only `pending` invoices can be cancelled. `paid` and `swept` statuses are immutable.

### Delete Invoice

```bash
curl -X DELETE "${API_URL}invoices/{invoiceId}" \
  -H "x-api-key: $API_KEY"
```

**Note:** Only `pending` or `cancelled` invoices can be deleted.

## Testing Payments

### Automated Test Script

Test the complete payment flow (create invoice → send payment → verify):

```bash
# Test with default amount (0.1 SUI)
npm run test-payment

# Test with custom amount (in MIST)
./scripts/test-payment.sh 500000000
```

### Manual Testing

1. **Create invoice** using the API
2. **Fund the address** via SUI testnet Discord faucet:
   - Visit: https://discord.com/channels/916379725201563759/971488439931392130
   - Use command: `!faucet <address>`
3. **Wait for detection** (watcher runs every minute)
4. **Verify sweep** to treasury address

### Monitor Invoice Status

```bash
# Check specific invoice
curl -X GET "${API_URL}invoices/{invoiceId}" \
  -H "x-api-key: $API_KEY"

# Watch for status changes: pending → paid → swept
```

## API Reference

### POST /create-invoice

Create a new payment invoice with a unique SUI address.

**Request Body (Native SUI):**
```json
{
  "amount": 100000000,
  "reference_id": "order-123",
  "expiry_seconds": 3600
}
```

**Request Body (Token Payment):**
```json
{
  "amount": 1000000,
  "reference_id": "order-124",
  "expiry_seconds": 3600,
  "token_type": "token",
  "token_address": "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
  "token_symbol": "USDC",
  "token_decimals": 6
}
```

**Parameters:**
- `amount` (number, required): Payment amount in smallest unit (MIST for SUI, token decimals for tokens)
- `reference_id` (string, required): Your internal reference ID
- `expiry_seconds` (number, required): Invoice expiration time in seconds
- `token_type` (string, optional): Set to "token" for token payments (default: native SUI)
- `token_address` (string, required if token_type="token"): Full token address (e.g., "0x...::coin::COIN")
- `token_symbol` (string, required if token_type="token"): Token symbol (e.g., "USDC")
- `token_decimals` (number, required if token_type="token"): Token decimal places (e.g., 6 for USDC)

**Token Whitelist:**
Only whitelisted tokens are accepted. Current whitelist:
- USDC: `0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN`

To add tokens, update the whitelist in `invoice-generator/src/main.rs` and redeploy.

**Response:**
```json
{
  "invoice_id": "550e8400-e29b-41d4-a716-446655440000",
  "recipient_address": "0xabc123...",
  "amount": 100000000,
  "expiry": 1234567890,
  "qr_code_base64": "data:image/png;base64,..."
}
```

### GET /invoices

List all invoices with optional filtering and pagination.

**Query Parameters:**
- `status` (string, optional): Filter by status (`pending`, `paid`, `swept`, `cancelled`)
- `limit` (number, optional): Maximum results to return (default: 50)
- `lastKey` (string, optional): Pagination token from previous response

**Response:**
```json
{
  "invoices": [...],
  "lastEvaluatedKey": "..."
}
```

### GET /invoices/{invoiceId}

Get details for a specific invoice.

**Response:**
```json
{
  "invoice_id": "550e8400-e29b-41d4-a716-446655440000",
  "recipient_address": "0xabc123...",
  "amount": 100000000,
  "status": "paid",
  "created_at": 1234567890,
  "expiry": 1234571490
}
```

### PUT /invoices/{invoiceId}

Update an invoice (currently only supports cancellation).

**Request Body:**
```json
{
  "status": "cancelled"
}
```

**Security Rules:**
- Only `pending` → `cancelled` transitions allowed
- `paid` and `swept` statuses are immutable

### DELETE /invoices/{invoiceId}

Delete an invoice (only `pending` or `cancelled` invoices).

**Response:**
```json
{
  "message": "Invoice deleted successfully"
}
```

## Payment Flow

1. **Invoice Creation**: System generates unique SUI address via HD wallet derivation
2. **Customer Payment**: Customer sends SUI to the generated address
3. **Payment Monitoring**: Watcher Lambda checks for payments every minute
4. **Payment Detection**: Invoice marked as "paid" when funds received
5. **Fund Sweeping**: Sweeper Lambda automatically transfers funds to treasury wallet
6. **Status Update**: Invoice marked as "swept"

## Clean Up

To remove all deployed resources:

```bash
cdk destroy
```

**Warning:** This will delete:
- All Lambda functions
- DynamoDB tables (including invoice history)
- API Gateway
- CloudWatch logs

The mnemonic in Secrets Manager must be deleted manually:

```bash
aws secretsmanager delete-secret \
  --secret-id sui-payment-mnemonic \
  --force-delete-without-recovery
```

## Security Notes

### Security Model

- **Mnemonic**: Stored in AWS Secrets Manager (encrypted at rest with AWS KMS)
- **Secrets Access**: Restricted to specific Lambda function IAM roles only
- **API Gateway**: Secured with API keys (rotate regularly)
- **Treasury Wallet**: Should be an offline hardware wallet (Ledger, Trezor)
- **Invoice Addresses**: Hot wallets with automated sweeping (funds never stay long)

### Best Practices

1. **Use Hardware Wallet for Treasury**: Never store treasury private keys in the cloud
2. **Rotate API Keys**: Regularly rotate API Gateway keys
3. **Monitor CloudWatch**: Set up alerts for failed sweeps or errors
4. **Backup Mnemonic**: Keep secure offline backup of invoice mnemonic
5. **Test on Testnet First**: Thoroughly test before deploying to mainnet

See [SECURITY_SETUP.md](./SECURITY_SETUP.md) for detailed security configuration.

## Troubleshooting

### Invoice Generation Fails

**Symptom**: API returns 500 error when creating invoice

**Solution**: Verify mnemonic is stored in Secrets Manager:
```bash
aws secretsmanager get-secret-value --secret-id sui-payment-mnemonic
```

If missing, run: `npm run setup-secrets`

### Payments Not Detected

**Symptom**: Invoice stays in "pending" status after payment

**Solutions**:
1. Verify payment on SUI explorer: https://suiscan.xyz/testnet
2. Check RPC URL is correct in environment variables
3. Wait 1-2 minutes for watcher cycle to complete
4. Check watcher Lambda logs in CloudWatch

### Sweeping Issues

**Symptom**: Invoice marked "paid" but funds not swept

**Solutions**:
1. Check sweeper Lambda logs in CloudWatch
2. Verify treasury address is valid SUI address
3. Check if invoice address has sufficient balance for gas
4. Review DynamoDB Stream configuration

### Watcher Lambda Not Running

**Symptom**: No payment detection happening

**Solutions**:
1. Verify EventBridge rule is enabled
2. Check watcher Lambda logs for errors
3. Manually invoke watcher Lambda to test
4. Verify Lambda has correct IAM permissions

## Additional Documentation

- [SECURITY_SETUP.md](./SECURITY_SETUP.md) - Hardware wallet configuration
- [DEPLOY_HARDWARE_WALLET.md](./DEPLOY_HARDWARE_WALLET.md) - Production deployment guide
- [MONITORING_SETUP.md](./MONITORING_SETUP.md) - CloudWatch monitoring configuration
- [KMS_PRODUCTION_NOTES.md](./KMS_PRODUCTION_NOTES.md) - Ed25519 signing and KMS alternatives
- [PHASE3_MULTI_TOKEN_SUPPORT.md](./PHASE3_MULTI_TOKEN_SUPPORT.md) - Token payment implementation details

## SUI Testnet Resources

- **Faucet**: https://discord.com/channels/916379725201563759/971488439931392130
- **Explorer**: https://suiscan.xyz/testnet
- **RPC Endpoint**: https://fullnode.testnet.sui.io:443
- **Documentation**: https://docs.sui.io

## Cost Estimate

Estimated monthly costs for moderate usage:

- **Lambda**: ~$0.20/million requests
- **DynamoDB**: Pay-per-request (~$1.25/million writes)
- **API Gateway**: $3.50/million requests
- **Secrets Manager**: $0.40/month
- **CloudWatch**: ~$2/month (logs + custom metrics)
- **DynamoDB PITR**: ~$0.40/month
- **API Gateway Logging**: ~$0.50/month

**Total**: ~$6-11/month for moderate usage (100-1000 invoices/month)

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the MIT-0 License - see the LICENSE file for details.

## Support

For issues and questions:
- Open an issue on GitHub
- Check existing documentation in the `/docs` folder
- Review CloudWatch logs for error details
