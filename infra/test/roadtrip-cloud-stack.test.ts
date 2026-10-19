import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { RoadtripCopilotCloudStack } from '../lib/roadtrip-cloud-stack.js';

describe('RoadtripCopilotCloudStack', () => {
  const createStack = (props?: { githubRepo?: string; githubOidcProviderArn?: string }) => {
    const app = new cdk.App();
    return new RoadtripCopilotCloudStack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-2' },
      ...props,
    });
  };

  it('provisions both S3 buckets with full public access block and SSE enabled', () => {
    const stack = createStack();
    const template = Template.fromStack(stack);

    // Verify both StaticSiteBucket and AppDataBucket have BLOCK_ALL and AES256 SSE enabled
    template.resourcePropertiesCountIs(
      'AWS::S3::Bucket',
      {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256',
              },
            },
          ],
        },
      },
      2,
    );
  });

  it('provisions AppDataBucket with DeletionPolicy Retain', () => {
    const stack = createStack();
    const template = Template.fromStack(stack);

    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      },
    });
  });

  it('provisions FastifyApiFunction with correct memory, timeout, architecture and LWA environment', () => {
    const stack = createStack();
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 512,
      Timeout: 300,
      Architectures: ['x86_64'],
      Environment: {
        Variables: Match.objectLike({
          NODE_ENV: 'production',
          PORT: '3001',
          AWS_LWA_INVOKE_MODE: 'response_stream',
          AWS_LWA_READINESS_CHECK_PATH: '/api/health',
          S3_STORAGE_BUCKET: Match.anyValue(),
        }),
      },
    });
  });

  it('configures Lambda Function URL with auth NONE and RESPONSE_STREAM invoke mode', () => {
    const stack = createStack();
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'NONE',
      InvokeMode: 'RESPONSE_STREAM',
    });
  });

  it('configures CloudFront distribution with /api/* route, cache/origin request policies and 60s timeout', () => {
    const stack = createStack();
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/api/*',
            CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
            OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
            ViewerProtocolPolicy: 'redirect-to-https',
          }),
        ]),
        Origins: Match.arrayWith([
          Match.objectLike({
            CustomOriginConfig: Match.objectLike({
              OriginReadTimeout: 60,
              OriginProtocolPolicy: 'https-only',
            }),
          }),
        ]),
      }),
    });
  });

  it('configures CloudFront Function for SPA routing on static behavior and does not intercept API errors', () => {
    const stack = createStack();
    const template = Template.fromStack(stack);

    // Verify CloudFront Function is provisioned for SPA URL rewrite
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionConfig: Match.objectLike({
        Runtime: 'cloudfront-js-2.0',
      }),
    });

    // Verify distribution associates the function with defaultBehavior on viewer-request
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          FunctionAssociations: Match.arrayWith([
            Match.objectLike({
              EventType: 'viewer-request',
            }),
          ]),
        }),
      }),
    });

    // Ensure CustomErrorResponses is NOT present on the distribution so /api/* errors are preserved
    const distributions = template.findResources('AWS::CloudFront::Distribution');
    const distKeys = Object.keys(distributions);
    expect(distKeys.length).toBeGreaterThan(0);
    for (const key of distKeys) {
      expect(distributions[key].Properties.DistributionConfig.CustomErrorResponses).toBeUndefined();
    }
  });

  it('configures CloudFront S3 Origin Access Control (OAC)', () => {
    const stack = createStack();
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      }),
    });
  });

  it('provisions scoped IAM user and role for GitHub Actions deployment without OIDC provider', () => {
    const stack = createStack();
    const template = Template.fromStack(stack);

    // Never triggers iam:CreateOpenIDConnectProvider
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);

    // Provisions dedicated IAM machine user
    template.hasResourceProperties('AWS::IAM::User', {
      UserName: 'roadtrip-copilot-github-actions-deployer',
    });

    // Provisions deployer IAM role
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'roadtrip-copilot-github-actions-deploy',
    });

    // Authorizes sts:AssumeRole and sts:TagSession
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['sts:AssumeRole', 'sts:TagSession'],
          }),
        ]),
      },
    });
  });

  it('synthesizes all required CfnOutput keys', () => {
    const stack = createStack();
    const template = Template.fromStack(stack);

    const outputs = template.findOutputs('*');
    const outputKeys = Object.keys(outputs);

    expect(outputKeys).toContain('CloudFrontUrl');
    expect(outputKeys).toContain('DistributionId');
    expect(outputKeys).toContain('StaticSiteBucketName');
    expect(outputKeys).toContain('AppDataBucketName');
    expect(outputKeys).toContain('LambdaFunctionUrl');
    expect(outputKeys).toContain('GitHubActionsRoleArn');
    expect(outputKeys).toContain('GitHubActionsUserName');
  });

  it('uses existing OIDC provider when githubOidcProviderArn is specified', () => {
    const stack = createStack({
      githubRepo: 'test/repo',
      githubOidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
    });
    const template = Template.fromStack(stack);

    // When ARN is passed, Custom::AWSCDKOpenIdConnectProvider is not created
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);

    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'roadtrip-copilot-github-actions-deploy',
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Effect: 'Allow',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              },
              StringLike: {
                'token.actions.githubusercontent.com:sub': 'repo:test/repo:*',
              },
            },
          }),
        ],
      },
    });
  });
});
