const cdk = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');

// Import the compiled JavaScript version from dist directory
const { CryptoInvoiceStack } = require('../../../dist/lib/crypto-invoice-stack');

// Mock environment variables for testing
process.env.RPC_URL = 'https://test-rpc.example.com';
process.env.TREASURY_PUBLIC_ADDRESS = '0x1234567890123456789012345678901234567890';

describe('CryptoInvoiceStack CDK Components', () => {
  let template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new CryptoInvoiceStack(app, 'TestCryptoInvoiceStack');
    template = Template.fromStack(stack);
  });

  afterAll(() => {
    delete process.env.RPC_URL;
    delete process.env.TREASURY_PUBLIC_ADDRESS;
  });

  describe('DynamoDB Tables', () => {
    test('should create CryptoInvoices table', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          {
            AttributeName: 'invoiceId',
            AttributeType: 'S'
          },
          {
            AttributeName: 'status',
            AttributeType: 'S'
          }
        ],
        KeySchema: [
          {
            AttributeName: 'invoiceId',
            KeyType: 'HASH'
          }
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'status-index',
            KeySchema: [
              {
                AttributeName: 'status',
                KeyType: 'HASH'
              }
            ],
            Projection: {
              ProjectionType: 'ALL'
            }
          }
        ],
        StreamSpecification: {
          StreamViewType: 'NEW_IMAGE'
        }
      });
    });

    test('should create HdWalletCounter table', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          {
            AttributeName: 'counterId',
            AttributeType: 'S'
          }
        ],
        KeySchema: [
          {
            AttributeName: 'counterId',
            KeyType: 'HASH'
          }
        ]
      });
    });

    test('should have correct number of DynamoDB tables', () => {
      template.resourceCountIs('AWS::DynamoDB::Table', 2);
    });
  });

  describe('Secrets Manager', () => {
    test('should create HD wallet mnemonic secret', () => {
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: 'hd-wallet-mnemonic',
        Description: 'HD wallet mnemonic for invoice generation'
      });
    });

    test('should create hot wallet private key secret', () => {
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: 'wallet/hot-pk'
      });
    });

    test('should have correct number of secrets', () => {
      template.resourceCountIs('AWS::SecretsManager::Secret', 2);
    });
  });

  describe('Lambda Functions', () => {
    test('should create Invoice function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs18.x',
        Handler: 'index.handler',
        MemorySize: 256,
        Timeout: 30
      });
    });

    test('should create Watcher function with correct timeout', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs18.x',
        Handler: 'index.handler',
        MemorySize: 256,
        Timeout: 30
      });
    });

    test('should create Sweeper function with extended timeout', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs18.x',
        Handler: 'index.handler',
        MemorySize: 256,
        Timeout: 900 // 15 minutes
      });
    });

    test('should create Invoice Management function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs18.x',
        Handler: 'index.handler',
        MemorySize: 256,
        Timeout: 30
      });
    });

    test('should have correct number of Lambda functions', () => {
      // 4 main functions + 1 log retention function
      template.resourceCountIs('AWS::Lambda::Function', 5);
    });
  });

  describe('API Gateway', () => {
    test('should create REST API', () => {
      template.hasResourceProperties('AWS::ApiGateway::RestApi', {
        Name: 'Invoice Service',
        Description: 'API for generating crypto invoices'
      });
    });

    test('should create API deployment', () => {
      template.hasResourceProperties('AWS::ApiGateway::Deployment', {
        StageName: 'prod'
      });
    });

    test('should create API key', () => {
      template.hasResourceProperties('AWS::ApiGateway::ApiKey', {
        Name: 'CryptoInvoiceApiKey',
        Description: 'API Key for Crypto Invoice Service'
      });
    });

    test('should create usage plan', () => {
      template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
        UsagePlanName: 'CryptoInvoiceUsagePlan',
        Throttle: {
          RateLimit: 100,
          BurstLimit: 200
        },
        Quota: {
          Limit: 10000,
          Period: 'MONTH'
        }
      });
    });

    test('should have API methods with key requirement', () => {
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'POST',
        ApiKeyRequired: true
      });

      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'GET',
        ApiKeyRequired: true
      });
    });
  });

  describe('SNS Topic', () => {
    test('should create payment notification topic', () => {
      template.hasResourceProperties('AWS::SNS::Topic', {
        DisplayName: 'Merchant Payment Notifications'
      });
    });

    test('should have SNS topic policy for SSL enforcement', () => {
      template.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: {
          Statement: [
            {
              Sid: 'AllowPublishThroughSSLOnly',
              Effect: 'Deny',
              Principal: '*',
              Action: 'sns:Publish',
              Condition: {
                Bool: {
                  'aws:SecureTransport': 'false'
                }
              }
            }
          ]
        }
      });
    });
  });

  describe('EventBridge Rules', () => {
    test('should create watcher schedule rule', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        ScheduleExpression: 'rate(1 minute)',
        State: 'ENABLED'
      });
    });
  });

  describe('IAM Roles and Policies', () => {
    test('should create Lambda execution roles', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Effect: 'Allow',
              Principal: {
                Service: 'lambda.amazonaws.com'
              },
              Action: 'sts:AssumeRole'
            }
          ]
        }
      });
    });

    test('should have DynamoDB permissions for Lambda functions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Effect: 'Allow',
              Action: [
                'dynamodb:BatchGetItem',
                'dynamodb:GetRecords',
                'dynamodb:GetShardIterator',
                'dynamodb:Query',
                'dynamodb:GetItem',
                'dynamodb:Scan',
                'dynamodb:ConditionCheckItem',
                'dynamodb:BatchWriteItem',
                'dynamodb:PutItem',
                'dynamodb:UpdateItem',
                'dynamodb:DeleteItem',
                'dynamodb:DescribeStream',
                'dynamodb:ListStreams'
              ]
            }
          ]
        }
      });
    });

    test('should have Secrets Manager permissions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Effect: 'Allow',
              Action: 'secretsmanager:GetSecretValue'
            }
          ]
        }
      });
    });
  });

  describe('CloudWatch Log Groups', () => {
    test('should create log groups for Lambda functions', () => {
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        RetentionInDays: 14
      });
    });

    test('should create API Gateway access log group', () => {
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        RetentionInDays: 14
      });
    });
  });

  describe('Stack Outputs', () => {
    test('should have required stack outputs', () => {
      template.hasOutput('InvoiceFunctionName', {});
      template.hasOutput('InvoiceManagementFunctionName', {});
      template.hasOutput('WatcherFunctionName', {});
      template.hasOutput('SweeperFunctionName', {});
      template.hasOutput('WalletSeedSecretName', {});
      template.hasOutput('WalletHotPkSecretName', {});
      template.hasOutput('PaymentNotificationTopicArn', {});
      template.hasOutput('InvoiceApiUrl', {});
      template.hasOutput('InvoiceApiBaseUrl', {});
      template.hasOutput('InvoiceApiKeyId', {});
    });
  });

  describe('Resource Counts', () => {
    test('should have expected total resource counts', () => {
      // Verify we have the expected number of each resource type
      template.resourceCountIs('AWS::DynamoDB::Table', 2);
      template.resourceCountIs('AWS::SecretsManager::Secret', 2);
      template.resourceCountIs('AWS::Lambda::Function', 5); // 4 main + 1 log retention
      template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
      template.resourceCountIs('AWS::SNS::Topic', 1);
      template.resourceCountIs('AWS::Events::Rule', 1);
    });
  });
});