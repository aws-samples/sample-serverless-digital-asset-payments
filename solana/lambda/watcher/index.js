const AWS = require('aws-sdk');
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAccount, getAssociatedTokenAddress } = require('@solana/spl-token');

const dynamo = new AWS.DynamoDB.DocumentClient();
const sns = new AWS.SNS();

const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const TABLE = process.env.TABLE;

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
          throw new Error(
            `Insufficient SOL: required ${amount}, got ${balanceInSol}`
          );
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
              `Insufficient ${tokenSymbol}: required ${amount}, got ${balance / Math.pow(10, 6)}`
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
