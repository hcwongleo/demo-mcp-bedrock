#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BedrockMcpStack } from '../lib/bedrock-mcp-stack';

const app = new cdk.App();
const qualifier = app.node.tryGetContext('qualifier') || process.env.CDK_QUALIFIER || 'cdk020841';
const allowedCidr = app.node.tryGetContext('allowedCidr') || '0.0.0.0/0';

const env = { 
  account: process.env.CDK_DEFAULT_ACCOUNT, 
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1'
};

new BedrockMcpStack(app, `BedrockMcpStack-${qualifier}`, {
  env,
  description: 'Bedrock MCP Demo Stack (Local Code)',
  allowedCidr,
  synthesizer: new cdk.DefaultStackSynthesizer({
    qualifier: qualifier,
    bootstrapStackVersionSsmParameter: `/cdk-bootstrap/${qualifier}/version`,
    fileAssetsBucketName: `cdk-${qualifier}-assets-${env.account}-${env.region}`
  })
});
