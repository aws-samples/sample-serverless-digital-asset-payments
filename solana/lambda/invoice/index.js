const AWS = require('aws-sdk');
const { Keypair } = require('@solana/web3.js');
const { derivePath } = require('ed25519-hd-key');
const { mnemonicToSeedSync } = require('bip39');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');

const secretsManager = new AWS.SecretsManager();
const dynamo = new AWS.DynamoDB.DocumentClient();

const TABLE = process.env.TABLE;
const COUNTER_TABLE = process.env.COUNTER_TABLE;
const COUNTER_KEY = { counterId: 'solana-index' };

exports.handler = async event => {
  console.log('Event: ' + JSON.stringify(event, null, 2));

  let body;
  if (event.body) {
    body = JSON.parse(event.body);
  } else {
    body = event;
  }

  console.log('Fetching mnemonic from SecretsManager...');
  const secret = await secretsManager
    .getSecretValue({ SecretId: 'solana-wallet-mnemonic' })
    .promise();
  const { mnemonic } = JSON.parse(secret.SecretString);
  console.log('Mnemonic successfully retrieved.');

  console.log('Incrementing Solana wallet index...');
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
  const path = `m/44'/501'/${index}'/0'`;
  console.log(`Derived path: ${path}`);

  const seed = mnemonicToSeedSync(mnemonic);
  const derivedSeed = derivePath(path, seed.toString('hex')).key;
  const keypair = Keypair.fromSeed(derivedSeed);
  const publicKey = keypair.publicKey.toBase58();

  console.log(`Generated address: ${publicKey}`);

  const invoiceId = uuidv4();
  const currency = body.currency || 'SOL';
  const tokenMint = body.tokenMint || null;
  const tokenSymbol = body.tokenSymbol || (currency === 'SOL' ? 'SOL' : 'USDC');
  const amount = body.amount || '0.01';

  const item = {
    invoiceId,
    address: publicKey,
    path,
    currency,
    tokenMint,
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
  if (currency.toUpperCase() === 'SOL') {
    paymentUri = `solana:${publicKey}?amount=${amount}&label=Invoice%20${invoiceId}`;
  } else if (currency.toUpperCase() === 'SPL') {
    paymentUri = `solana:${publicKey}?amount=${amount}&spl-token=${tokenMint}&label=Invoice%20${invoiceId}`;
  } else {
    throw new Error("Unsupported currency type. Use 'SOL' or 'SPL'.");
  }

  const qrcodeBase64 = await QRCode.toDataURL(paymentUri);
  console.log(`QR Code generated for invoice.`);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      invoiceId,
      address: publicKey,
      index,
      qrcodeBase64,
    }),
  };
};
