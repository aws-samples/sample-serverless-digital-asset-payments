# Processing Digital Asset Payments on AWS

**Authored by: Simon Goldberg and David Dornseifer**

This solution supports native (i.e ETH) and ERC20 token payments on _any_
EVM-compatible blockchain with automated payment detection and fund sweeping
capabilities.

## Architecture

![AWS Web3 Payments Architecture](assets/AWS-Web3-Payments.png)

### Payment Flow Overview

The numbers of each of the steps in the payment flow correspond with the numbers
in the architecture diagram above.

1. **Invoice Creation**

- Merchant creates an invoice via the `/create-invoice` REST API (Amazon API
  Gateway).

2-3. **Invoice Generation**

- The Invoice Generator Lambda is triggered, retrieves the mnemonic from AWS
  Secrets Manager, and increments an atomic counter in DynamoDB to
  deterministically derive a new HD wallet address.

4. **Invoice Storage**

- The Lambda creates a new invoice with `paymentstatus: pending` and stores it
  in DynamoDB.

5. **QR Code Delivery**

- A QR code containing the target address, currency, and amount is generated and
  returned to the merchant for sharing with the customer.

6. **Payment Monitoring**

- A watcher Lambda, triggered every minute via EventBridge, fetches all pending
  invoices and checks for payments via the RPC endpoint. Paid invoices are
  updated accordingly.

7. **Payment Confirmation**

- The watcher Lambda can send payment confirmations via Amazon SNS, which can
  trigger email notifications or push updates.

8. **Sweeper Trigger**

- When a payment is detected, a DynamoDB Stream event triggers the Sweeper
  Lambda process.

9-10. **Sweeping Funds**

- The Sweeper calculates required gas and sends additional native gas tokens to
  an invoice's address if necessary (ie for ERC20 invoices). Once sufficient gas
  is available to make a transaction, funds are "swept" to the offline treasury
  wallet. The invoice is then marked as swept.

11. **Invoice Management**

- Merchants can manage invoices (view status, update payments) via REST
  endpoints exposed by API Gateway.

### Technical Payment Flow

![Technical Payment Flow](assets/payment_flow.drawio.png)

## Deployment

### Prerequisites

1. AWS Account and configured AWS CLI
2. Node.js 18.x or later
3. AWS CDK CLI installed (`npm install -g aws-cdk`)
4. Ethereum or EVM-compatible node access (Infura or similar)

### Environment Variables

Required in `.env` file:

- `RPC_URL`: EVM-compatible RPC URL
- `TREASURY_PUBLIC_ADDRESS`: The destination wallet address where collected
  funds will be automatically transferred (swept). This should be a secure
  wallet, such as a hardware wallet (e.g., Ledger, Trezor), to ensure maximum
  security for your accumulated funds.
- `HOT_WALLET_PK`: The private key of a wallet used to provide gas fees for
  ERC-20 transactions. This wallet needs to be funded with a network's native
  gas token (e.g., Sepolia ETH for Sepolia testnet).
- `PAYER_PRIVATE_KEY`: Test payer private key (optional variable for
  execute_payment script)

```bash
# Copy the sample environment file and update with your values
cp .env-sample .env
```

### Quick Start -- Automated Installation

For complete automated setup:

```bash
# 1. Copy and configure environment variables
cp .env-sample .env
# Edit .env with your actual values

# 2. Run the complete setup
npm run setup
```

This script handles all installation, deployment, and configuration steps
automatically.

### Manual Installation

If you prefer to set up manually:

1. **Install dependencies:**

```bash
npm install
```

2. **Deploy the CDK stack:**

```bash
npm run deploy
```

3. **Generate and store secrets:**

```bash
npm run setup-secrets
```

4. **Subscribe to Payment Notifications (Optional):**
   - Navigate to AWS Console → SNS topic created by the stack
   - Click "Create subscription" → Select "Email" protocol
   - Enter your email address and confirm subscription

## API Reference

### Generate Invoice Endpoint

**POST** `/generateInvoice`

**Headers:**

- Content-Type: application/json
- X-API-Key: `<your-api-key>` (Get your API Key from AWS Console → API Gateway →
  API Keys)

**Request Body Parameters:**

- `currency` (required): "ETH" or "ERC20"
- `amount` (required): Payment amount as string
- `tokenAddress` (required for ERC20): Contract address
- `tokenSymbol` (required for ERC20): Token symbol
- `decimals` (required for ERC20): Token decimals

**Retrieving API Endpoint and Key:**

First, set up your environment variables by retrieving values from
CloudFormation outputs:

```bash
# Set your stack name
STACK_NAME="CryptoInvoiceStack"  # This is the default stack name from deployment

# Get API Gateway URL from CloudFormation stack outputs
API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='InvoiceApiBaseUrl'].OutputValue" --output text)

# Get API key ID directly from CloudFormation outputs
API_KEY_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='InvoiceApiKeyId'].OutputValue" --output text)

# Get the actual API key value
API_KEY=$(aws apigateway get-api-key --api-key "$API_KEY_ID" --include-value \
  --query 'value' --output text 2>/dev/null)

# Verify the values
echo "API URL: $API_URL"
```

**Example Requests:**

1. ERC20 Token Invoice (Sepolia Testnet):

```bash
curl -X POST "${API_URL}generateInvoice" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "currency": "ERC20",
    "tokenAddress": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    "tokenSymbol": "USDC",
    "amount": "5.00",
    "decimals": 6
  }'
```

2. Native ETH Invoice:

```bash
curl -X POST "${API_URL}generateInvoice" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "currency": "ETH",
    "amount": "0.01"
  }'
```

**Response:**

```json
{
  "invoiceId": "uuid",
  "address": "0x...",
  "index": "number",
  "qrcodeBase64": "string"
}
```

After creating an invoice, payment must be sent to the designated invoice
address to initiate the payment process.

**Security Note:** For production environments, do not accept `tokenAddress` and
`decimals` directly from the client-side. Maintain a pre-approved list of tokens
on the server/admin side to prevent security risks from spoofed contract
addresses.

### Invoice Management API

Additional endpoints for invoice administration:

- **GET** `/invoices` - Get all invoices (with optional status filtering and
  pagination)
- **GET** `/invoices/{invoiceId}` - Get specific invoice details
- **PUT** `/invoices/{invoiceId}` - Update invoice status (limited to
  security-safe operations)
- **DELETE** `/invoices/{invoiceId}` - Delete pending invoices

**Query Parameters for GET /invoices:**

- `status` (optional): Filter by invoice status (`pending`, `paid`, `swept`,
  `cancelled`)
- `limit` (optional): Number of invoices to return (default: 50, max: 100)
- `lastKey` (optional): Pagination key for retrieving next page

**Status Update Rules:**

- `pending` ↔ `cancelled` (bidirectional for unpaid invoices)
- `paid` and `swept` statuses are **immutable** to prevent payment manipulation

**Example Requests:**

```bash
# Get all pending invoices
curl -X GET "${API_URL}invoices?status=pending" \
  -H "X-API-Key: $API_KEY"

# Get a specific invoice by ID
curl -X GET "${API_URL}invoices/{invoiceId}" \
  -H "X-API-Key: $API_KEY"

# Cancel a pending invoice
curl -X PUT "${API_URL}invoices/{invoiceId}" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{"status": "cancelled"}'

# Delete a pending invoice
curl -X DELETE "${API_URL}invoices/{invoiceId}" \
  -H "X-API-Key: $API_KEY"
```

## Development and Testing

**Prerequisites for testing:**

- Deployed CDK stack
- Test wallet with testnet funds
- `jq`, `bc`,`curl` and `eth-cli` installed

### Integration Test Features

1. **`npm run setup`**: Complete deployment with prerequisite checks
2. **`npm run test-invoice-management`**: API endpoint testing
3. **`npm run execute-payment`**: End-to-end payment execution with gas
   optimization

## Clean Up Instructions

To avoid incurring unnecessary charges:

1. **Delete the CDK stack:**

```bash
cdk destroy
```

2. **Clean up local files:**

```bash
rm -rf node_modules/ cdk.out/
```

## Troubleshooting

### Common Issues

1. **Invoice Generation Fails:**
   - Verify seed phrase is stored in Secrets Manager (`npm run setup-secrets`)
   - Check RPC_URL configuration
   - Review Lambda function logs in CloudWatch

2. **Payments Not Detected:**
   - Ensure Watcher function is running (CloudWatch Events)
   - Verify RPC node connectivity
   - Wait 1-2 minutes for detection cycle

3. **Sweeping Issues:**
   - Check hot wallet has sufficient ETH for gas
   - Verify treasury address configuration
   - Monitor Sweeper function logs
   - If there is an error and an invoice gets stuck in the "paid" state,
     navigate to the CryptoInvoices DynamoDB Table in the AWS Console and change
     the status of the invoice back to "pending". Then, change it back to
     "paid". This state transition will reinvoke the Sweeper function.

4. **API Authentication:**
   - Retrieve API key from AWS Console → API Gateway → API Keys
   - Or use AWS CLI:
     `aws apigateway get-api-key --api-key <api-key-id> --include-value`

5. **Testing Issues:**
   - Ensure test wallet has sufficient testnet funds
   - Verify all required tools are installed (`jq`, `bc`, `curl`)
   - Check environment variables are properly configured

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more
information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.
