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
  originVerifySecretSsmParam?: string;
  allowedHosts?: string;
  publicBaseUrl?: string;
  originVerifySecret?: string;
  googlePlacesApiKey?: string;
  googlePlacesApiKeySsmParam?: string;
  braveSearchApiKey?: string;
  braveSearchApiKeySsmParam?: string;
  bedrockScoutModelId?: string;
  bedrockCopywriterModelId?: string;
}

export const DEFAULT_BEDROCK_SCOUT_MODEL_ID = 'us.moonshotai.kimi-k3';
export const DEFAULT_BEDROCK_COPYWRITER_MODEL_ID = 'us.amazon.nova-2-lite-v1:0';

export class RoadtripCopilotCloudStack extends cdk.Stack {
  public readonly staticSiteBucket: s3.Bucket;
  public readonly appDataBucket: s3.Bucket;
  public readonly fastifyApiFunction: lambda.DockerImageFunction;
  public readonly functionUrl: lambda.FunctionUrl;
  public readonly distribution: cloudfront.Distribution;
  public readonly apiForwardedHostFunction: cloudfront.Function;
  public readonly githubActionsRole?: iam.Role;

  constructor(scope: Construct, id: string, props?: RoadtripCopilotCloudStackProps) {
    super(scope, id, props);

    // Validate SSM parameter path prefixes to match IAM execution role boundaries
    const ssmProps: Record<string, string | undefined> = {
      googleClientIdSsmParam: props?.googleClientIdSsmParam,
      googleClientSecretSsmParam: props?.googleClientSecretSsmParam,
      jwtSecretSsmParam: props?.jwtSecretSsmParam,
      allowedEmailsSsmParam: props?.allowedEmailsSsmParam,
      publicBaseUrlSsmParam: props?.publicBaseUrlSsmParam,
      originVerifySecretSsmParam: props?.originVerifySecretSsmParam,
      googlePlacesApiKeySsmParam: props?.googlePlacesApiKeySsmParam,
      braveSearchApiKeySsmParam: props?.braveSearchApiKeySsmParam,
    };

    for (const [propName, paramPath] of Object.entries(ssmProps)) {
      if (
        paramPath !== undefined &&
        (!/^\/roadtrip-copilot\/[A-Za-z0-9_.\-/]+$/.test(paramPath) ||
          paramPath.includes('..') ||
          paramPath.includes('//'))
      ) {
        throw new Error(
          `Invalid SSM parameter path "${paramPath}" for ${propName}. All SSM parameter paths must start with "/roadtrip-copilot/" and contain only valid parameter characters without path traversal.`,
        );
      }
    }

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
        ...(props?.publicBaseUrlSsmParam ? { PUBLIC_BASE_URL_SSM_PARAM: props.publicBaseUrlSsmParam } : {}),
        ORIGIN_VERIFY_SECRET_SSM_PARAM: props?.originVerifySecretSsmParam ?? '/roadtrip-copilot/origin-verify-secret',
        ALLOWED_HOSTS: props?.allowedHosts ?? '',
        PUBLIC_BASE_URL: props?.publicBaseUrl ?? '',
        ...(props?.originVerifySecret ? { ORIGIN_VERIFY_SECRET: props.originVerifySecret } : {}),
        GOOGLE_PLACES_API_KEY: props?.googlePlacesApiKey ?? '',
        GOOGLE_PLACES_API_KEY_SSM_PARAM: props?.googlePlacesApiKeySsmParam ?? '/roadtrip-copilot/google-places-api-key',
        BRAVE_SEARCH_API_KEY: props?.braveSearchApiKey ?? '',
        BRAVE_SEARCH_API_KEY_SSM_PARAM: props?.braveSearchApiKeySsmParam ?? '/roadtrip-copilot/brave-search-api-key',
        BEDROCK_SCOUT_MODEL_ID: props?.bedrockScoutModelId || DEFAULT_BEDROCK_SCOUT_MODEL_ID,
        BEDROCK_COPYWRITER_MODEL_ID: props?.bedrockCopywriterModelId || DEFAULT_BEDROCK_COPYWRITER_MODEL_ID,
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

    // Grant least-privilege Amazon Bedrock permissions for model invocation (ADR-0001, ADR-0010)
    this.fastifyApiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:${cdk.Aws.PARTITION}:bedrock:*::foundation-model/*`,
          `arn:${cdk.Aws.PARTITION}:bedrock:*:${this.account}:inference-profile/*`,
        ],
      }),
    );

    // Read-only control-plane calls for dynamic model availability (ADR-0010, ADR-0011). These list/describe
    // actions do not support resource-level scoping, so they are isolated from the invoke actions.
    this.fastifyApiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:GetFoundationModelAvailability',
          'bedrock:ListInferenceProfiles',
          'bedrock:ListFoundationModels',
        ],
        resources: ['*'],
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
    // Preserves CloudFront viewer host without introducing CloudFormation circular dependencies.
    // Note: CloudFront Functions forbid mutating 'x-forwarded-proto' (read-only/reserved header in viewer request).
    const apiForwardedHostFunction = new cloudfront.Function(this, 'ApiForwardedHostFunction', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  if (request.headers && request.headers.host && request.headers.host.value) {
    request.headers['x-forwarded-host'] = { value: request.headers.host.value };
  }
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
              'x-copilot-origin-verify':
                props?.originVerifySecret ||
                process.env.ORIGIN_VERIFY_SECRET ||
                `{{resolve:ssm:${props?.originVerifySecretSsmParam ?? '/roadtrip-copilot/origin-verify-secret'}}}`,
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

    // 6. GitHubActionsDeployRole (Keyless IAM Deployer via GitHub Actions OIDC)
    const githubRepo = props?.githubRepo ?? 'ecoonradt/roadtrip-copilot';
    if (githubRepo) {
      const oidcProviderArn =
        props?.githubOidcProviderArn ??
        `arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com`;

      const oidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
        this,
        'GitHubOidcProvider',
        oidcProviderArn,
      );

      const [owner, repo] = githubRepo.split('/');
      const subConditions =
        owner && repo
          ? [`repo:${githubRepo}:*`, `repo:${owner}@*/${repo}@*:*`]
          : [`repo:${githubRepo}:*`];

      const githubActionsRole = new iam.Role(this, 'GitHubActionsDeployRole', {
        roleName: 'roadtrip-copilot-github-actions-deploy',
        assumedBy: new iam.WebIdentityPrincipal(oidcProvider.openIdConnectProviderArn, {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub': subConditions,
          },
        }),
      });

      // Attach least-privilege deployment permissions
      const attachDeployPermissions = (target: iam.Role) => {
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

        // Authenticated Amazon ECR Public pulls for the container build (ADR-0009).
        // Anonymous `public.ecr.aws` pulls share a non-adjustable monthly data quota per
        // source IP, which GitHub-hosted runners exhaust collectively, failing the
        // `DockerImageFunction` asset build with "429 Too Many Requests".
        target.addToPolicy(
          new iam.PolicyStatement({
            actions: ['ecr-public:GetAuthorizationToken', 'sts:GetServiceBearerToken'],
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

        // Grant least-privilege permissions to read/write SSM parameters and KMS encryption/decryption
        target.addToPolicy(
          new iam.PolicyStatement({
            actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:PutParameter'],
            resources: [
              `arn:${cdk.Aws.PARTITION}:ssm:${this.region}:${this.account}:parameter/roadtrip-copilot/*`,
            ],
          }),
        );

        target.addToPolicy(
          new iam.PolicyStatement({
            actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'],
            resources: ['*'],
            conditions: {
              StringEquals: {
                'kms:ViaService': `ssm.${this.region}.amazonaws.com`,
              },
            },
          }),
        );
      };

      attachDeployPermissions(githubActionsRole);

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

    if (this.githubActionsRole) {
      new cdk.CfnOutput(this, 'GitHubActionsRoleArn', {
        value: this.githubActionsRole.roleArn,
        description: 'The GitHub Actions deploy IAM role ARN',
      });
    }
  }
}
