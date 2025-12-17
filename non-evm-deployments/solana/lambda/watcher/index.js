const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAccount, getAssociatedTokenAddress } = require('@solana/spl-token');

const dynamoClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(dynamoClient);
const sns = new SNSClient({});

const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const TABLE = process.env.TABLE;

async function markPaid(invoiceId) {
  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { invoiceId },
      UpdateExpression: 'set #s = :paid, paidAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':paid': 'paid',
        ':now': new Date().toISOString(),
      },
    })
  );
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

  await sns.send(
    new PublishCommand({
      TopicArn: process.env.SNS_TOPIC_ARN,
      Message: messageBody,
      Subject: `Payment Received: Invoice ${invoice.invoiceId}`,
    })
  );
}

exports.handler = async () => {
  const processed = [];
  const failed = [];

  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'status-index',
      KeyConditionExpression: '#s = :pending',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':pending': 'pending' },
    })
  );

  for (const invoice of result.Items) {
    const { invoiceId, address, currency, tokenMint, amount, tokenSymbol } = invoice;

    try {
      if (currency === 'SOL') {
        const publicKey = new PublicKey(address);
        const balance = await connection.getBalance(publicKey);
        const balanceInSol = balance / LAMPORTS_PER_SOL;
        const required = parseFloat(amount);

        if (balanceInSol >= required) {
          await markPaid(invoiceId);
          await notifyMerchant(invoice);
          console.log(`Invoice ${invoiceId} processed successfully`);
          processed.push(invoiceId);
        } else {
          throw new Error(`Insufficient SOL: required ${amount}, got ${balanceInSol}`);
        }
      } else if (currency === 'SPL' && tokenMint) {
        const publicKey = new PublicKey(address);
        const mintPublicKey = new PublicKey(tokenMint);

        const ata = await getAssociatedTokenAddress(mintPublicKey, publicKey);

        try {
          const tokenAccount = await getAccount(connection, ata);
          const balance = Number(tokenAccount.amount);

          // Fetch actual decimals from mint
          const { getMint } = require('@solana/spl-token');
          const mintInfo = await getMint(connection, mintPublicKey);
          const required = parseFloat(amount) * Math.pow(10, mintInfo.decimals);

          if (balance >= required) {
            await markPaid(invoiceId);
            await notifyMerchant(invoice);
            console.log(`Invoice ${invoiceId} processed successfully`);
            processed.push(invoiceId);
          } else {
            throw new Error(
              `Insufficient ${tokenSymbol}: required ${amount}, got ${balance / Math.pow(10, mintInfo.decimals)}`
            );
          }
        } catch (err) {
          if (err.name === 'TokenAccountNotFoundError') {
            console.log(`Token account not yet created for invoice ${invoiceId}`);
          } else {
            throw err;
          }
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
