#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { SolanaInvoiceStack } from '../lib/solana-invoice-stack';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const app = new cdk.App();
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

new SolanaInvoiceStack(app, 'SolanaInvoiceStack', {
    env: {
        region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1',
    },
});
