const cdk = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');

// Import the compiled JavaScript version from dist directory
const { CryptoInvoiceStack } = require('../../../dist/lib/crypto-invoice-stack');

// Mock environment variables
process.env.RPC_URL = 'https://test-rpc.example.com';
process.env.TREASURY_PUBLIC_ADDRESS = '0x1234567890123456789012345678901234567890';

describe('CryptoInvoiceStack Security Configuration', () => {
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

  describe('DynamoDB Security', () => {
    test('should have removal policy set to DESTROY', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        DeletionPolicy: 'Delete'
      });
    });

    test('should enable DynamoDB streams for sweeper trigger', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        StreamSpecification: {
          StreamViewType: 'NEW_IMAGE'
        }
      });
    });
  });

  describe('Secrets Manager Security', () => {
    test('should have removal policy set to DESTROY', () => {
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        DeletionPolicy: 'Delete'
      });
    });

    test('should have resource policies restricting access', () => {
      template.hasResourceProperties('AWS::SecretsManager::ResourcePolicy', {
        ResourcePolicy: {
          Statement: [
            {
              Sid: 'RestrictMnemonicSecretAccess',
              Effect: 'Deny',
              Principal: '*',
              Action: 'secretsmanager:GetSecretValue',
              Condition: {
                ArnNotEquals: {
                  'aws:PrincipalArn': {}
                }
              }
            }
          ]
        }
      });
    });
  });

  describe('API Gateway Security', () => {
    test('should require API keys for all methods', () => {
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        ApiKeyRequired: true
      });
    });

    test('should have throttling configured', () => {
      template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
        Throttle: {
          RateLimit: 100,
          BurstLimit: 200
        }
      });
    });

    test('should have usage quotas configured', () => {
      template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
        Quota: {
          Limit: 10000,
          Period: 'MONTH'
        }
      });
    });

    test('should have CORS headers configured', () => {
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'OPTIONS'
      });
    });
  });

  describe('SNS Security', () => {
    test('should enforce HTTPS-only publishing', () => {
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

  describe('Lambda Security', () => {
    test('should have appropriate timeout configurations', () => {
      // Most functions should have 30 second timeout
      template.hasResourceProperties('AWS::Lambda::Function', {
        Timeout: 30
      });

      // Sweeper should have extended timeout for blockchain operations
      template.hasResourceProperties('AWS::Lambda::Function', {
        Timeout: 900 // 15 minutes
      });
    });

    test('should have memory limits configured', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        MemorySize: 256
      });
    });

    test('should use supported Node.js runtime', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs18.x'
      });
    });
  });

  describe('IAM Security', () => {
    test('should have least privilege IAM policies', () => {
      // Check that Lambda roles only have necessary permissions
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

    test('should have proper assume role policies', () => {
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
  });

  describe('CloudWatch Logging', () => {
    test('should have log retention configured', () => {
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        RetentionInDays: 14
      });
    });

    test('should have API Gateway access logging enabled', () => {
      template.hasResourceProperties('AWS::ApiGateway::Stage', {
        AccessLogSetting: {}
      });
    });
  });
});