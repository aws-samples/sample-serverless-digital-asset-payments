const { ethers } = require('ethers');
const AWS = require('aws-sdk');

const dynamo = new AWS.DynamoDB.DocumentClient();
const secretsManager = new AWS.SecretsManager();
const sns = new AWS.SNS();
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

const DEPOSIT_WALLET_ADDRESS = process.env.TREASURY_PUBLIC_ADDRESS;
const TABLE = process.env.TABLE;
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;

const ERC20_ABI = [
  'function transfer(address to, uint256 value) public returns (bool)',
  'function decimals() public view returns (uint8)',
  'function balanceOf(address owner) public view returns (uint256)',
];

function addGasBuffer(estimatedGas, bufferPercent = 10n) {
  return (estimatedGas * (100n + bufferPercent)) / 100n;
}

async function sendErrorNotification(error, invoiceId) {
  try {
    // Hardcoded log group name based on CDK stack definition
    const logGroupName = '/aws/lambda/CryptoInvoiceStack-SweeperFunction';
    const functionName = 'SweeperFunction';

    const messageBody = `
Sweeper Error Alert

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
        Subject: `⚠️ Sweeper Error: Invoice ${invoiceId}`,
      })
      .promise();

    console.log(`Error notification sent for invoice ${invoiceId}`);
  } catch (notificationError) {
    console.error(`Failed to send error notification: ${notificationError.message}`);
  }
}

async function ensureSufficientGas(
  userWallet,
  hotWallet,
  estimatedFee,
  gasPrice,
  invoiceId,
  currency
) {
  let ethBalance = await provider.getBalance(userWallet.address);

  if (ethBalance < estimatedFee) {
    console.log(
      `Insufficient ETH to cover gas for ${currency} invoice ${invoiceId}: ${ethBalance} < ${estimatedFee}`
    );
    const topUpAmount = estimatedFee - ethBalance;
    const bufferedGasPrice = (gasPrice * 120n) / 100n; // 20% buffer
    console.log(`Topping up ${ethers.formatEther(topUpAmount)} ETH for ${currency} sweep...`);

    const topUpTx = await hotWallet.sendTransaction({
      to: userWallet.address,
      value: topUpAmount,
      gasPrice: bufferedGasPrice,
    });
    await topUpTx.wait();

    ethBalance = await provider.getBalance(userWallet.address);
  }

  return ethBalance;
}

exports.handler = async event => {
  console.log('Fetching secrets from SecretsManager...');

  const mnemonicSecret = await secretsManager
    .getSecretValue({ SecretId: 'hd-wallet-mnemonic' })
    .promise();
  const { mnemonic } = JSON.parse(mnemonicSecret.SecretString);

  const pkSecret = await secretsManager.getSecretValue({ SecretId: 'wallet/hot-pk' }).promise();
  const { pk } = JSON.parse(pkSecret.SecretString);

  const hotWallet = new ethers.Wallet(pk, provider);

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

    const { path, currency, tokenAddress, invoiceId, tokenSymbol } = newImage;
    const userWallet = ethers.HDNodeWallet.fromPhrase(mnemonic, path).connect(provider);

    try {
      console.log(
        `Processing invoice ${invoiceId} | Address: ${userWallet.address} | Currency: ${currency}`
      );

      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice || ethers.parseUnits('10', 'gwei');

      let estimatedGas, estimatedFee;

      if (currency === 'ETH') {
        const txRequest = {
          to: DEPOSIT_WALLET_ADDRESS,
          value: 0n,
        };

        estimatedGas = await provider.estimateGas({ ...txRequest, from: userWallet.address });
        estimatedGas = addGasBuffer(estimatedGas);
        estimatedFee = estimatedGas * gasPrice;

        const ethBalance = await ensureSufficientGas(
          userWallet,
          hotWallet,
          estimatedFee,
          gasPrice,
          invoiceId,
          'ETH'
        );

        const sweepAmount = ethBalance - estimatedFee;

        const tx = await userWallet.sendTransaction({
          to: DEPOSIT_WALLET_ADDRESS,
          value: sweepAmount,
          gasLimit: estimatedGas,
          gasPrice,
        });

        await tx.wait();
        console.log(`Full ETH sweep complete: ${ethers.formatEther(sweepAmount)} ETH`);
      } else {
        const token = new ethers.Contract(tokenAddress, ERC20_ABI, userWallet);
        const tokenBalance = await token.balanceOf(userWallet.address);

        if (tokenBalance === 0n) {
          console.log(`No ${tokenSymbol} balance to sweep for invoice ${invoiceId}`);
          continue;
        }

        const txRequest = await token
          .getFunction('transfer')
          .populateTransaction(DEPOSIT_WALLET_ADDRESS, tokenBalance);
        estimatedGas = await provider.estimateGas({ ...txRequest, from: userWallet.address });
        estimatedGas = addGasBuffer(estimatedGas);
        estimatedFee = estimatedGas * gasPrice;

        await ensureSufficientGas(
          userWallet,
          hotWallet,
          estimatedFee,
          gasPrice,
          invoiceId,
          'ERC-20'
        );

        const decimals = await token.decimals();
        console.log(
          `Sweeping ${ethers.formatUnits(tokenBalance, decimals)} ${tokenSymbol} to treasury...`
        );
        const tx = await token.transfer(DEPOSIT_WALLET_ADDRESS, tokenBalance, {
          gasLimit: estimatedGas,
          gasPrice,
        });
        await tx.wait();

        console.log(`ERC-20 sweep complete for invoice ${invoiceId}`);
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
    }
  }

  console.log(`Sweep process completed. ${sweptCount} wallet(s) swept.`);
  return { sweptCount };
};
