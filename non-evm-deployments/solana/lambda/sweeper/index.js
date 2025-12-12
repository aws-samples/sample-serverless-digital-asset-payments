const AWS = require('aws-sdk');
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  getAccount,
  getAssociatedTokenAddress,
  createTransferInstruction,
} = require('@solana/spl-token');
const { derivePath } = require('ed25519-hd-key');
const { mnemonicToSeedSync } = require('bip39');

const dynamo = new AWS.DynamoDB.DocumentClient();
const secretsManager = new AWS.SecretsManager();
const kms = new AWS.KMS();
const sns = new AWS.SNS();

const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const TREASURY_PUBLIC_KEY = new PublicKey(process.env.SOLANA_TREASURY_PUBLIC_KEY);
const TABLE = process.env.TABLE;
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;
const KMS_KEY_ID = process.env.KMS_KEY_ID;

let hotWalletPublicKey;

async function getHotWalletPublicKey() {
  if (hotWalletPublicKey) {
    return hotWalletPublicKey;
  }

  const { PublicKey: kmsPublicKey } = await kms.getPublicKey({ KeyId: KMS_KEY_ID }).promise();
  const publicKeyBytes = new Uint8Array(kmsPublicKey).slice(-32);
  hotWalletPublicKey = new PublicKey(publicKeyBytes);
  return hotWalletPublicKey;
}

async function signWithKms(message) {
  const { Signature } = await kms
    .sign({
      KeyId: KMS_KEY_ID,
      Message: message,
      MessageType: 'RAW',
      SigningAlgorithm: 'ED25519_SHA_512',
    })
    .promise();
  return new Uint8Array(Signature);
}

async function sendErrorNotification(error, invoiceId) {
  try {
    const logGroupName = '/aws/lambda/SolanaInvoiceStack-SolanaSweeperFunction';
    const functionName = 'SolanaSweeperFunction';

    const messageBody = `
Solana Sweeper Error Alert

The Sweeper process has detected an error while processing invoice ${invoiceId}.

Error Details:
${error.message}

You can refer to the logs in the CloudWatch Log Group:
${logGroupName}

Function Name: ${functionName}
Timestamp: ${new Date().toISOString()}

This error may require manual intervention to ensure funds are properly swept.
        `.trim();

    await sns
      .publish({
        TopicArn: SNS_TOPIC_ARN,
        Message: messageBody,
        Subject: `⚠️ Solana Sweeper Error: Invoice ${invoiceId}`,
      })
      .promise();

    console.log(`Error notification sent for invoice ${invoiceId}`);
  } catch (notificationError) {
    console.error(`Failed to send error notification: ${notificationError.message}`);
  }
}

async function ensureSufficientRent(invoiceKeypair, requiredLamports, invoiceId) {
  const balance = await connection.getBalance(invoiceKeypair.publicKey);

  if (balance < requiredLamports) {
    console.log(
      `Insufficient SOL for rent/fees on invoice ${invoiceId}: ${balance} < ${requiredLamports}`
    );
    const topUpAmount = requiredLamports - balance;
    console.log(`Topping up ${topUpAmount / LAMPORTS_PER_SOL} SOL...`);

    const hotWallet = await getHotWalletPublicKey();
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: hotWallet,
        toPubkey: invoiceKeypair.publicKey,
        lamports: topUpAmount,
      })
    );

    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.feePayer = hotWallet;

    const message = transaction.serializeMessage();
    const signature = await signWithKms(message);
    transaction.addSignature(hotWallet, Buffer.from(signature));

    await connection.sendRawTransaction(transaction.serialize());
    return await connection.getBalance(invoiceKeypair.publicKey);
  }

  return balance;
}

exports.handler = async event => {
  console.log('Fetching secrets from SecretsManager...');

  const mnemonicSecret = await secretsManager
    .getSecretValue({ SecretId: 'solana-wallet-mnemonic' })
    .promise();
  const { mnemonic } = JSON.parse(mnemonicSecret.SecretString);

  let sweptCount = 0;

  for (const record of event.Records) {
    if (record.eventName !== 'MODIFY' && record.eventName !== 'INSERT') {
      console.log('Skipping non-insert/modify event');
      continue;
    }

    const newImage = AWS.DynamoDB.Converter.unmarshall(record.dynamodb.NewImage);

    if (newImage.status !== 'paid') {
      console.log(`Skipping invoice ${newImage.invoiceId} with status ${newImage.status}`);
      continue;
    }

    const { path, currency, tokenMint, invoiceId, tokenSymbol } = newImage;

    const seed = mnemonicToSeedSync(mnemonic);
    const derivedSeed = derivePath(path, seed.toString('hex')).key;
    const invoiceKeypair = Keypair.fromSeed(derivedSeed);

    try {
      console.log(
        `Processing invoice ${invoiceId} | Address: ${invoiceKeypair.publicKey.toBase58()} | Currency: ${currency}`
      );

      if (currency === 'SOL') {
        const balance = await connection.getBalance(invoiceKeypair.publicKey);

        const testTransaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: invoiceKeypair.publicKey,
            toPubkey: TREASURY_PUBLIC_KEY,
            lamports: 1,
          })
        );
        testTransaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        testTransaction.feePayer = invoiceKeypair.publicKey;

        const estimatedFee = await testTransaction.getEstimatedFee(connection);

        if (balance <= estimatedFee) {
          console.log(`Balance too low to sweep for invoice ${invoiceId}`);
          continue;
        }

        const sweepAmount = balance - estimatedFee;

        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: invoiceKeypair.publicKey,
            toPubkey: TREASURY_PUBLIC_KEY,
            lamports: sweepAmount,
          })
        );

        transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        transaction.feePayer = invoiceKeypair.publicKey;
        transaction.sign(invoiceKeypair);

        await connection.sendRawTransaction(transaction.serialize());
        console.log(`Full SOL sweep complete: ${sweepAmount / LAMPORTS_PER_SOL} SOL`);
      } else if (currency === 'SPL' && tokenMint) {
        const mintPublicKey = new PublicKey(tokenMint);
        const sourceAta = await getAssociatedTokenAddress(mintPublicKey, invoiceKeypair.publicKey);
        const destAta = await getAssociatedTokenAddress(mintPublicKey, TREASURY_PUBLIC_KEY);

        const tokenAccount = await getAccount(connection, sourceAta);
        const tokenBalance = tokenAccount.amount;

        if (tokenBalance === 0n) {
          console.log(`No ${tokenSymbol} balance to sweep for invoice ${invoiceId}`);
          continue;
        }

        const rentExemption = await connection.getMinimumBalanceForRentExemption(0);
        await ensureSufficientRent(invoiceKeypair, rentExemption * 2, invoiceId);

        console.log(`Sweeping ${tokenBalance} ${tokenSymbol} to treasury...`);

        const hotWallet = await getHotWalletPublicKey();
        const transaction = new Transaction();

        try {
          await getAccount(connection, destAta);
        } catch (err) {
          const { createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
          console.log(`Creating treasury ATA for ${tokenSymbol}...`);
          transaction.add(
            createAssociatedTokenAccountInstruction(
              hotWallet,
              destAta,
              TREASURY_PUBLIC_KEY,
              mintPublicKey
            )
          );
        }

        transaction.add(
          createTransferInstruction(sourceAta, destAta, invoiceKeypair.publicKey, tokenBalance)
        );

        transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        transaction.feePayer = hotWallet;

        const message = transaction.serializeMessage();
        const hotWalletSig = await signWithKms(message);
        transaction.addSignature(hotWallet, Buffer.from(hotWalletSig));
        transaction.partialSign(invoiceKeypair);

        await connection.sendRawTransaction(transaction.serialize());
        console.log(`SPL token sweep complete for invoice ${invoiceId}`);
      }

      await dynamo
        .update({
          TableName: TABLE,
          Key: { invoiceId },
          UpdateExpression: 'set #s = :swept, sweptAt = :now',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':swept': 'swept',
            ':now': new Date().toISOString(),
          },
        })
        .promise();

      console.log(`Invoice ${invoiceId} marked as swept.`);
      sweptCount++;
    } catch (err) {
      console.error(`Error sweeping invoice ${invoiceId}: ${err.message}`);
      await sendErrorNotification(err, invoiceId);
      throw err;
    }
  }

  console.log(`Sweep process completed. ${sweptCount} wallet(s) swept.`);
  return { sweptCount };
};
