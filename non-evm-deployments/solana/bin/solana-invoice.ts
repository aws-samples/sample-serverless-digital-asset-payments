#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
// import { AwsSolutionsChecks } from 'cdk-nag';
import { SolanaInvoiceStack } from '../lib/solana-invoice-stack';

const app = new cdk.App();
// cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

new SolanaInvoiceStack(app, 'SolanaInvoiceStack');
