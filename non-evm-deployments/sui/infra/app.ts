#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { SuiPaymentStack } from './stack';

const app = new cdk.App();

const stack = new SuiPaymentStack(app, 'SuiPaymentStack', {
  env: {
    account: '044560964952',
    region: 'us-east-1',
  },
});

// Add security checks
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Suppress acceptable findings for reference implementation
NagSuppressions.addStackSuppressions(stack, [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWS managed policies (AWSLambdaBasicExecutionRole) are acceptable for Lambda execution roles in reference implementations',
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Wildcard permissions required for DynamoDB GSI access and CloudWatch metrics. Scoped to specific resources where possible.',
  },
  {
    id: 'AwsSolutions-APIG4',
    reason: 'API key authentication is appropriate for payment APIs. Cognito would add unnecessary complexity for this use case.',
  },
  {
    id: 'AwsSolutions-COG4',
    reason: 'API key authentication is appropriate for payment APIs. Cognito user pools not required for server-to-server communication.',
  },
  {
    id: 'AwsSolutions-APIG3',
    reason: 'WAF not included in reference implementation. Recommended for production deployments handling high-value transactions.',
  },
]);
