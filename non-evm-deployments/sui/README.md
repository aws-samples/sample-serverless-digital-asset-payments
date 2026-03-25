# Processing SUI Digital Asset Payments on AWS

This is a SUI-specific implementation of the serverless digital asset payment
system, based on the
[AWS EVM-compatible blueprint](https://aws.amazon.com/blogs/web3/processing-digital-asset-payments-on-aws/).
Configured for SUI testnet by default.

## Table of Contents

- [Architecture](#architecture)
- [Key Differences from EVM Implementation](#key-differences-from-evm-implementation)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Deployment](#deployment)
- [Usage](#usage)
- [Testing Payments](#testing-payments)
- [API Reference](#api-reference)
- [Payment Flow](#payment-flow)
- [Clean Up](#clean-up)
- [Security Notes](#security-notes)
- [Troubleshooting](#troubleshooting)

## Architecture

The SUI implementation follows the same architecture as the EVM version but uses
SUI-specific libraries and transaction structures:

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

## Key Differences from EVM Implementation

1. **Wallet Derivation**: Uses BIP44 path `m/44'/784'/0'/0'/x'` for SUI
   (SLIP-0010)
2. **Transaction Structure**: SUI transactions with programmable transaction
   blocks
3. **Gas Model**: MIST for gas (1 SUI = 1,000,000,000 MIST)
4. **Account Model**: SUI's object-based model vs Ethereum's account model

## Prerequisites

1. AWS Account with appropriate permissions
2. Node.js 18.x or later
3. AWS CDK CLI installed (`npm install -g aws-cdk`)
4. AWS CLI configured (`aws configure`)
5. Rust toolchain
   (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
6. Cargo Lambda (`cargo install cargo-lambda`)
7. `jq` — used by `scripts/test-payment.sh` to parse API responses
   (`brew install jq` / `apt install jq`)

## Quick Start

```bash
# Clone and navigate to project
cd non-evm-deployments/sui

# Run the automated setup (recommended)
npm run setup
```

`npm run setup` runs `scripts/setup.sh`, which handles all steps end-to-end:
checks prerequisites, installs dependencies, generates wallets, builds Rust
Lambda functions, bootstraps CDK (skipped if already done), deploys the stack,
and stores the mnemonic in Secrets Manager.

**After deployment, proceed to [Usage](#usage) to start creating invoices.**

## Deployment

### Automated Setup (Recommended)

```bash
npm run setup
```

This is the complete, guided path. It checks for all required tools (`node`,
`aws`, `cdk`, `cargo`, `cargo-lambda`) before proceeding, and each step is
idempotent — re-running is safe.

To use an existing wallet instead of generating a new one, copy the sample
configuration and edit it before running setup:

```bash
cp .env-sample .env
# Edit .env: set TREASURY_ADDRESS to your hardware wallet address
npm run setup
```

**Important:** For production, use a hardware wallet address for
`TREASURY_ADDRESS`.

### Manual Steps (Reference)

If you prefer to run each step individually:

```bash
# 1. Install dependencies
npm install

# 2. Generate wallets (creates mnemonic + treasury address)
npm run generate-wallets

# 3. Build Rust Lambda functions
npm run build-lambdas

# 4. Bootstrap CDK (first time only)
npx cdk bootstrap

# 5. Deploy stack
npm run deploy

# 6. Store mnemonic in AWS Secrets Manager
npm run setup-secrets
```

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
    "amount": 0.1,
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
    "amount": 0.01,
    "reference_id": "order-124",
    "expiry_seconds": 3600,
    "token_type": "token",
    "token_address": "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
    "token_symbol": "USDC",
    "token_decimals": 6
  }'
```

> **Amounts are always human-readable.** Use `0.1` for 0.1 SUI, `0.01` for 0.01
> USDC. The system converts to native units (MIST / token decimals) internally.

Response:

```json
{
  "invoice_id": "550e8400-e29b-41d4-a716-446655440000",
  "recipient_address": "0xabc123...",
  "amount": 0.1,
  "expiry": 1234567890,
  "qr_code_base64": "<base64-encoded Unicode text QR code>"
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

**Note:** Only `pending` invoices can be cancelled. `paid` and `swept` statuses
are immutable.

### Delete Invoice

```bash
curl -X DELETE "${API_URL}invoices/{invoiceId}" \
  -H "x-api-key: $API_KEY"
```

**Note:** Only `pending` or `cancelled` invoices can be deleted.

## Token Payments: Fund the KMS Hot Wallet

Token payment sweeps (e.g. USDC) are **sponsored transactions** — the KMS hot
wallet pays the gas fee so the invoice address never needs native SUI. Before
processing any token invoices you must fund the KMS wallet with testnet SUI.

```bash
# Print the KMS hot wallet SUI address
npm run get-kms-address
```

Then send testnet SUI to that address via the faucet:

- Web: https://faucet.testnet.sui.io
- CLI: `sui client faucet --address <kms-address>`

> Native SUI invoices do **not** require this step — the invoice wallet pays its
> own gas directly from the received funds.

## Testing Payments

### Automated Test Script

Test the complete payment flow (create invoice → send payment → verify):

```bash
# Test with default amount (0.1 SUI)
npm run test-payment

# Test with custom amount
./scripts/test-payment.sh 0.5
```

### Manual Testing

1. **Create invoice** using the API
2. **Fund the invoice address** via SUI testnet faucet:
   - Web: https://faucet.testnet.sui.io
   - CLI: `sui client faucet --address <recipient_address>`
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
  "amount": 0.1,
  "reference_id": "order-123",
  "expiry_seconds": 3600
}
```

**Request Body (Token Payment):**

```json
{
  "amount": 0.01,
  "reference_id": "order-124",
  "expiry_seconds": 3600,
  "token_type": "token",
  "token_address": "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
  "token_symbol": "USDC",
  "token_decimals": 6
}
```

**Parameters:**

- `amount` (number, required): Payment amount in human-readable units (e.g.
  `0.1` for 0.1 SUI, `0.01` for 0.01 USDC). The system converts to native units
  internally.
- `reference_id` (string, required): Your internal reference ID
- `expiry_seconds` (number, required): Invoice expiration time in seconds
- `token_type` (string, optional): Set to "token" for token payments (default:
  native SUI)
- `token_address` (string, required if token_type="token"): Full token address
  (e.g., "0x...::coin::COIN")
- `token_symbol` (string, required if token_type="token"): Token symbol (e.g.,
  "USDC")
- `token_decimals` (number, required if token_type="token"): Token decimal
  places (e.g., 6 for USDC)

**Token Whitelist:** Only whitelisted tokens are accepted. Current whitelist:

- USDC:
  `0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC`

To add tokens, update the whitelist in `invoice-generator/src/main.rs` and
redeploy.

**Response:**

```json
{
  "invoice_id": "550e8400-e29b-41d4-a716-446655440000",
  "recipient_address": "0xabc123...",
  "amount": 0.1,
  "expiry": 1234567890,
  "qr_code_base64": "<base64-encoded Unicode text QR code>"
}
```

### GET /invoices

List all invoices with optional filtering and pagination.

**Query Parameters:**

- `status` (string, optional): Filter by status (`pending`, `paid`, `swept`,
  `cancelled`)
- `limit` (number, optional): Maximum results to return (default: 50)
- `lastKey` (string, optional): Pagination token from previous response

**Response:**

```json
{
  "invoices": [...],
  "lastKey": "..."
}
```

### GET /invoices/{invoiceId}

Get details for a specific invoice.

**Response:**

```json
{
  "invoice_id": "550e8400-e29b-41d4-a716-446655440000",
  "recipient_address": "0xabc123...",
  "amount": 0.1,
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

1. **Invoice Creation**: System generates unique SUI address via HD wallet
   derivation
2. **Customer Payment**: Customer sends SUI to the generated address
3. **Payment Monitoring**: Watcher Lambda checks for payments every minute
4. **Payment Detection**: Invoice marked as "paid" when funds received
5. **Fund Sweeping**: Sweeper Lambda automatically transfers funds to treasury
   wallet
6. **Status Update**: Invoice marked as "swept"

## Clean Up

To remove all deployed resources:

```bash
cdk destroy
```

This will delete Lambda functions, DynamoDB tables, API Gateway, SNS topics, the
mnemonic secret, and CloudWatch logs.

**After `cdk destroy`, delete the KMS key manually.** The key is configured with
`removalPolicy: DESTROY` so CDK will attempt deletion, but AWS KMS enforces a
7–30 day waiting period before a key is permanently removed. You can schedule
immediate deletion (minimum 7 days) via:

```bash
aws kms schedule-key-deletion \
  --key-id <KmsKeyId from stack outputs> \
  --pending-window-in-days 7
```

Until deletion completes, the key continues to incur charges (~$1/month per
CMK).

## Security Notes

### Security Model

- **Mnemonic**: Stored in AWS Secrets Manager (encrypted at rest with AWS KMS)
- **Secrets Access**: Restricted to specific Lambda function IAM roles only
- **API Gateway**: Secured with API keys (rotate regularly)
- **Treasury Wallet**: Should be an offline hardware wallet (Ledger, Trezor)
- **Invoice Addresses**: Hot wallets with automated sweeping (funds never stay
  long)

### Best Practices

1. **Use Hardware Wallet for Treasury**: Never store treasury private keys in
   the cloud
2. **Rotate API Keys**: Regularly rotate API Gateway keys
3. **Monitor CloudWatch**: Set up alerts for failed sweeps or errors
4. **Backup Mnemonic**: Keep secure offline backup of invoice mnemonic
5. **Test on Testnet First**: Thoroughly test before deploying to mainnet

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
