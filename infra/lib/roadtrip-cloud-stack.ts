import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import {
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_s3 as s3,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface RoadtripCopilotCloudStackProps extends cdk.StackProps {
  githubRepo?: string;
  githubOidcProviderArn?: string;
  authEnabled?: string;
  allowedEmails?: string;
  googleClientId?: string;
  googleClientIdSsmParam?: string;
  googleClientSecretSsmParam?: string;
  jwtSecretSsmParam?: string;
  allowedEmailsSsmParam?: string;
  publicBaseUrlSsmParam?: string;
  allowedHosts?: string;
  originVerifySecret?: string;
}

export class RoadtripCopilotCloudStack extends cdk.Stack {
  public readonly staticSiteBucket: s3.Bucket;
  public readonly appDataBucket: s3.Bucket;
  public readonly fastifyApiFunction: lambda.DockerImageFunction;
  public readonly functionUrl: lambda.FunctionUrl;
  public readonly distribution: cloudfront.Distribution;
  public readonly apiForwardedHostFunction: cloudfront.Function;
  public readonly githubActionsUser?: iam.User;
  public readonly githubActionsRole?: iam.Role;

  constructor(scope: Construct, id: string, props?: RoadtripCopilotCloudStackProps) {
    super(scope, id, props);

    // 1. StaticSiteBucket (S3 Bucket)
    // Ephemeral build artifacts (dist/) are synced from git repository builds and contain no user data.
    // DESTROY + autoDeleteObjects enables clean `cdk destroy` without leaving orphaned S3 buckets in the project.
    // In contrast, AppDataBucket (below) holds user itineraries and trip data, so it strictly uses RETAIN.
    this.staticSiteBucket = new s3.Bucket(this, 'StaticSiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // 2. AppDataBucket (S3 Bucket)
    this.appDataBucket = new s3.Bucket(this, 'AppDataBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // 3. FastifyApiFunction (DockerImageFunction)
    this.fastifyApiFunction = new lambda.DockerImageFunction(this, 'FastifyApiFunction', {
      code: lambda.DockerImageCode.fromImageAsset(path.resolve(__dirname, '../../route-builder'), {
        exclude: ['node_modules', 'dist', 'dist-server', 'tests', 'src', '.vite', '.git'],
      }),
      architecture: lambda.Architecture.X86_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      environment: {
        NODE_ENV: 'production',
        PORT: '3001',
        AWS_LWA_INVOKE_MODE: 'response_stream',
        AWS_LWA_READINESS_CHECK_PATH: '/api/health',
        S3_STORAGE_BUCKET: this.appDataBucket.bucketName,
        AUTH_ENABLED: props?.authEnabled ?? 'true',
        ALLOWED_EMAILS: props?.allowedEmails ?? '',
        GOOGLE_CLIENT_ID: props?.googleClientId ?? '',
        GOOGLE_CLIENT_ID_SSM_PARAM: props?.googleClientIdSsmParam ?? '/roadtrip-copilot/google-client-id',
        GOOGLE_CLIENT_SECRET_SSM_PARAM: props?.googleClientSecretSsmParam ?? '/roadtrip-copilot/google-client-secret',
        JWT_SECRET_SSM_PARAM: props?.jwtSecretSsmParam ?? '/roadtrip-copilot/jwt-secret',
        ALLOWED_EMAILS_SSM_PARAM: props?.allowedEmailsSsmParam ?? '/roadtrip-copilot/allowed-emails',
        PUBLIC_BASE_URL_SSM_PARAM: props?.publicBaseUrlSsmParam ?? '/roadtrip-copilot/public-base-url',
        ALLOWED_HOSTS: props?.allowedHosts ?? '',
        ORIGIN_VERIFY_SECRET: props?.originVerifySecret ?? 'roadtrip-copilot-edge',
      },
    });

    // Lambda Function URL (Streaming)
    this.functionUrl = this.fastifyApiFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    // Grant AppDataBucket read/write access to FastifyApiFunction
    this.appDataBucket.grantReadWrite(this.fastifyApiFunction);

    // Grant least-privilege permissions to read SSM parameters and decrypt via KMS
    this.fastifyApiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          `arn:${cdk.Aws.PARTITION}:ssm:${this.region}:${this.account}:parameter/roadtrip-copilot/*`,
        ],
      }),
    );

    this.fastifyApiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': `ssm.${this.region}.amazonaws.com`,
          },
        },
      }),
    );

    // 4. CloudFront Functions
    // SPA client routing function for static site:
    // Restricts client-side route rewrites strictly to defaultBehavior (S3 static site).
    // Leaves /api/* completely untouched so genuine API status codes (400, 401, 403, 404, 500) and JSON bodies are preserved.
    const spaRewriteFunction = new cloudfront.Function(this, 'SpaRewriteFunction', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  // If the path does not have a file extension (e.g. /, /route, /route/), rewrite to root /index.html
  if (!uri.includes('.')) {
    request.uri = '/index.html';
  }
  return request;
}
`),
    });

    // Forwarded host header function for /api/* requests:
    // Preserves CloudFront viewer host and proto without introducing CloudFormation circular dependencies.
    const apiForwardedHostFunction = new cloudfront.Function(this, 'ApiForwardedHostFunction', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  if (request.headers && request.headers.host && request.headers.host.value) {
    request.headers['x-forwarded-host'] = { value: request.headers.host.value };
  }
  request.headers['x-forwarded-proto'] = { value: 'https' };
  return request;
}
`),
    });
    this.apiForwardedHostFunction = apiForwardedHostFunction;

    // 5. CloudFrontDistribution (Distribution)
    this.distribution = new cloudfront.Distribution(this, 'CloudFrontDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.staticSiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        functionAssociations: [
          {
            function: spaRewriteFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.FunctionUrlOrigin(this.functionUrl, {
            readTimeout: cdk.Duration.seconds(60),
            customHeaders: {
              'x-copilot-origin-verify': props?.originVerifySecret ?? 'roadtrip-copilot-edge',
            },
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          functionAssociations: [
            {
              function: apiForwardedHostFunction,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
      },
    });

    // 6. GitHubActionsDeployRole & DeployUser (IAM Deployer compliant with AWS Project SCPs)
    const githubRepo = props?.githubRepo ?? 'ecoonradt/roadtrip-copilot';
    if (githubRepo) {
      let githubActionsRole: iam.Role;

      if (props?.githubOidcProviderArn) {
        // Opt-in external OIDC Provider (e.g. pre-existing or advanced AWS project)
        const oidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          'GitHubOidcProvider',
          props.githubOidcProviderArn,
        );

        githubActionsRole = new iam.Role(this, 'GitHubActionsDeployRole', {
          roleName: 'roadtrip-copilot-github-actions-deploy',
          assumedBy: new iam.WebIdentityPrincipal(oidcProvider.openIdConnectProviderArn, {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            },
            StringLike: {
              'token.actions.githubusercontent.com:sub': `repo:${githubRepo}:*`,
            },
          }),
        });
      } else {
        // Default for AWS Projects: Dedicated deployer user + assume role (avoids iam:CreateOpenIDConnectProvider blocked by DenyIAMRestrictedActions SCP)
        const githubActionsUser = new iam.User(this, 'GitHubActionsDeployUser', {
          userName: 'roadtrip-copilot-github-actions-deployer',
        });

        githubActionsRole = new iam.Role(this, 'GitHubActionsDeployRole', {
          roleName: 'roadtrip-copilot-github-actions-deploy',
          assumedBy: new iam.AccountRootPrincipal().withConditions({
            StringEquals: { 'aws:PrincipalArn': githubActionsUser.userArn },
          }),
        });

        githubActionsRole.grantAssumeRole(githubActionsUser);

        // Authorize session tagging for CI role assumption
        githubActionsRole.assumeRolePolicy?.addStatements(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['sts:TagSession'],
            principals: [new iam.AccountRootPrincipal()],
            conditions: {
              StringEquals: { 'aws:PrincipalArn': githubActionsUser.userArn },
            },
          }),
        );

        githubActionsUser.addToPolicy(
          new iam.PolicyStatement({
            actions: ['sts:TagSession'],
            resources: [githubActionsRole.roleArn],
          }),
        );

        this.githubActionsUser = githubActionsUser;
      }

      // Attach least-privilege deployment permissions
      const attachDeployPermissions = (target: iam.Role | iam.User) => {
        target.addToPolicy(
          new iam.PolicyStatement({
            actions: ['sts:AssumeRole', 'sts:TagSession'],
            resources: [`arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:role/cdk-*`],
          }),
        );

        target.addToPolicy(
          new iam.PolicyStatement({
            actions: [
              'cloudformation:DescribeStacks',
              'sts:GetCallerIdentity',
              'ecr:GetAuthorizationToken',
            ],
            resources: ['*'],
          }),
        );

        this.staticSiteBucket.grantReadWrite(target);

        target.addToPolicy(
          new iam.PolicyStatement({
            actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
            resources: [
              `arn:${cdk.Aws.PARTITION}:cloudfront::${cdk.Aws.ACCOUNT_ID}:distribution/${this.distribution.distributionId}`,
            ],
          }),
        );
      };

      attachDeployPermissions(githubActionsRole);
      if (this.githubActionsUser) {
        attachDeployPermissions(this.githubActionsUser);
      }

      this.githubActionsRole = githubActionsRole;
    }

    // 6. CfnOutput Exports
    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'The CloudFront distribution URL',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'The CloudFront distribution ID',
    });

    new cdk.CfnOutput(this, 'StaticSiteBucketName', {
      value: this.staticSiteBucket.bucketName,
      description: 'The S3 bucket name for static site assets',
    });

    new cdk.CfnOutput(this, 'AppDataBucketName', {
      value: this.appDataBucket.bucketName,
      description: 'The S3 bucket name for application data',
    });

    new cdk.CfnOutput(this, 'LambdaFunctionUrl', {
      value: this.functionUrl.url,
      description: 'The Fastify Lambda function URL',
    });

    if (this.githubActionsUser) {
      new cdk.CfnOutput(this, 'GitHubActionsUserName', {
        value: this.githubActionsUser.userName,
        description: 'The GitHub Actions deploy IAM user name',
      });
    }

    if (this.githubActionsRole) {
      new cdk.CfnOutput(this, 'GitHubActionsRoleArn', {
        value: this.githubActionsRole.roleArn,
        description: 'The GitHub Actions deploy IAM role ARN',
      });
    }
  }
}
