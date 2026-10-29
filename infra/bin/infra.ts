#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RoadtripCopilotCloudStack } from '../lib/roadtrip-cloud-stack.js';

const app = new cdk.App();

const selectedRegion = process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION;
const account = process.env.CDK_DEFAULT_ACCOUNT;

if (!selectedRegion) {
  throw new Error(
    'Missing required AWS region in CDK_DEFAULT_REGION or AWS_REGION. ' +
      'All regional resources must target the primary Region (e.g. us-east-2). ' +
      'Please set AWS_REGION or CDK_DEFAULT_REGION before synthesizing or deploying this stack.',
  );
}

const githubRepo =
  (app.node.tryGetContext('githubRepo') as string | undefined) ||
  process.env.GITHUB_REPO ||
  'ecoonradt/roadtrip-copilot';

const githubOidcProviderArn =
  (app.node.tryGetContext('githubOidcProviderArn') as string | undefined) ||
  process.env.AWS_OIDC_PROVIDER_ARN ||
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

const originVerifySecret =
  process.env.ORIGIN_VERIFY_SECRET ||
  (app.node.tryGetContext('originVerifySecret') as string | undefined);

const allowedHosts =
  process.env.ALLOWED_HOSTS ||
  (app.node.tryGetContext('allowedHosts') as string | undefined);

const publicBaseUrl =
  process.env.PUBLIC_BASE_URL ||
  (app.node.tryGetContext('publicBaseUrl') as string | undefined);

const googleClientIdSsmParam =
  process.env.GOOGLE_CLIENT_ID_SSM_PARAM ||
  (app.node.tryGetContext('googleClientIdSsmParam') as string | undefined);

const googleClientSecretSsmParam =
  process.env.GOOGLE_CLIENT_SECRET_SSM_PARAM ||
  (app.node.tryGetContext('googleClientSecretSsmParam') as string | undefined);

const jwtSecretSsmParam =
  process.env.JWT_SECRET_SSM_PARAM ||
  (app.node.tryGetContext('jwtSecretSsmParam') as string | undefined);

const allowedEmailsSsmParam =
  process.env.ALLOWED_EMAILS_SSM_PARAM ||
  (app.node.tryGetContext('allowedEmailsSsmParam') as string | undefined);

const publicBaseUrlSsmParam =
  process.env.PUBLIC_BASE_URL_SSM_PARAM ||
  (app.node.tryGetContext('publicBaseUrlSsmParam') as string | undefined);

const originVerifySecretSsmParam =
  process.env.ORIGIN_VERIFY_SECRET_SSM_PARAM ||
  (app.node.tryGetContext('originVerifySecretSsmParam') as string | undefined);

const googlePlacesApiKey =
  app.node.tryGetContext('googlePlacesApiKey') as string | undefined;

const googlePlacesApiKeySsmParam =
  process.env.GOOGLE_PLACES_API_KEY_SSM_PARAM ||
  (app.node.tryGetContext('googlePlacesApiKeySsmParam') as string | undefined);

const braveSearchApiKey =
  app.node.tryGetContext('braveSearchApiKey') as string | undefined;

const braveSearchApiKeySsmParam =
  process.env.BRAVE_SEARCH_API_KEY_SSM_PARAM ||
  (app.node.tryGetContext('braveSearchApiKeySsmParam') as string | undefined);

const bedrockScoutModelId =
  process.env.BEDROCK_SCOUT_MODEL_ID ||
  (app.node.tryGetContext('bedrockScoutModelId') as string | undefined);

const bedrockCopywriterModelId =
  process.env.BEDROCK_COPYWRITER_MODEL_ID ||
  (app.node.tryGetContext('bedrockCopywriterModelId') as string | undefined);

new RoadtripCopilotCloudStack(app, 'RoadtripCopilotCloudStack', {
  env: { account, region: selectedRegion },
  githubRepo,
  githubOidcProviderArn,
  authEnabled,
  allowedEmails,
  googleClientId,
  googleClientIdSsmParam,
  googleClientSecretSsmParam,
  jwtSecretSsmParam,
  allowedEmailsSsmParam,
  publicBaseUrlSsmParam,
  originVerifySecretSsmParam,
  allowedHosts,
  publicBaseUrl,
  originVerifySecret,
  googlePlacesApiKey,
  googlePlacesApiKeySsmParam,
  braveSearchApiKey,
  braveSearchApiKeySsmParam,
  bedrockScoutModelId,
  bedrockCopywriterModelId,
});

