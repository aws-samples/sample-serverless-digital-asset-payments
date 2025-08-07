const AWS = require('aws-sdk');
const { ethers } = require('ethers');

const dynamo = new AWS.DynamoDB.DocumentClient();
const sns = new AWS.SNS();

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

const TABLE = process.env.TABLE;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

async function markPaid(invoiceId) {
  await dynamo
    .update({
      TableName: TABLE,
      Key: { invoiceId },
      UpdateExpression: 'set #s = :paid, paidAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':paid': 'paid',
        ':now': new Date().toISOString(),
      },
    })
    .promise();
}

async function notifyMerchant(invoice) {
  const messageBody = `
Payment Received

Invoice ID: ${invoice.invoiceId}
Amount: ${invoice.amount} ${invoice.tokenSymbol || invoice.currency}
Invoice Public Address: ${invoice.address}
Paid At: ${new Date().toISOString()}

Status: PAID ✅

You may now proceed with order fulfillment.
    `.trim();

  await sns
    .publish({
      TopicArn: process.env.SNS_TOPIC_ARN,
      Message: messageBody,
      Subject: `Payment Received: Invoice ${invoice.invoiceId}`,
    })
    .promise();
}

exports.handler = async () => {
  const processed = [];
  const failed = [];

  const { Items } = await dynamo
    .query({
      TableName: TABLE,
      IndexName: 'status-index',
      KeyConditionExpression: '#s = :pending',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':pending': 'pending' },
    })
    .promise();

  for (const invoice of Items) {
    const { invoiceId, address, currency, tokenAddress, amount, tokenSymbol } = invoice;

    try {
      if (currency === 'ETH') {
        const balance = await provider.getBalance(address);
        const required = ethers.parseEther(amount);

        if (balance >= required) {
          await markPaid(invoiceId);
          await notifyMerchant(invoice);
          console.log(`Invoice ${invoiceId} processed successfully`);
          processed.push(invoiceId);
        } else {
          throw new Error(
            `Insufficient ETH: required ${amount}, got ${ethers.formatEther(balance)}`
          );
        }
      } else if (currency === 'ERC20' && tokenAddress) {
        const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        const [balance, decimals] = await Promise.all([token.balanceOf(address), token.decimals()]);

        const required = ethers.parseUnits(amount, decimals);

        if (balance >= required) {
          await markPaid(invoiceId);
          await notifyMerchant(invoice);
          console.log(`Invoice ${invoiceId} processed successfully`);
          processed.push(invoiceId);
        } else {
          throw new Error(
            `Insufficient ${tokenSymbol}: required ${amount}, got ${ethers.formatUnits(balance, decimals)}`
          );
        }
      }
    } catch (err) {
      console.error(`Error processing invoice ${invoiceId}: ${err.message}`);
      failed.push({ invoiceId, error: err.message });
    }
  }

  console.log(
    `Processing completed: ${processed.length} invoices processed successfully, ${failed.length} invoices failed.`
  );
  return {
    status: 'completed',
    processed,
    failed,
  };
};
