import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';

import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

export class SuiPaymentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB Tables
    const invoiceTable = new dynamodb.Table(this, 'SuiInvoices', {
      tableName: 'SuiInvoices',
      partitionKey: { name: 'invoice_id', type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    invoiceTable.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
    });

    const counterTable = new dynamodb.Table(this, 'SuiWalletCounter', {
      tableName: 'SuiWalletCounter',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Secret created by CDK; populated by npm run setup-secrets after deployment
    const mnemonicSecret = new secretsmanager.Secret(this, 'SuiMnemonic', {
      secretName: 'sui-payment-mnemonic',
      description: 'SUI wallet mnemonic for invoice address derivation',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      secretObjectValue: {},
    });

    // Ed25519 KMS hot wallet key used to sponsor gas fees for token sweeps.
    // keySpec ECC_NIST_EDWARDS25519 requires CfnKey (L1) — the L2 kms.Key
    // construct does not yet expose this key spec.
    const signingKeyCfn = new cdk.aws_kms.CfnKey(this, 'InvoiceSigningKey', {
      description: 'Ed25519 KMS key for SUI transaction signing',
      keySpec: 'ECC_NIST_EDWARDS25519',
      keyUsage: 'SIGN_VERIFY',
    });
    signingKeyCfn.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // SNS Topic for notifications
    const notificationTopic = new sns.Topic(this, 'PaymentNotifications', {
      displayName: 'SUI Payment Notifications',
    });

    // Enforce SSL-only for SNS
    notificationTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowPublishThroughSSLOnly',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['sns:Publish'],
        resources: [notificationTopic.topicArn],
        conditions: {
          Bool: {
            'aws:SecureTransport': 'false',
          },
        },
      })
    );

    // Alert topic for critical failures
    const alertTopic = new sns.Topic(this, 'PaymentAlerts', {
      displayName: 'SUI Payment Critical Alerts',
    });

    // Enforce SSL-only for alert topic
    alertTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowPublishThroughSSLOnly',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['sns:Publish'],
        resources: [alertTopic.topicArn],
        conditions: {
          Bool: {
            'aws:SecureTransport': 'false',
          },
        },
      })
    );

    // Add email subscription (optional - set via environment variable)
    const alertEmail = process.env.ALERT_EMAIL;
    if (alertEmail) {
      alertTopic.addSubscription(new snsSubscriptions.EmailSubscription(alertEmail));
    }

    // Invoice Generator Lambda
    const invoiceGenerator = new lambda.Function(this, 'InvoiceGenerator', {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: 'bootstrap',
      code: lambda.Code.fromAsset('./target/lambda/invoice-generator'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logRetention: 14, // 2 weeks
    });

    invoiceTable.grantReadWriteData(invoiceGenerator);
    counterTable.grantReadWriteData(invoiceGenerator);
    mnemonicSecret.grantRead(invoiceGenerator);

    // API Gateway
    const logGroup = new logs.LogGroup(this, 'ApiGatewayAccessLogs', {
      logGroupName: '/aws/apigateway/sui-payment-api',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const api = new apigateway.RestApi(this, 'SuiPaymentApi', {
      restApiName: 'SUI Payment Service',
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    // Request validation models
    const createInvoiceModel = api.addModel('CreateInvoiceModel', {
      contentType: 'application/json',
      modelName: 'CreateInvoiceModel',
      description: 'Create invoice – amount in human-readable units',
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        required: ['amount', 'reference_id', 'expiry_seconds'],
        properties: {
          amount: {
            type: apigateway.JsonSchemaType.NUMBER,
          },
          reference_id: {
            type: apigateway.JsonSchemaType.STRING,
            minLength: 1,
            maxLength: 256,
          },
          expiry_seconds: {
            type: apigateway.JsonSchemaType.INTEGER,
            minimum: 60,
            maximum: 86400, // 24 hours max
          },
        },
      },
    });

    const updateInvoiceModel = api.addModel('UpdateInvoiceModel', {
      contentType: 'application/json',
      modelName: 'UpdateInvoiceModel',
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        required: ['status'],
        properties: {
          status: {
            type: apigateway.JsonSchemaType.STRING,
            enum: ['cancelled'],
          },
        },
      },
    });

    const requestValidator = api.addRequestValidator('RequestValidator', {
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    const invoiceResource = api.root.addResource('create-invoice');
    invoiceResource.addMethod('POST', new apigateway.LambdaIntegration(invoiceGenerator), {
      apiKeyRequired: true,
      requestValidator: requestValidator,
      requestModels: {
        'application/json': createInvoiceModel,
      },
    });

    // Invoice Manager Lambda
    const invoiceManager = new lambda.Function(this, 'InvoiceManager', {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: 'bootstrap',
      code: lambda.Code.fromAsset('./target/lambda/invoice-manager'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logRetention: 14,
    });

    invoiceTable.grantReadWriteData(invoiceManager);

    // Invoice management endpoints
    const invoicesResource = api.root.addResource('invoices');
    invoicesResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(invoiceManager, {
        proxy: true,
      }),
      {
        apiKeyRequired: true,
      }
    );

    const invoiceIdResource = invoicesResource.addResource('{invoiceId}');
    invoiceIdResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(invoiceManager, {
        proxy: true,
      }),
      {
        apiKeyRequired: true,
        requestValidator: requestValidator,
        requestParameters: {
          'method.request.path.invoiceId': true,
        },
      }
    );
    invoiceIdResource.addMethod(
      'PUT',
      new apigateway.LambdaIntegration(invoiceManager, {
        proxy: true,
      }),
      {
        apiKeyRequired: true,
        requestValidator: requestValidator,
        requestModels: {
          'application/json': updateInvoiceModel,
        },
        requestParameters: {
          'method.request.path.invoiceId': true,
        },
      }
    );
    invoiceIdResource.addMethod(
      'DELETE',
      new apigateway.LambdaIntegration(invoiceManager, {
        proxy: true,
      }),
      {
        apiKeyRequired: true,
        requestValidator: requestValidator,
        requestParameters: {
          'method.request.path.invoiceId': true,
        },
      }
    );

    const apiKey = api.addApiKey('ApiKey');
    const plan = api.addUsagePlan('UsagePlan', {
      apiStages: [{ api, stage: api.deploymentStage }],
    });
    plan.addApiKey(apiKey);

    // Watcher Lambda
    const suiRpcUrl = process.env.SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443';

    const watcher = new lambda.Function(this, 'Watcher', {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: 'bootstrap',
      code: lambda.Code.fromAsset('./target/lambda/watcher'),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      logRetention: 14, // 2 weeks
      environment: {
        SNS_TOPIC_ARN: notificationTopic.topicArn,
        SUI_RPC_URL: suiRpcUrl,
      },
    });

    invoiceTable.grantReadWriteData(watcher);
    notificationTopic.grantPublish(watcher);

    // EventBridge rule to trigger watcher every minute
    new events.Rule(this, 'WatcherSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(watcher)],
    });

    // Sweeper Lambda
    // Treasury address should be an external hardware wallet (Ledger, etc.)
    // NOT derived from the same mnemonic as invoice addresses
    const treasuryAddress = process.env.TREASURY_ADDRESS;
    if (!treasuryAddress) {
      throw new Error('TREASURY_ADDRESS environment variable is required. Set it in .env file.');
    }

    const sweeper = new lambda.Function(this, 'Sweeper', {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: 'bootstrap',
      code: lambda.Code.fromAsset('./target/lambda/sweeper'),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      logRetention: 30, // 1 month (longer for audit trail)
      reservedConcurrentExecutions: 1, // Prevent concurrent sweeps
      environment: {
        TREASURY_ADDRESS: treasuryAddress,
        ALERT_TOPIC_ARN: alertTopic.topicArn,
        KMS_KEY_ID: signingKeyCfn.attrKeyId,
        SUI_RPC_URL: suiRpcUrl,
      },
    });

    invoiceTable.grantReadWriteData(sweeper);
    mnemonicSecret.grantRead(sweeper);
    alertTopic.grantPublish(sweeper);
    sweeper.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Sign', 'kms:GetPublicKey'],
        resources: [signingKeyCfn.attrArn],
      })
    );
    sweeper.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      })
    );

    // Single DENY policy applied after both Lambdas exist so both ARNs
    // are in the exception list. A DENY always overrides an ALLOW in IAM,
    // so the exception list must be complete before the policy is attached.
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
              invoiceGenerator.role?.roleArn || '',
              sweeper.role?.roleArn || '',
            ].filter(arn => arn !== ''),
          },
        },
      })
    );

    sweeper.addEventSource(
      new DynamoEventSource(invoiceTable, {
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

    // Outputs
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.url,
      description: 'API Gateway endpoint',
    });

    new cdk.CfnOutput(this, 'ApiKeyId', {
      value: apiKey.keyId,
      description: 'API Key ID',
    });

    new cdk.CfnOutput(this, 'SnsTopicArn', {
      value: notificationTopic.topicArn,
      description: 'SNS Topic for payment notifications',
    });

    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: alertTopic.topicArn,
      description: 'SNS Topic for critical alerts',
    });

    new cdk.CfnOutput(this, 'KmsKeyId', {
      value: signingKeyCfn.attrKeyId,
      description: 'KMS Key ID for transaction signing',
    });

    new cdk.CfnOutput(this, 'KmsKeyArn', {
      value: signingKeyCfn.attrArn,
      description: 'KMS Key ARN for transaction signing',
    });

    // CloudWatch Alarms

    // Alarm: Sweeper errors
    const sweeperErrorAlarm = new cloudwatch.Alarm(this, 'SweeperErrorAlarm', {
      metric: sweeper.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'Sweeper Lambda has errors',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    sweeperErrorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    // Alarm: Watcher errors
    const watcherErrorAlarm = new cloudwatch.Alarm(this, 'WatcherErrorAlarm', {
      metric: watcher.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 3,
      evaluationPeriods: 1,
      alarmDescription: 'Watcher Lambda has multiple errors',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    watcherErrorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    // Alarm: Invoice generator errors
    const generatorErrorAlarm = new cloudwatch.Alarm(this, 'GeneratorErrorAlarm', {
      metric: invoiceGenerator.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 1,
      alarmDescription: 'Invoice generator has multiple errors',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    generatorErrorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    // Alarm: Sweeper duration (stuck sweeps)
    const sweeperDurationAlarm = new cloudwatch.Alarm(this, 'SweeperDurationAlarm', {
      metric: sweeper.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: 240000, // 4 minutes (timeout is 5 minutes)
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Sweeper taking too long - possible stuck transactions',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    sweeperDurationAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    // Alarm: Failed sweeps (sweeper emits SweepsFailed to SUIPayment namespace)
    const failedSweepsAlarm = new cloudwatch.Alarm(this, 'FailedSweepsAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'SUIPayment',
        metricName: 'SweepsFailed',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'One or more sweeps have failed',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    failedSweepsAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
  }
}
