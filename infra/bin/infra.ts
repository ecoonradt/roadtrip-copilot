#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RoadtripCopilotCloudStack } from '../lib/roadtrip-cloud-stack.js';

const app = new cdk.App();

const selectedRegion = process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION;
const account = process.env.CDK_DEFAULT_ACCOUNT;

const githubRepo =
  (app.node.tryGetContext('githubRepo') as string | undefined) ||
  process.env.GITHUB_REPO ||
  'ecoonradt/roadtrip-copilot';

const githubOidcProviderArn =
  (app.node.tryGetContext('githubOidcProviderArn') as string | undefined) ||
  process.env.GITHUB_OIDC_PROVIDER_ARN;

new RoadtripCopilotCloudStack(app, 'RoadtripCopilotCloudStack', {
  env: selectedRegion ? { account, region: selectedRegion } : undefined,
  githubRepo,
  githubOidcProviderArn,
});
