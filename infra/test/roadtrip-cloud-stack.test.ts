import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { RoadtripCopilotCloudStack, RoadtripCopilotCloudStackProps } from '../lib/roadtrip-cloud-stack.js';

describe('RoadtripCopilotCloudStack', () => {
  const createStack = (props?: Partial<RoadtripCopilotCloudStackProps>) => {
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

  it('provisions FastifyApiFunction with correct memory, timeout, architecture, LWA and auth environment', () => {
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
          AUTH_ENABLED: 'true',
          ALLOWED_EMAILS: '',
          GOOGLE_CLIENT_ID: '',
          GOOGLE_CLIENT_ID_SSM_PARAM: '/roadtrip-copilot/google-client-id',
          GOOGLE_CLIENT_SECRET_SSM_PARAM: '/roadtrip-copilot/google-client-secret',
          JWT_SECRET_SSM_PARAM: '/roadtrip-copilot/jwt-secret',
          ALLOWED_EMAILS_SSM_PARAM: '/roadtrip-copilot/allowed-emails',
        }),
      },
    });
  });

  it('allows customizing auth and SSM parameter paths via stack props', () => {
    const stack = createStack({
      authEnabled: 'false',
      allowedEmails: 'driver1@example.com,driver2@example.com',
      googleClientId: 'custom-google-client-id',
      googleClientIdSsmParam: '/custom/client-id',
      googleClientSecretSsmParam: '/custom/client-secret',
      jwtSecretSsmParam: '/custom/jwt-secret',
      allowedEmailsSsmParam: '/custom/allowed-emails',
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          AUTH_ENABLED: 'false',
          ALLOWED_EMAILS: 'driver1@example.com,driver2@example.com',
          GOOGLE_CLIENT_ID: 'custom-google-client-id',
          GOOGLE_CLIENT_ID_SSM_PARAM: '/custom/client-id',
          GOOGLE_CLIENT_SECRET_SSM_PARAM: '/custom/client-secret',
          JWT_SECRET_SSM_PARAM: '/custom/jwt-secret',
          ALLOWED_EMAILS_SSM_PARAM: '/custom/allowed-emails',
        }),
      },
    });
  });

  it('grants FastifyApiFunction IAM execution role permissions for SSM parameters and KMS decryption', () => {
    const stack = createStack();
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['ssm:GetParameter', 'ssm:GetParameters'],
            Effect: 'Allow',
            Resource: {
              'Fn::Join': [
                '',
                [
                  'arn:',
                  { Ref: 'AWS::Partition' },
                  ':ssm:us-east-2:123456789012:parameter/roadtrip-copilot/*',
                ],
              ],
            },
          }),
          Match.objectLike({
            Action: 'kms:Decrypt',
            Effect: 'Allow',
            Resource: '*',
            Condition: {
              StringEquals: {
                'kms:ViaService': 'ssm.us-east-2.amazonaws.com',
              },
            },
          }),
        ]),
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

  it('CloudFront Function correctly rewrites both /route and /route/ to /index.html and preserves assets', () => {
    const stack = createStack();
    const template = Template.fromStack(stack);

    const functions = template.findResources('AWS::CloudFront::Function');
    const fnKey =
      Object.keys(functions).find((key) => key.startsWith('SpaRewriteFunction')) ??
      Object.keys(functions)[0];
    const functionCode = functions[fnKey].Properties.FunctionCode;

    // Evaluate the handler code
    const handler = new Function(
      'event',
      `${functionCode}\nreturn handler(event);`,
    ) as (event: { request: { uri: string } }) => { uri: string };

    const run = (uri: string) => handler({ request: { uri } }).uri;

    // Non-asset SPA routes (with or without trailing slash) rewrite to root /index.html
    expect(run('/')).toBe('/index.html');
    expect(run('/route')).toBe('/index.html');
    expect(run('/route/')).toBe('/index.html');
    expect(run('/nested/route/')).toBe('/index.html');
    expect(run('/itineraries/new')).toBe('/index.html');

    // Static assets with file extensions remain untouched
    expect(run('/index.html')).toBe('/index.html');
    expect(run('/assets/index-DiYxdhPO.js')).toBe('/assets/index-DiYxdhPO.js');
    expect(run('/assets/index-C1bgkAIB.css')).toBe('/assets/index-C1bgkAIB.css');
    expect(run('/favicon.ico')).toBe('/favicon.ico');
  });

  it('associates ApiForwardedHostFunction with /api/* cache behavior on viewer-request', () => {
    const stack = createStack();
    const template = Template.fromStack(stack);

    // Verify ApiForwardedHostFunction exists with runtime cloudfront-js-2.0
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionConfig: Match.objectLike({
        Runtime: 'cloudfront-js-2.0',
      }),
    });

    // Verify /api/* behavior associates ApiForwardedHostFunction
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/api/*',
            FunctionAssociations: Match.arrayWith([
              Match.objectLike({
                EventType: 'viewer-request',
                FunctionARN: Match.anyValue(),
              }),
            ]),
          }),
        ]),
      }),
    });
  });

  it('ApiForwardedHostFunction copies host to x-forwarded-host and sets x-forwarded-proto to https', () => {
    const stack = createStack();
    const template = Template.fromStack(stack);

    const functions = template.findResources('AWS::CloudFront::Function');
    const apiFnKey = Object.keys(functions).find((key) => key.startsWith('ApiForwardedHostFunction'));
    expect(apiFnKey).toBeDefined();
    const functionCode = functions[apiFnKey!].Properties.FunctionCode;

    const handler = new Function(
      'event',
      `${functionCode}\nreturn handler(event);`,
    ) as (event: {
      request: {
        headers?: Record<string, { value: string }>;
      };
    }) => {
      headers: Record<string, { value: string }>;
    };

    // When request has host header, x-forwarded-host and x-forwarded-proto are populated
    const reqWithHost = {
      request: {
        headers: {
          host: { value: 'roadtrip.example.com' },
          accept: { value: 'application/json' },
        },
      },
    };
    const resultWithHost = handler(reqWithHost);
    expect(resultWithHost.headers['x-forwarded-host']).toEqual({ value: 'roadtrip.example.com' });
    expect(resultWithHost.headers['x-forwarded-proto']).toEqual({ value: 'https' });
    expect(resultWithHost.headers.host).toEqual({ value: 'roadtrip.example.com' });

    // When request has no host header, x-forwarded-proto is set and x-forwarded-host is not set
    const reqWithoutHost = {
      request: {
        headers: {},
      },
    };
    const resultWithoutHost = handler(reqWithoutHost);
    expect(resultWithoutHost.headers['x-forwarded-host']).toBeUndefined();
    expect(resultWithoutHost.headers['x-forwarded-proto']).toEqual({ value: 'https' });
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
