#!/usr/bin/env bash
# scripts/bootstrap_ci_oidc.sh
#
# Day-0 Bootstrapping Script: Configures keyless GitHub Actions OIDC federation and
# provisions the scoped deployment IAM role outside of the CloudFormation application stack.
#
# Usage:
#   ./scripts/bootstrap_ci_oidc.sh [GITHUB_REPO] [AWS_REGION]
#
# Example:
#   ./scripts/bootstrap_ci_oidc.sh ecoonradt/roadtrip-copilot us-east-2
#
set -euo pipefail

GITHUB_REPO="${1:-${GITHUB_REPO:-ecoonradt/roadtrip-copilot}}"
AWS_REGION="${2:-${AWS_REGION:-${CDK_DEFAULT_REGION:-us-east-2}}}"
ROLE_NAME="roadtrip-copilot-github-actions-deploy"
POLICY_NAME="RoadtripCopilotDeployerPolicy"

echo "=== Roadtrip Co-Pilot CI/CD OIDC Bootstrapper ==="
echo "Target GitHub Repository: $GITHUB_REPO"
echo "Target AWS Region:        $AWS_REGION"
echo "Deploy IAM Role Name:     $ROLE_NAME"

# 1. Verify AWS CLI & Caller Identity
if ! command -v aws >/dev/null 2>&1; then
  echo "Error: 'aws' CLI is required but not installed." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: 'jq' is required but not installed." >&2
  exit 1
fi

IDENTITY=$(aws sts get-caller-identity --output json)
ACCOUNT_ID=$(echo "$IDENTITY" | jq -r '.Account')
CALLER_ARN=$(echo "$IDENTITY" | jq -r '.Arn')
PARTITION=$(echo "$CALLER_ARN" | cut -d':' -f2)

echo "Authenticated as:         $CALLER_ARN"
echo "AWS Account ID:           $ACCOUNT_ID (partition: $PARTITION)"

# 2. Idempotently ensure GitHub OIDC Provider exists
OIDC_PROVIDER_URL="token.actions.githubusercontent.com"
OIDC_PROVIDER_ARN="arn:${PARTITION}:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER_URL}"

echo "Checking GitHub OIDC Provider ($OIDC_PROVIDER_ARN)..."
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_PROVIDER_ARN" >/dev/null 2>&1; then
  echo "✓ GitHub OIDC Provider already exists."
else
  echo "Creating GitHub OIDC Provider..."
  # Standard GitHub Actions thumbprints
  aws iam create-open-id-connect-provider \
    --url "https://${OIDC_PROVIDER_URL}" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aea1" "1c587610272c7a0328ff488e00248070b181fed"
  echo "✓ Created GitHub OIDC Provider: $OIDC_PROVIDER_ARN"
fi

# 3. Build AssumeRole trust policy supporting both classic and immutable ID claim formats
OWNER=$(echo "$GITHUB_REPO" | cut -d'/' -f1)
REPO=$(echo "$GITHUB_REPO" | cut -d'/' -f2)

TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "${OIDC_PROVIDER_ARN}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_PROVIDER_URL}:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "${OIDC_PROVIDER_URL}:sub": [
            "repo:${GITHUB_REPO}:*",
            "repo:${OWNER}@*/${REPO}@*:*"
          ]
        }
      }
    }
  ]
}
EOF
)

# 4. Create or update IAM deploy role
echo "Checking IAM role ($ROLE_NAME)..."
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "Role $ROLE_NAME exists. Updating assume role trust policy..."
  aws iam update-assume-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-document "$TRUST_POLICY"
  echo "✓ Updated trust policy on $ROLE_NAME"
else
  echo "Creating IAM role $ROLE_NAME..."
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "GitHub Actions keyless OIDC deployer role for Roadtrip Co-Pilot"
  echo "✓ Created IAM role $ROLE_NAME"
fi

ROLE_ARN="arn:${PARTITION}:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

# 5. Attach least-privilege inline permissions
DEPLOY_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeCdkDeploymentRoles",
      "Effect": "Allow",
      "Action": [
        "sts:AssumeRole",
        "sts:TagSession"
      ],
      "Resource": "arn:${PARTITION}:iam::${ACCOUNT_ID}:role/cdk-*"
    },
    {
      "Sid": "CdkCliDiscoveryAndEcrAuth",
      "Effect": "Allow",
      "Action": [
        "cloudformation:DescribeStacks",
        "sts:GetCallerIdentity",
        "ecr:GetAuthorizationToken"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EcrPublicAuthenticatedPull",
      "Effect": "Allow",
      "Action": [
        "ecr-public:GetAuthorizationToken",
        "sts:GetServiceBearerToken"
      ],
      "Resource": "*"
    },
    {
      "Sid": "StaticSiteBucketDeployment",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject*",
        "s3:GetBucket*",
        "s3:List*",
        "s3:DeleteObject*",
        "s3:PutObject",
        "s3:PutObjectLegalHold",
        "s3:PutObjectRetention",
        "s3:PutObjectTagging",
        "s3:PutObjectVersionTagging",
        "s3:Abort*"
      ],
      "Resource": [
        "arn:${PARTITION}:s3:::*roadtrip*static*",
        "arn:${PARTITION}:s3:::*roadtrip*static*/*",
        "arn:${PARTITION}:s3:::roadtripcopilotcloudstack-staticsitebucket*",
        "arn:${PARTITION}:s3:::roadtripcopilotcloudstack-staticsitebucket*/*"
      ]
    },
    {
      "Sid": "CloudFrontCacheInvalidation",
      "Effect": "Allow",
      "Action": [
        "cloudfront:CreateInvalidation",
        "cloudfront:GetInvalidation"
      ],
      "Resource": "arn:${PARTITION}:cloudfront::${ACCOUNT_ID}:distribution/*"
    },
    {
      "Sid": "ManageSsmParameters",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:PutParameter"
      ],
      "Resource": "arn:${PARTITION}:ssm:*:${ACCOUNT_ID}:parameter/roadtrip-copilot/*"
    },
    {
      "Sid": "KmsDecryptSsmParameters",
      "Effect": "Allow",
      "Action": [
        "kms:Decrypt",
        "kms:Encrypt",
        "kms:GenerateDataKey"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "kms:ViaService": "ssm.${AWS_REGION}.amazonaws.com"
        }
      }
    }
  ]
}
EOF
)

echo "Applying inline deployment policy ($POLICY_NAME)..."
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document "$DEPLOY_POLICY"
echo "✓ Inline policy applied."

echo ""
echo "=== Bootstrap Complete ==="
echo "Deployment Role ARN: $ROLE_ARN"
echo ""
echo "Next steps for GitHub repository setup:"
echo "1. In GitHub repo ($GITHUB_REPO), navigate to Settings -> Secrets and variables -> Actions -> Variables"
echo "2. Add or update repository variable 'AWS_ROLE_ARN' with value: $ROLE_ARN"
echo "3. Add or update repository variable 'AWS_REGION' with value: $AWS_REGION"
