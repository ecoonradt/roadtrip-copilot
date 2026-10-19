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
}

export class RoadtripCopilotCloudStack extends cdk.Stack {
  public readonly staticSiteBucket: s3.Bucket;
  public readonly appDataBucket: s3.Bucket;
  public readonly fastifyApiFunction: lambda.DockerImageFunction;
  public readonly functionUrl: lambda.FunctionUrl;
  public readonly distribution: cloudfront.Distribution;
  public readonly githubActionsUser?: iam.User;
  public readonly githubActionsRole?: iam.Role;

  constructor(scope: Construct, id: string, props?: RoadtripCopilotCloudStackProps) {
    super(scope, id, props);

    // 1. StaticSiteBucket (S3 Bucket)
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
      },
    });

    // Lambda Function URL (Streaming)
    this.functionUrl = this.fastifyApiFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    // Grant AppDataBucket read/write access to FastifyApiFunction
    this.appDataBucket.grantReadWrite(this.fastifyApiFunction);

    // 4. CloudFrontDistribution (Distribution)
    this.distribution = new cloudfront.Distribution(this, 'CloudFrontDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.staticSiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.FunctionUrlOrigin(this.functionUrl, {
            readTimeout: cdk.Duration.seconds(60),
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // 5. GitHubActionsDeployRole & DeployUser (IAM Deployer compliant with AWS Project SCPs)
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
        this.githubActionsUser = githubActionsUser;
      }

      // Attach least-privilege deployment permissions
      const attachDeployPermissions = (target: iam.Role | iam.User) => {
        target.addToPolicy(
          new iam.PolicyStatement({
            actions: ['sts:AssumeRole'],
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
