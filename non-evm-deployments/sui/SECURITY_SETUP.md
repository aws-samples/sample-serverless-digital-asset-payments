# Security Configuration Guide

## Treasury Wallet Setup

For production use, the treasury wallet should be a **hardware wallet** (Ledger, Trezor, etc.) to ensure maximum security. The private key for the treasury wallet should NEVER be stored in AWS.

### Current Security Model

**Invoice Addresses (Hot Wallets):**
- Derived from mnemonic stored in AWS Secrets Manager
- Private keys accessible to Lambda for automated sweeping
- Each address used once, then swept immediately
- Limited exposure: funds held briefly (minutes to hours)
- Maximum loss per breach: one invoice amount

**Treasury Address (Cold Wallet):**
- Should be a separate hardware wallet
- Only the PUBLIC address is stored in AWS (environment variable)
- Private key remains offline on hardware device
- Accumulates all swept funds securely

### How to Set Up Hardware Wallet Treasury

#### Option 1: Use Existing Hardware Wallet

If you already have a Ledger or Trezor with SUI support:

1. Open your hardware wallet's SUI app
2. Get your SUI address (starts with `0x`)
3. Set it as environment variable before deployment:
   ```bash
   export TREASURY_ADDRESS="0xYOUR_HARDWARE_WALLET_ADDRESS"
   npx cdk deploy
   ```

#### Option 2: Generate New SUI Wallet

If you don't have a hardware wallet, you can use the SUI CLI to generate a new wallet:

```bash
# Install SUI CLI
cargo install --locked --git https://github.com/MystenLabs/sui.git --branch testnet sui

# Generate new address
sui client new-address ed25519

# This will output:
# - Your new address (starts with 0x)
# - Recovery phrase (12 or 24 words)
```

**IMPORTANT:** 
- Write down the recovery phrase on paper
- Store it in a secure location (safe, safety deposit box)
- NEVER store it digitally
- This phrase can recover your treasury funds

Then set the address:
```bash
export TREASURY_ADDRESS="0xYOUR_NEW_ADDRESS"
npx cdk deploy
```

#### Option 3: Keep Current Setup (Testing Only)

For testnet testing, you can continue using the current default address:
```
0x09e66c87d06058ee3d292bbb6284b2b9ac31bbeab0da5e1f75cec4ddf6e00b52
```

This address is derived from the same mnemonic as invoice addresses (index 0). This is acceptable for testing but **NOT recommended for production**.

### Verifying Your Setup

After deployment, check the treasury address:

```bash
aws cloudformation describe-stacks \
  --stack-name SuiPaymentStack \
  --query 'Stacks[0].Parameters[?ParameterKey==`TreasuryAddress`].ParameterValue' \
  --output text
```

Or check the sweeper Lambda environment variables:

```bash
aws lambda get-function-configuration \
  --function-name $(aws cloudformation describe-stack-resources \
    --stack-name SuiPaymentStack \
    --query 'StackResources[?LogicalResourceId==`Sweeper`].PhysicalResourceId' \
    --output text) \
  --query 'Environment.Variables.TREASURY_ADDRESS' \
  --output text
```

### Monitoring Treasury Balance

Check your treasury balance on SUI testnet:

```bash
curl -s -X POST https://fullnode.testnet.sui.io:443 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"suix_getBalance",
    "params":["YOUR_TREASURY_ADDRESS"]
  }' | jq -r '.result.totalBalance'
```

Or view on the explorer:
```
https://suiscan.xyz/testnet/account/YOUR_TREASURY_ADDRESS
```

### Security Best Practices

1. **Never commit treasury private keys** to git or store in AWS
2. **Use hardware wallets** for mainnet deployments
3. **Test on testnet first** with a separate test wallet
4. **Monitor treasury balance** regularly
5. **Set up CloudWatch alarms** for unusual activity
6. **Rotate invoice mnemonic** periodically (requires migration)
7. **Use multi-sig** for high-value treasuries (future enhancement)

### What's Stored Where

| Component | Location | Purpose | Security Level |
|-----------|----------|---------|----------------|
| Invoice mnemonic | AWS Secrets Manager | Derive invoice addresses | Encrypted at rest |
| Invoice private keys | Derived in Lambda memory | Sign sweep transactions | Ephemeral |
| Treasury address | Lambda environment variable | Destination for sweeps | Public information |
| Treasury private key | Hardware wallet (offline) | Spend from treasury | Maximum security |

### Migration from Current Setup

If you're currently using the default treasury address (index 0) and want to migrate to a hardware wallet:

1. Generate new hardware wallet address
2. Update environment variable:
   ```bash
   export TREASURY_ADDRESS="0xNEW_HARDWARE_WALLET_ADDRESS"
   npx cdk deploy
   ```
3. Manually transfer existing funds from old treasury to new:
   ```bash
   # Use SUI CLI or wallet to send from old address to new
   sui client transfer-sui \
     --to 0xNEW_HARDWARE_WALLET_ADDRESS \
     --amount 1000000000 \
     --gas-budget 10000000
   ```
4. All future sweeps will go to the new hardware wallet address

### Troubleshooting

**Q: Can I change the treasury address after deployment?**  
A: Yes, just update the environment variable and redeploy:
```bash
export TREASURY_ADDRESS="0xNEW_ADDRESS"
npx cdk deploy
```

**Q: What if I lose access to my hardware wallet?**  
A: If you have the recovery phrase, you can restore the wallet on a new device. Without the recovery phrase, funds are permanently lost.

**Q: Can I use a multi-sig wallet as treasury?**  
A: Yes, any valid SUI address works. Multi-sig provides additional security by requiring multiple signatures to spend funds.

**Q: How do I spend from the treasury?**  
A: Use your hardware wallet's interface or the SUI CLI with the recovery phrase. The sweeper only needs the address to send TO the treasury, not to spend FROM it.
