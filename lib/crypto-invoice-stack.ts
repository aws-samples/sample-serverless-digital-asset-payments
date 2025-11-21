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
import { NagSuppressions } from 'cdk-nag';

dotenv.config();

export class CryptoInvoiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const invoiceTable = new dynamodb.Table(this, 'CryptoInvoices', {
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

    const counterTable = new dynamodb.Table(this, 'HdWalletCounter', {
      partitionKey: { name: 'counterId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const mnemonicSecret = new secretsmanager.Secret(this, 'HdWalletMnemonic', {
      secretName: 'hd-wallet-mnemonic',
      description: 'HD wallet mnemonic for invoice generation',
      removalPolicy: cdk.RemovalPolicy.DESTROY, // (better to retain important secrets)
      secretObjectValue: {},
    });

    const hotPkSecret = new secretsmanager.Secret(this, 'WalletHotPkSecret', {
      secretName: 'wallet/hot-pk',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      secretObjectValue: {},
    });

    const paymentNotificationTopic = new sns.Topic(this, 'PaymentNotificationTopic', {
      displayName: 'Merchant Payment Notifications',
    });

    // Enforce HTTPS for SNS topic
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

    // Lambda function for generating invoices
    const invoiceFn = new NodejsFunction(this, 'InvoiceFunction', {
      entry: 'lambda/invoice/index.js',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'InvoiceFunctionLogGroup', {
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

    const invoiceApi = new apigateway.RestApi(this, 'InvoiceApi', {
      restApiName: 'Invoice Service',
      description: 'API for generating crypto invoices',
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new logs.LogGroup(this, 'ApiGatewayAccessLogs', {
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

    // Create API Key for secure access
    const apiKey = new apigateway.ApiKey(this, 'InvoiceApiKey', {
      apiKeyName: 'CryptoInvoiceApiKey',
      description: 'API Key for Crypto Invoice Service',
    });

    // Create usage plan
    const usagePlan = new apigateway.UsagePlan(this, 'InvoiceUsagePlan', {
      name: 'CryptoInvoiceUsagePlan',
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

    // Invoice Management Lambda function for invoice operations
    const invoiceManagementFn = new NodejsFunction(this, 'InvoiceManagementFunction', {
      entry: 'lambda/invoice-management/index.js',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'InvoiceManagementFunctionLogGroup', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        TABLE: invoiceTable.tableName,
      },
    });

    invoiceTable.grantReadWriteData(invoiceManagementFn);

    // API Gateway routes for invoice management operations
    const invoicesResource = invoiceApi.root.addResource('invoices');

    // GET /invoices - Get all invoices (with optional status filter)
    invoicesResource.addMethod('GET', new apigateway.LambdaIntegration(invoiceManagementFn), {
      apiKeyRequired: true,
    });

    // Individual invoice operations
    const invoiceIdResource = invoicesResource.addResource('{invoiceId}');

    // GET /invoices/{invoiceId} - Get specific invoice
    invoiceIdResource.addMethod('GET', new apigateway.LambdaIntegration(invoiceManagementFn), {
      apiKeyRequired: true,
    });

    // PUT /invoices/{invoiceId} - Update invoice status
    invoiceIdResource.addMethod('PUT', new apigateway.LambdaIntegration(invoiceManagementFn), {
      apiKeyRequired: true,
    });

    // DELETE /invoices/{invoiceId} - Delete invoice (only if pending)
    invoiceIdResource.addMethod('DELETE', new apigateway.LambdaIntegration(invoiceManagementFn), {
      apiKeyRequired: true,
    });

    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) {
      throw new Error('Missing RPC_URL environment variable');
    }

    // Watcher Lambda
    const watcherFn = new NodejsFunction(this, 'WatcherFunction', {
      entry: 'lambda/watcher/index.js',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'WatcherFunctionLogGroup', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        TABLE: invoiceTable.tableName,
        RPC_URL: rpcUrl,
        SNS_TOPIC_ARN: paymentNotificationTopic.topicArn,
      },
    });

    invoiceTable.grantReadWriteData(watcherFn);
    paymentNotificationTopic.grantPublish(watcherFn);

    new events.Rule(this, 'WatcherScheduleRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(watcherFn)],
    });

    const treasuryPublicAddress = process.env.TREASURY_PUBLIC_ADDRESS;
    if (!treasuryPublicAddress) {
      throw new Error('Missing TREASURY_PUBLIC_ADDRESS environment variable');
    }

    // Sweeper Lambda
    const sweeperFn = new NodejsFunction(this, 'SweeperFunction', {
      entry: 'lambda/sweeper/index.js',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.minutes(15),
      reservedConcurrentExecutions: 1,
      logGroup: new logs.LogGroup(this, 'SweeperFunctionLogGroup', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        TABLE: invoiceTable.tableName,
        TREASURY_PUBLIC_ADDRESS: treasuryPublicAddress,
        RPC_URL: rpcUrl,
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

    // Lock down mnemonicSecret
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

    // Lock down hotPkSecret
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

    new cdk.CfnOutput(this, 'InvoiceFunctionName', { value: invoiceFn.functionName });
    new cdk.CfnOutput(this, 'InvoiceManagementFunctionName', {
      value: invoiceManagementFn.functionName,
    });
    new cdk.CfnOutput(this, 'WatcherFunctionName', { value: watcherFn.functionName });
    new cdk.CfnOutput(this, 'SweeperFunctionName', { value: sweeperFn.functionName });
    new cdk.CfnOutput(this, 'WalletSeedSecretName', { value: mnemonicSecret.secretName });
    new cdk.CfnOutput(this, 'WalletHotPkSecretName', { value: hotPkSecret.secretName });
    new cdk.CfnOutput(this, 'PaymentNotificationTopicArn', {
      value: paymentNotificationTopic.topicArn,
    });
    new cdk.CfnOutput(this, 'InvoiceApiUrl', { value: invoiceApi.url + 'generateInvoice' });
    new cdk.CfnOutput(this, 'InvoiceApiBaseUrl', { value: invoiceApi.url });
    new cdk.CfnOutput(this, 'InvoiceApiKeyId', { value: apiKey.keyId });

    // CDK Nag suppressions for acceptable security risks
    this.addNagSuppressions();
  }

  private addNagSuppressions() {
    // AWS managed policies - acceptable for Lambda basic execution
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

    // DynamoDB wildcard permissions - required for GSI access
    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'DynamoDB GSI access requires wildcard permissions for index operations',
          appliesTo: ['Resource::<CryptoInvoices8362F00B.Arn>/index/*', 'Resource::*'],
        },
      ],
      true
    );

    // API Gateway request validation - handled at Lambda level
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

    // WAF not required for this use case
    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-APIG3',
          reason: 'WAF not required for crypto invoice API',
        },
      ],
      true
    );

    // DynamoDB point-in-time recovery not required
    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-DDB3',
          reason: 'Point-in-time recovery not required for invoice data - can be regenerated',
        },
      ],
      true
    );
    // The secret does not have automatic rotation scheduled.
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
    // The secret does not have automatic rotation scheduled.
    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-SMG4',
          reason: 'Automatic rotation of hot private key in SecretsManager should be avoided',
        },
      ],
      true
    );
    // API Gateway Authorization
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
    // API Gateway Cognito User Pool
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
