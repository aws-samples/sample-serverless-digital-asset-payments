# Monitoring & Alerts Setup

## What We Built

### 1. SNS Topics
- **PaymentNotifications** - General payment events (already existed)
- **PaymentAlerts** - Critical failures requiring action (NEW)

### 2. CloudWatch Alarms
- **SweeperErrorAlarm** - Triggers on any sweeper Lambda error
- **WatcherErrorAlarm** - Triggers on 3+ watcher errors in 5 minutes
- **GeneratorErrorAlarm** - Triggers on 5+ invoice generator errors in 5 minutes
- **SweeperDurationAlarm** - Triggers when sweeps take >4 minutes (stuck transactions)
- **FailedSweepsAlarm** - Triggers on any failed sweep (after max retries)

### 3. CloudWatch Dashboard
**Name:** SUI-Payment-Agent  
**URL:** https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=SUI-Payment-Agent

**Widgets:**
- Lambda invocations (all 3 functions)
- Lambda errors (all 3 functions)
- Lambda duration/performance
- Sweeper success rate (last hour)
- DynamoDB read/write capacity
- DynamoDB throttles and errors
- Invoice lifecycle metrics (created → paid → swept → failed)

### 4. Custom Metrics
Published to CloudWatch namespace `SUIPayment`:
- **InvoicesCreated** - Count of new invoices
- **PaymentsDetected** - Count of payments detected by watcher
- **SweepsSuccessful** - Count of successful fund sweeps
- **SweepsFailed** - Count of failed sweeps (after max retries)

### 5. SNS Alert on Failed Invoices
Sweeper now publishes detailed alert when invoice fails after max retries:
```
🚨 SUI Payment Alert - Invoice Failed

Invoice ID: abc-123
Recipient Address: 0x...
Amount: 500000000 MIST
Attempts: 3/3
Last Error: Transaction execution failed: insufficient gas
Status: failed

Action Required: Manual investigation needed.
```

## Deployment

### Quick Deploy (Recommended)

```bash
# Optional: Set alert email for notifications
export ALERT_EMAIL="your-email@example.com"

# Run deployment script
./deploy-monitoring.sh
```

This script will:
1. Validate AWS credentials
2. Build sweeper Lambda with monitoring code
3. Deploy infrastructure (SNS topics, alarms, dashboard)
4. Update Lambda function code
5. Display dashboard URL and subscription instructions

### Manual Deployment

#### 1. Set Alert Email (Optional)
```bash
export ALERT_EMAIL="your-email@example.com"
```

### 2. Refresh AWS Credentials
Get new temporary credentials from Isengard and update `~/.aws/credentials`

### 3. Build Sweeper
```bash
cd /Users/rwricard/sui-payment-agent
cargo lambda build --release --arm64 --package sweeper
```

### 4. Deploy Infrastructure
```bash
npx cdk deploy --require-approval never
```

This will:
- Create new alert SNS topic
- Add CloudWatch alarms
- Update sweeper with SNS permissions
- Subscribe email to alerts (if ALERT_EMAIL set)

### 5. Update Sweeper Lambda
```bash
cd target/lambda/bootstrap
rm -f bootstrap.zip && zip -q bootstrap.zip bootstrap
aws lambda update-function-code \
  --function-name SuiPaymentStack-Sweeper30B1A830-EOAdpRODHgoI \
  --zip-file fileb://bootstrap.zip \
  --region us-east-1
```

## Testing Alerts

### Test Failed Invoice Alert
```bash
# Create invoice that will fail (invalid amount)
aws dynamodb put-item \
  --table-name SuiInvoices \
  --item '{
    "invoice_id": {"S": "test-fail-001"},
    "status": {"S": "paid"},
    "retry_count": {"N": "3"},
    "recipient_address": {"S": "0x123"},
    "amount": {"N": "0"},
    "wallet_index": {"N": "999"},
    "last_error": {"S": "Test failure"}
  }' \
  --region us-east-1
```

Should trigger SNS alert within seconds.

### Test Lambda Error Alarm
```bash
# Force sweeper error by updating with invalid data
aws dynamodb update-item \
  --table-name SuiInvoices \
  --key '{"invoice_id": {"S": "test-error-001"}}' \
  --update-expression "SET #s = :status" \
  --expression-attribute-names '{"#s": "status"}' \
  --expression-attribute-values '{":status": {"S": "paid"}}' \
  --region us-east-1
```

Should trigger CloudWatch alarm after Lambda fails.

## Subscribing to Alerts

### Via AWS Console
1. Go to SNS → Topics
2. Find "PaymentAlerts" topic
3. Create subscription → Email
4. Confirm subscription via email

### Via CLI
```bash
ALERT_TOPIC_ARN=$(aws cloudformation describe-stacks \
  --stack-name SuiPaymentStack \
  --query 'Stacks[0].Outputs[?OutputKey==`AlertTopicArn`].OutputValue' \
  --output text \
  --region us-east-1)

aws sns subscribe \
  --topic-arn $ALERT_TOPIC_ARN \
  --protocol email \
  --notification-endpoint your-email@example.com \
  --region us-east-1
```

## Viewing Metrics

### CloudWatch Console
1. Go to CloudWatch → Alarms
2. See all configured alarms and their states
3. Click alarm to see metric history

### CLI
```bash
# List all alarms
aws cloudwatch describe-alarms --region us-east-1

# Get alarm state
aws cloudwatch describe-alarms \
  --alarm-names SuiPaymentStack-SweeperErrorAlarm \
  --region us-east-1
```

## What's Next

### Additional Metrics to Track
- Invoice creation rate
- Payment detection latency
- Sweep success rate
- Average gas costs
- Failed invoice count by error type

### Dashboard
Create CloudWatch dashboard with:
- Invoice counts by status (pending/paid/swept/failed)
- Lambda invocation counts and errors
- Sweep latency (time from payment to sweep)
- Gas cost trends

### Advanced Alerting
- Slack integration via SNS → Lambda → Slack webhook
- PagerDuty integration for on-call rotation
- Anomaly detection for unusual patterns
