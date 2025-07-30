#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { CryptoInvoiceStack } from "../lib/crypto-invoice-stack";

const app = new cdk.App();
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

new CryptoInvoiceStack(app, "CryptoInvoiceStack");
