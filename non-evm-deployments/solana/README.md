# Processing Solana Digital Asset Payments on AWS

This is a Solana-specific implementation of the serverless digital asset payment
system, based on the EVM-compatible blueprint.

## Table of Contents

- [Architecture](#architecture)
- [Key Differences from EVM Implementation](#key-differences-from-evm-implementation)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Deployment](#deployment)
- [Usage](#usage)
  - [Retrieve API Credentials](#retrieve-api-credentials)
  - [Create Invoice](#create-invoice)
- [Testing Payments](#testing-payments)
- [API Reference](#api-reference)
- [Payment Flow](#payment-flow)
- [Clean Up](#clean-up)
- [Security Notes](#security-notes)
- [Troubleshooting](#troubleshooting)

## Architecture

The Solana implementation follows the same architecture as the EVM version but
uses Solana-specific libraries and transaction structures:

- **Native SOL payments** instead of ETH
- **SPL tokens** instead of ERC20
- **ed25519 key derivation** instead of secp256k1
- **Solana JSON RPC** instead of Ethereum JSON RPC

## Key Differences from EVM Implementation

1. **Wallet Derivation**: Uses BIP44 path `m/44'/501'/x'/0'` for Solana
2. **Transaction Structure**: Solana transactions with instructions vs Ethereum
   transactions
3. **Token Standard**: SPL tokens vs ERC20
4. **Gas Model**: Lamports for rent/fees vs gas in Wei
5. **Account Model**: Solana's account-based model with Associated Token
   Accounts

## Prerequisites

1. AWS Account
2. Node.js 18.x or later
3. AWS CDK CLI installed (`npm install -g aws-cdk`)

## Quick Start

```bash
cd sample-serverless-digital-asset-payments/non-evm-deployments/solana
npm install
npm run setup
```

**After deployment, proceed to [Usage](#usage) to start creating invoices.**

For detailed deployment steps, continue below.

## Deployment

### 1. Install Dependencies

```bash
cd sample-serverless-digital-asset-payments/non-evm-deployments/solana
npm install
```

### 2. Generate Wallets

```bash
npm run generate-wallets
```

Creates treasury, hot, and test payer wallets, populating `.env` automatically.
The script outputs all wallet addresses and funding instructions.

**Note:** To use your own wallets, modify `SOLANA_TREASURY_ADDRESS`,
`SOLANA_HOT_WALLET_PRIVATE_KEY`, and `SOLANA_PAYER_PRIVATE_KEY` in `.env` after
running this script, then continue with deployment.

### 3. Fund Wallets

Use the addresses from the `generate-wallets` output (or run
`npm run wallet-info` to see them again):

Fund with SOL:

- Visit https://faucet.solana.com
- Paste hot wallet address and request airdrop
- Paste payer address and request airdrop

Fund with USDC:

- Visit https://faucet.circle.com
- Select "Solana Devnet"
- Paste payer address

### 4. Deploy Stack

```bash
npm run deploy
```

### 5. Setup Secrets

```bash
npm run setup-secrets
```

Stores mnemonic and hot wallet private key in AWS Secrets Manager.

## Usage

### Retrieve API Credentials

```bash
export STACK_NAME="SolanaInvoiceStack"

export API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='SolanaInvoiceApiBaseUrl'].OutputValue" --output text)

export API_KEY_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='SolanaInvoiceApiKeyId'].OutputValue" --output text)

export API_KEY=$(aws apigateway get-api-key --api-key "$API_KEY_ID" --include-value \
  --query 'value' --output text 2>/dev/null)
```

### Create Invoice

Create SOL Invoice:

```bash
curl -X POST "${API_URL}generateInvoice" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "currency": "SOL",
    "amount": "0.01"
  }'
```

Create SPL Token Invoice:

```bash
curl -X POST "${API_URL}generateInvoice" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "currency": "SPL",
    "tokenMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "tokenSymbol": "USDC",
    "amount": "5.00"
  }'
```

## Testing Payments

### Automated Test Scripts

Test complete payment flow (create invoice → send payment → verify):

```bash
# Test SOL payment (default 0.01 SOL)
./scripts/test-sol-payment.sh

# Test SOL payment with custom amount
./scripts/test-sol-payment.sh 0.05

# Test USDC payment (default 1.00 USDC)
./scripts/test-spl-payment.sh

# Test USDC payment with custom amount
./scripts/test-spl-payment.sh 5.00
```

### Manual Payment Scripts

Send payment to existing invoice:

```bash
# Send SOL
node scripts/send-payment.js <INVOICE_ADDRESS> <AMOUNT_SOL>

# Send SPL token
node scripts/send-spl-payment.js <INVOICE_ADDRESS> <AMOUNT> <TOKEN_MINT>
```

**Note:** Payer private key is automatically read from
`SOLANA_PAYER_PRIVATE_KEY` in `.env`.

### Monitor Invoice Status

```bash
# Check specific invoice
curl -X GET "${API_URL}invoices/{invoiceId}" \
  -H "X-API-Key: $API_KEY"

# Watch for status changes: pending → paid → swept
```

## API Reference

### POST /generateInvoice

**Request Body:**

- `currency`: "SOL" or "SPL"
- `amount`: Payment amount as string
- `tokenMint`: (Required for SPL) Token mint address
- `tokenSymbol`: (Required for SPL) Token symbol

**Response:**

```json
{
  "invoiceId": "uuid",
  "address": "solana_public_key",
  "index": "number",
  "qrcodeBase64": "data:image/png;base64,..."
}
```

### Invoice Management Endpoints

- **GET** `/invoices` - List all invoices (with optional `?status=pending`
  filter)
- **GET** `/invoices/{invoiceId}` - Get specific invoice
- **PUT** `/invoices/{invoiceId}` - Update invoice status
- **DELETE** `/invoices/{invoiceId}` - Delete pending invoice

## Payment Flow

1. **Invoice Creation**: Generate unique Solana address via HD wallet derivation
2. **Payment Monitoring**: Watcher Lambda checks for SOL/SPL token payments
   every minute
3. **Payment Detection**: Mark invoice as "paid" when funds received
4. **Fund Sweeping**: Sweeper Lambda automatically transfers funds to treasury
   wallet
5. **Status Update**: Invoice marked as "swept"

## Clean Up

```bash
cdk destroy --app 'npx ts-node bin/solana-invoice.ts'
```

## Security Notes

- Mnemonic and hot wallet keys stored in AWS Secrets Manager
- Secrets restricted to specific Lambda function roles
- API Gateway secured with API keys
- For security, the treasury wallet is recommended to be an offline hardware
  wallet

## Troubleshooting

1. **Invoice Generation Fails**: Verify mnemonic is in Secrets Manager
2. **Payments Not Detected**: Check RPC URL and wait for confirmation
3. **Sweeping Issues**: Ensure hot wallet has sufficient SOL for rent/fees
4. **SPL Token Issues**: Verify token mint address and ensure Associated Token
   Account exists
