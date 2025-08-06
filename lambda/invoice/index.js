const AWS = require('aws-sdk');
const { ethers } = require('ethers');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');

const secretsManager = new AWS.SecretsManager();
const dynamo = new AWS.DynamoDB.DocumentClient();

const TABLE = process.env.TABLE;
const COUNTER_TABLE = process.env.COUNTER_TABLE;
const COUNTER_KEY = { counterId: 'hd-index' };

exports.handler = async event => {
  console.log('Event: ' + JSON.stringify(event, null, 2));

  let body;
  if (event.body) {
    body = JSON.parse(event.body);
  } else {
    body = event; // fallback for direct Lambda invocation
  }
  console.log('Fetching mnemonic from SecretsManager...');
  const secret = await secretsManager.getSecretValue({ SecretId: 'hd-wallet-mnemonic' }).promise();
  const { mnemonic } = JSON.parse(secret.SecretString);
  console.log('Mnemonic successfully retrieved.');

  console.log('Incrementing HD wallet index...');
  const counterResult = await dynamo
    .update({
      TableName: COUNTER_TABLE,
      Key: COUNTER_KEY,
      UpdateExpression: 'SET currentIndex = if_not_exists(currentIndex, :start) + :inc',
      ExpressionAttributeValues: {
        ':start': 0,
        ':inc': 1,
      },
      ReturnValues: 'UPDATED_NEW',
    })
    .promise();

  const index = counterResult.Attributes.currentIndex;
  const path = `m/44'/60'/0'/0/${index}`;
  console.log(`Derived path: ${path}`);

  const hdNode = ethers.HDNodeWallet.fromPhrase(mnemonic, path);
  console.log(`Generated address: ${hdNode.address}`);

  const invoiceId = uuidv4();
  const currency = body.currency || 'ETH';
  const tokenAddress = body.tokenAddress || null;
  const tokenSymbol = body.tokenSymbol || (currency === 'ETH' ? 'ETH' : 'USDC');
  const amount = body.amount || '0.0001';
  const decimals = parseInt(body.decimals || (currency === 'ETH' ? 18 : 6), 10); // Default to 18 for ETH, 6 for USDC

  const item = {
    invoiceId,
    address: hdNode.address,
    path,
    currency,
    tokenAddress,
    tokenSymbol,
    amount,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  console.log(`Storing invoice: ${JSON.stringify(item, null, 2)}`);

  await dynamo
    .put({
      TableName: TABLE,
      Item: item,
    })
    .promise();

  console.log(`Invoice ${invoiceId} created successfully.`);

  let paymentUri;

  if (currency.toUpperCase() === 'ETH') {
    const valueInWei = BigInt(Math.floor(amount * 10 ** 18));
    paymentUri = `ethereum:${hdNode.address}?value=${valueInWei}`;
  } else if (currency.toUpperCase() === 'ERC20') {
    const valueInBaseUnits = BigInt(Math.floor(amount * 10 ** decimals));
    paymentUri = `ethereum:${tokenAddress}/transfer?address=${hdNode.address}&uint256=${valueInBaseUnits}`;
  } else {
    throw new Error("Unsupported currency type. Use 'ETH' or 'ERC20'.");
  }
  const qrcodeBase64 = await QRCode.toDataURL(paymentUri);

  console.log(`QR Code generated for invoice.`);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      invoiceId,
      address: hdNode.address,
      index,
      qrcodeBase64,
    }),
  };
};
