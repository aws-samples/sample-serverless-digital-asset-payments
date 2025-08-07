const cdk = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');

// Import the compiled JavaScript version from dist directory
const { CryptoInvoiceStack } = require('../../../dist/lib/crypto-invoice-stack');

// Mock environment variables for testing
process.env.RPC_URL = 'https://test-rpc.example.com';
process.env.TREASURY_PUBLIC_ADDRESS = '0x1234567890123456789012345678901234567890';

describe('CryptoInvoiceStack - Essential Components', () => {
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

  describe('Core Infrastructure', () => {
    test('should create DynamoDB tables', () => {
      template.resourceCountIs('AWS::DynamoDB::Table', 2);
    });

    test('should create Secrets Manager secrets', () => {
      template.resourceCountIs('AWS::SecretsManager::Secret', 2);
    });

    test('should create Lambda functions', () => {
      template.resourceCountIs('AWS::Lambda::Function', 4);
    });

    test('should create API Gateway', () => {
      template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    });

    test('should create SNS topic', () => {
      template.resourceCountIs('AWS::SNS::Topic', 1);
    });

    test('should create EventBridge rule', () => {
      template.resourceCountIs('AWS::Events::Rule', 1);
    });
  });

  describe('Lambda Functions', () => {
    test('should have Lambda functions with correct basic properties', () => {
      // Check that Lambda functions exist with expected properties
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
        MemorySize: 256,
      });
    });
  });

  describe('DynamoDB Configuration', () => {
    test('should have invoice table with GSI', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: [
          {
            IndexName: 'status-index',
          },
        ],
      });
    });
  });

  describe('API Gateway Configuration', () => {
    test('should have API key and usage plan', () => {
      template.resourceCountIs('AWS::ApiGateway::ApiKey', 1);
      template.resourceCountIs('AWS::ApiGateway::UsagePlan', 1);
    });
  });

  describe('Stack Outputs', () => {
    test('should have all required outputs', () => {
      template.hasOutput('InvoiceFunctionName', {});
      template.hasOutput('InvoiceManagementFunctionName', {});
      template.hasOutput('WatcherFunctionName', {});
      template.hasOutput('SweeperFunctionName', {});
      template.hasOutput('InvoiceApiUrl', {});
      template.hasOutput('InvoiceApiBaseUrl', {});
      template.hasOutput('InvoiceApiKeyId', {});
    });
  });
});
