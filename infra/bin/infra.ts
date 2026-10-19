#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RoadtripCopilotCloudStack } from '../lib/roadtrip-cloud-stack.js';

const app = new cdk.App();

const selectedRegion = process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION;
const account = process.env.CDK_DEFAULT_ACCOUNT;

if (!selectedRegion) {
  throw new Error(
    'Missing required AWS region in CDK_DEFAULT_REGION or AWS_REGION. ' +
      'In the new AWS experience, all regional resources must target the project\'s assigned Region. ' +
      'Please set AWS_REGION or CDK_DEFAULT_REGION before synthesizing or deploying this stack.',
  );
}

const githubRepo =
  (app.node.tryGetContext('githubRepo') as string | undefined) ||
  process.env.GITHUB_REPO ||
  'ecoonradt/roadtrip-copilot';

const githubOidcProviderArn =
  (app.node.tryGetContext('githubOidcProviderArn') as string | undefined) ||
  process.env.GITHUB_OIDC_PROVIDER_ARN;

const authEnabled =
  process.env.AUTH_ENABLED ||
  (app.node.tryGetContext('authEnabled') as string | undefined);

const allowedEmails =
  process.env.ALLOWED_EMAILS ||
  (app.node.tryGetContext('allowedEmails') as string | undefined);

const googleClientId =
  process.env.GOOGLE_CLIENT_ID ||
  (app.node.tryGetContext('googleClientId') as string | undefined);

new RoadtripCopilotCloudStack(app, 'RoadtripCopilotCloudStack', {
  env: { account, region: selectedRegion },
  githubRepo,
  githubOidcProviderArn,
  authEnabled,
  allowedEmails,
  googleClientId,
});

