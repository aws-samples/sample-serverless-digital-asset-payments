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
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';

export class SuiPaymentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB Tables
    const invoiceTable = new dynamodb.Table(this, 'SuiInvoices', {
      tableName: 'SuiInvoices',
      partitionKey: { name: 'invoice_id', type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true, // Enable PITR for data protection
    });

    invoiceTable.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
    });

    const counterTable = new dynamodb.Table(this, 'SuiWalletCounter', {
      tableName: 'SuiWalletCounter',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true, // Enable PITR for data protection
    });

    // Use existing secret (created manually)
    const mnemonicSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'SuiMnemonic',
      'sui-payment-mnemonic'
    );

    // KMS Key for invoice wallet signing (production-grade security)
    const signingKey = new kms.Key(this, 'InvoiceSigningKey', {
      description: 'KMS key for signing SUI transactions from invoice wallets',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Protect key from accidental deletion
      alias: 'sui-payment-signing-key',
    });

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

    // Restrict mnemonic secret access to only invoice generator and sweeper
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
              // Sweeper role will be added after it's created
            ].filter(arn => arn !== ''),
          },
        },
      })
    );

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
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        required: ['amount', 'reference_id', 'expiry_seconds'],
        properties: {
          amount: {
            type: apigateway.JsonSchemaType.INTEGER,
            minimum: 1,
            maximum: 1000000000000, // 1000 SUI max
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
    invoicesResource.addMethod('GET', new apigateway.LambdaIntegration(invoiceManager, {
      proxy: true,
    }), {
      apiKeyRequired: true,
    });

    const invoiceIdResource = invoicesResource.addResource('{invoiceId}');
    invoiceIdResource.addMethod('GET', new apigateway.LambdaIntegration(invoiceManager, {
      proxy: true,
    }), {
      apiKeyRequired: true,
      requestValidator: requestValidator,
      requestParameters: {
        'method.request.path.invoiceId': true,
      },
    });
    invoiceIdResource.addMethod('PUT', new apigateway.LambdaIntegration(invoiceManager, {
      proxy: true,
    }), {
      apiKeyRequired: true,
      requestValidator: requestValidator,
      requestModels: {
        'application/json': updateInvoiceModel,
      },
      requestParameters: {
        'method.request.path.invoiceId': true,
      },
    });
    invoiceIdResource.addMethod('DELETE', new apigateway.LambdaIntegration(invoiceManager, {
      proxy: true,
    }), {
      apiKeyRequired: true,
      requestValidator: requestValidator,
      requestParameters: {
        'method.request.path.invoiceId': true,
      },
    });

    const apiKey = api.addApiKey('ApiKey');
    const plan = api.addUsagePlan('UsagePlan', {
      apiStages: [{ api, stage: api.deploymentStage }],
    });
    plan.addApiKey(apiKey);

    // Watcher Lambda
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
    const treasuryAddress = process.env.TREASURY_ADDRESS || 
      '0x09e66c87d06058ee3d292bbb6284b2b9ac31bbeab0da5e1f75cec4ddf6e00b52'; // Default for testing only
    
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
        KMS_KEY_ID: signingKey.keyId,
        USE_KMS_SIGNING: 'false', // Set to 'true' once KMS signing is implemented
      },
    });

    invoiceTable.grantReadWriteData(sweeper);
    mnemonicSecret.grantRead(sweeper);
    alertTopic.grantPublish(sweeper);
    signingKey.grantSign(sweeper); // Grant KMS signing permission
    
    // Update mnemonic secret policy to include sweeper role
    mnemonicSecret.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSweeperAccess',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ArnPrincipal(sweeper.role?.roleArn || '')],
        actions: ['secretsmanager:GetSecretValue'],
        resources: ['*'],
      })
    );
    
    // Grant CloudWatch PutMetricData permission
    sweeper.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    sweeper.addEventSource(new DynamoEventSource(invoiceTable, {
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
    }));

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
      value: signingKey.keyId,
      description: 'KMS Key ID for transaction signing',
    });

    new cdk.CfnOutput(this, 'KmsKeyArn', {
      value: signingKey.keyArn,
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

    // CloudWatch Dashboard
    const dashboard = new cloudwatch.Dashboard(this, 'PaymentDashboard', {
      dashboardName: 'SUI-Payment-Agent',
    });

    // Row 1: Lambda Invocations
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Invocations',
        left: [
          invoiceGenerator.metricInvocations({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
          watcher.metricInvocations({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
          sweeper.metricInvocations({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Errors',
        left: [
          invoiceGenerator.metricErrors({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
          watcher.metricErrors({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
          sweeper.metricErrors({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        ],
        width: 12,
      }),
    );

    // Row 2: Lambda Duration
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Duration (ms)',
        left: [
          invoiceGenerator.metricDuration({ statistic: 'Average', period: cdk.Duration.minutes(5) }),
          watcher.metricDuration({ statistic: 'Average', period: cdk.Duration.minutes(5) }),
          sweeper.metricDuration({ statistic: 'Average', period: cdk.Duration.minutes(5) }),
        ],
        width: 12,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Sweeper Success Rate (Last Hour)',
        metrics: [
          new cloudwatch.MathExpression({
            expression: '(invocations - errors) / invocations * 100',
            usingMetrics: {
              invocations: sweeper.metricInvocations({ statistic: 'Sum', period: cdk.Duration.hours(1) }),
              errors: sweeper.metricErrors({ statistic: 'Sum', period: cdk.Duration.hours(1) }),
            },
            label: 'Success Rate %',
          }),
        ],
        width: 12,
      }),
    );

    // Row 3: DynamoDB Metrics
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Read/Write Capacity',
        left: [
          invoiceTable.metricConsumedReadCapacityUnits({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
          invoiceTable.metricConsumedWriteCapacityUnits({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Throttles',
        left: [
          invoiceTable.metricUserErrors({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
          invoiceTable.metricSystemErrorsForOperations({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        ],
        width: 12,
      }),
    );

    // Row 4: Custom Metrics (Log-based)
    const invoiceCreatedMetric = new cloudwatch.Metric({
      namespace: 'SUIPayment',
      metricName: 'InvoicesCreated',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const paymentDetectedMetric = new cloudwatch.Metric({
      namespace: 'SUIPayment',
      metricName: 'PaymentsDetected',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const sweepSuccessMetric = new cloudwatch.Metric({
      namespace: 'SUIPayment',
      metricName: 'SweepsSuccessful',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const sweepFailedMetric = new cloudwatch.Metric({
      namespace: 'SUIPayment',
      metricName: 'SweepsFailed',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Invoice Lifecycle',
        left: [invoiceCreatedMetric, paymentDetectedMetric, sweepSuccessMetric, sweepFailedMetric],
        width: 24,
      }),
    );

    // Alarm: Failed sweeps
    const failedSweepsAlarm = new cloudwatch.Alarm(this, 'FailedSweepsAlarm', {
      metric: sweepFailedMetric,
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'One or more sweeps have failed',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    failedSweepsAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
  }
}
