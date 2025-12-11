import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';

dotenv.config({ path: path.join(__dirname, '../.env') });

export class SolanaInvoiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const invoiceTable = new dynamodb.Table(this, 'SolanaInvoices', {
      partitionKey: { name: 'invoiceId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
    });

    invoiceTable.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const counterTable = new dynamodb.Table(this, 'SolanaWalletCounter', {
      partitionKey: { name: 'counterId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const mnemonicSecret = new secretsmanager.Secret(this, 'SolanaWalletMnemonic', {
      secretName: 'solana-wallet-mnemonic',
      description: 'Solana wallet mnemonic for invoice generation',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      secretObjectValue: {},
    });

    const hotPkSecret = new secretsmanager.Secret(this, 'SolanaHotPkSecret', {
      secretName: 'solana-wallet/hot-pk',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      secretObjectValue: {},
    });

    const paymentNotificationTopic = new sns.Topic(this, 'SolanaPaymentNotificationTopic', {
      displayName: 'Solana Payment Notifications',
    });

    paymentNotificationTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowPublishThroughSSLOnly',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['sns:Publish'],
        resources: [paymentNotificationTopic.topicArn],
        conditions: {
          Bool: {
            'aws:SecureTransport': 'false',
          },
        },
      })
    );

    const invoiceFn = new NodejsFunction(this, 'SolanaInvoiceFunction', {
      entry: path.join(__dirname, '../lambda/invoice/index.js'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'SolanaInvoiceFunctionLogGroup', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        TABLE: invoiceTable.tableName,
        COUNTER_TABLE: counterTable.tableName,
      },
    });

    invoiceTable.grantReadWriteData(invoiceFn);
    counterTable.grantReadWriteData(invoiceFn);
    mnemonicSecret.grantRead(invoiceFn);

    const invoiceApi = new apigateway.RestApi(this, 'SolanaInvoiceApi', {
      restApiName: 'Solana Invoice Service',
      description: 'API for generating Solana invoices',
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new logs.LogGroup(this, 'SolanaApiGatewayAccessLogs', {
            retention: logs.RetentionDays.TWO_WEEKS,
          })
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
      },
    });

    const apiKey = new apigateway.ApiKey(this, 'SolanaInvoiceApiKey', {
      apiKeyName: 'SolanaInvoiceApiKey',
      description: 'API Key for Solana Invoice Service',
    });

    const usagePlan = new apigateway.UsagePlan(this, 'SolanaInvoiceUsagePlan', {
      name: 'SolanaInvoiceUsagePlan',
      throttle: {
        rateLimit: 100,
        burstLimit: 200,
      },
      quota: {
        limit: 10000,
        period: apigateway.Period.MONTH,
      },
    });

    usagePlan.addApiStage({
      stage: invoiceApi.deploymentStage,
    });

    usagePlan.addApiKey(apiKey);

    const invoiceResource = invoiceApi.root.addResource('generateInvoice');
    invoiceResource.addMethod('POST', new apigateway.LambdaIntegration(invoiceFn), {
      apiKeyRequired: true,
    });

    const invoiceManagementFn = new NodejsFunction(this, 'SolanaInvoiceManagementFunction', {
      entry: path.join(__dirname, '../lambda/invoice-management/index.js'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'SolanaInvoiceManagementFunctionLogGroup', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        TABLE: invoiceTable.tableName,
      },
    });

    invoiceTable.grantReadWriteData(invoiceManagementFn);

    const invoicesResource = invoiceApi.root.addResource('invoices');
    invoicesResource.addMethod('GET', new apigateway.LambdaIntegration(invoiceManagementFn), {
      apiKeyRequired: true,
    });

    const invoiceIdResource = invoicesResource.addResource('{invoiceId}');
    invoiceIdResource.addMethod('GET', new apigateway.LambdaIntegration(invoiceManagementFn), {
      apiKeyRequired: true,
    });
    invoiceIdResource.addMethod('PUT', new apigateway.LambdaIntegration(invoiceManagementFn), {
      apiKeyRequired: true,
    });
    invoiceIdResource.addMethod('DELETE', new apigateway.LambdaIntegration(invoiceManagementFn), {
      apiKeyRequired: true,
    });

    const rpcUrl = process.env.SOLANA_RPC_URL;
    if (!rpcUrl) {
      throw new Error('Missing SOLANA_RPC_URL environment variable');
    }

    const watcherFn = new NodejsFunction(this, 'SolanaWatcherFunction', {
      entry: path.join(__dirname, '../lambda/watcher/index.js'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'SolanaWatcherFunctionLogGroup', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        TABLE: invoiceTable.tableName,
        SOLANA_RPC_URL: rpcUrl,
        SNS_TOPIC_ARN: paymentNotificationTopic.topicArn,
      },
    });

    invoiceTable.grantReadWriteData(watcherFn);
    paymentNotificationTopic.grantPublish(watcherFn);

    new events.Rule(this, 'SolanaWatcherScheduleRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(watcherFn)],
    });

    const treasuryPublicKey = process.env.SOLANA_TREASURY_PUBLIC_KEY;
    if (!treasuryPublicKey) {
      throw new Error('Missing SOLANA_TREASURY_PUBLIC_KEY environment variable');
    }

    const sweeperFn = new NodejsFunction(this, 'SolanaSweeperFunction', {
      entry: path.join(__dirname, '../lambda/sweeper/index.js'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.minutes(15),
      reservedConcurrentExecutions: 1,
      logGroup: new logs.LogGroup(this, 'SolanaSweeperFunctionLogGroup', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        TABLE: invoiceTable.tableName,
        SOLANA_TREASURY_PUBLIC_KEY: treasuryPublicKey,
        SOLANA_RPC_URL: rpcUrl,
        SNS_TOPIC_ARN: paymentNotificationTopic.topicArn,
      },
    });

    invoiceTable.grantReadWriteData(sweeperFn);
    mnemonicSecret.grantRead(sweeperFn);
    hotPkSecret.grantRead(sweeperFn);
    paymentNotificationTopic.grantPublish(sweeperFn);

    sweeperFn.addEventSource(
      new eventsources.DynamoEventSource(invoiceTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 1,
        retryAttempts: 3,
        parallelizationFactor: 1,
        reportBatchItemFailures: true,
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual('MODIFY'),
            dynamodb: {
              NewImage: {
                status: { S: lambda.FilterRule.isEqual('paid') },
              },
            },
          }),
        ],
      })
    );

    mnemonicSecret.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'RestrictMnemonicSecretAccess',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['secretsmanager:GetSecretValue'],
        resources: ['*'],
        conditions: {
          ArnNotEquals: {
            'aws:PrincipalArn': [
              invoiceFn.role?.roleArn || '',
              sweeperFn.role?.roleArn || '',
            ].filter(arn => arn !== ''),
          },
        },
      })
    );

    hotPkSecret.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'RestrictHotPkSecretAccess',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['secretsmanager:GetSecretValue'],
        resources: ['*'],
        conditions: {
          ArnNotEquals: {
            'aws:PrincipalArn': [sweeperFn.role?.roleArn || ''].filter(arn => arn !== ''),
          },
        },
      })
    );

    new cdk.CfnOutput(this, 'SolanaInvoiceFunctionName', { value: invoiceFn.functionName });
    new cdk.CfnOutput(this, 'SolanaInvoiceManagementFunctionName', {
      value: invoiceManagementFn.functionName,
    });
    new cdk.CfnOutput(this, 'SolanaWatcherFunctionName', { value: watcherFn.functionName });
    new cdk.CfnOutput(this, 'SolanaSweeperFunctionName', { value: sweeperFn.functionName });
    new cdk.CfnOutput(this, 'SolanaWalletSeedSecretName', { value: mnemonicSecret.secretName });
    new cdk.CfnOutput(this, 'SolanaWalletHotPkSecretName', { value: hotPkSecret.secretName });
    new cdk.CfnOutput(this, 'SolanaPaymentNotificationTopicArn', {
      value: paymentNotificationTopic.topicArn,
    });
    new cdk.CfnOutput(this, 'SolanaInvoiceApiUrl', { value: invoiceApi.url + 'generateInvoice' });
    new cdk.CfnOutput(this, 'SolanaInvoiceApiBaseUrl', { value: invoiceApi.url });
    new cdk.CfnOutput(this, 'SolanaInvoiceApiKeyId', { value: apiKey.keyId });

    this.addNagSuppressions();
  }

  private addNagSuppressions() {
    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWS managed policies provide secure baseline for Lambda execution',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs',
          ],
        },
      ],
      true
    );

    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'DynamoDB GSI access requires wildcard permissions for index operations',
          appliesTo: ['Resource::<SolanaInvoices*.Arn>/index/*', 'Resource::*'],
        },
      ],
      true
    );

    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-APIG2',
          reason: 'Request validation handled by Lambda functions with proper error handling',
        },
      ],
      true
    );

    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-APIG3',
          reason: 'WAF not required for Solana invoice API',
        },
      ],
      true
    );

    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-DDB3',
          reason: 'Point-in-time recovery not required for invoice data',
        },
      ],
      true
    );

    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-SMG4',
          reason: 'Automatic rotation of seed in SecretsManager should be avoided',
        },
      ],
      true
    );

    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-APIG4',
          reason: 'API Gateway has API Key - sufficient for POC',
        },
      ],
      true
    );

    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-COG4',
          reason: 'API Gateway Cognito user pool not required for POC',
        },
      ],
      true
    );
  }
}
