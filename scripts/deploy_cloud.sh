#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# 1. Check required tools in PATH
if ! command -v aws >/dev/null 2>&1; then
  echo "Error: 'aws' CLI is not found in PATH." >&2
  echo "Please install and configure the AWS CLI before running this deployment script." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: 'docker' is not found in PATH." >&2
  echo "AWS CDK DockerImageFunction requires Docker to build and package the Fastify container." >&2
  echo "Please install or start Docker before running this script." >&2
  exit 1
fi

# 2. Verify AWS CLI authentication and resolve selected Region
echo "Verifying AWS authentication..."
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "Error: Unable to authenticate with AWS via 'aws sts get-caller-identity'." >&2
  echo "Please ensure your AWS credentials are valid and active." >&2
  exit 1
fi

AWS_REGION="${AWS_REGION:-${CDK_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
if [ -z "$AWS_REGION" ]; then
  echo "Error: AWS region is not set." >&2
  echo "Please set AWS_REGION environment variable or configure region in ~/.aws/config per AWS project-based rules." >&2
  exit 1
fi

export AWS_REGION
export CDK_DEFAULT_REGION="$AWS_REGION"
echo "Deploying to AWS Region: $AWS_REGION"

export ALLOWED_HOSTS="${ALLOWED_HOSTS:-}"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
if [ -n "${ORIGIN_VERIFY_SECRET:-}" ]; then
  export ORIGIN_VERIFY_SECRET
fi

# 3. Build React Web Studio
echo "Building Route Builder Web Studio..."
cd "$ROOT_DIR/route-builder"
npm run build

# 4. Deploy AWS CDK Stack
echo "Deploying AWS CDK Stack..."
cd "$ROOT_DIR/infra"
npx cdk deploy --require-approval never --outputs-file cdk-outputs.json

# 5. Parse CDK Outputs
OUTPUTS_FILE="$ROOT_DIR/infra/cdk-outputs.json"
if [ ! -f "$OUTPUTS_FILE" ]; then
  echo "Error: CDK outputs file not found at $OUTPUTS_FILE" >&2
  exit 1
fi

eval "$(node -e "
const fs = require('fs');
const outputs = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const all = Object.assign({}, ...Object.values(outputs));
console.log('STATIC_BUCKET=' + JSON.stringify(all.StaticSiteBucketName || ''));
console.log('DISTRIBUTION_ID=' + JSON.stringify(all.DistributionId || ''));
console.log('CLOUDFRONT_URL=' + JSON.stringify(all.CloudFrontUrl || ''));
console.log('LAMBDA_FUNCTION_URL=' + JSON.stringify(all.LambdaFunctionUrl || ''));
console.log('GITHUB_USER_NAME=' + JSON.stringify(all.GitHubActionsUserName || ''));
console.log('GITHUB_ROLE_ARN=' + JSON.stringify(all.GitHubActionsRoleArn || ''));
" "$OUTPUTS_FILE")"

if [ -z "$STATIC_BUCKET" ] || [ -z "$DISTRIBUTION_ID" ] || [ -z "$CLOUDFRONT_URL" ]; then
  echo "Error: Failed to parse required outputs (StaticSiteBucketName, DistributionId, CloudFrontUrl) from $OUTPUTS_FILE." >&2
  exit 1
fi

# 6. Sync frontend assets to S3
echo "Syncing frontend assets to S3 (s3://${STATIC_BUCKET}/)..."
aws s3 sync "$ROOT_DIR/route-builder/dist/" "s3://${STATIC_BUCKET}/" --delete --region "$AWS_REGION"

# 7. Invalidate CloudFront cache
echo "Creating CloudFront cache invalidation for distribution ${DISTRIBUTION_ID}..."
aws cloudfront create-invalidation --distribution-id "${DISTRIBUTION_ID}" --paths "/*"

# 8. Live HTTP smoke check against CloudFront /api/health
echo "Executing live smoke check against ${CLOUDFRONT_URL}/api/health..."
HEALTH_URL="${CLOUDFRONT_URL%/}/api/health"
MAX_ATTEMPTS=6 # 1 initial attempt + up to 5 retries (per WP-00 spec)
RETRY_DELAY=5
SUCCESS=false

for i in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "Attempt $i/$MAX_ATTEMPTS: curling $HEALTH_URL"
  BODY=$(curl -fsS "$HEALTH_URL" 2>/dev/null || true)
  if echo "$BODY" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    echo "Health check succeeded! Response: $BODY"
    SUCCESS=true
    break
  fi
  if [ "$i" -lt "$MAX_ATTEMPTS" ]; then
    echo "Waiting ${RETRY_DELAY}s before retrying (retry $i of $((MAX_ATTEMPTS - 1)))..."
    sleep "$RETRY_DELAY"
  fi
done

if [ "$SUCCESS" != true ]; then
  echo "Error: Health check failed against $HEALTH_URL after $MAX_ATTEMPTS attempts (initial + 5 retries)." >&2
  echo "Last attempt details:" >&2
  curl -fsS -v "$HEALTH_URL" >&2 || true
  exit 1
fi

# 9. Print deployment summary & post to GitHub Step Summary if present
echo ""
echo "================ Deployment Summary ================"
echo "CloudFront URL:          $CLOUDFRONT_URL"
echo "Lambda Function URL:     $LAMBDA_FUNCTION_URL"
echo "Static Site Bucket:      $STATIC_BUCKET"
echo "GitHub Actions IAM User: ${GITHUB_USER_NAME:-None}"
echo "GitHub Actions Role ARN: ${GITHUB_ROLE_ARN:-None}"
echo "Region:                  $AWS_REGION"
echo "====================================================="

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat <<EOF >> "$GITHUB_STEP_SUMMARY"
### 🚀 Roadtrip Co-Pilot Cloud Deployment

| Resource | Value |
| --- | --- |
| **CloudFront URL** | [$CLOUDFRONT_URL]($CLOUDFRONT_URL) |
| **Lambda Function URL** | \`$LAMBDA_FUNCTION_URL\` |
| **Static Site Bucket** | \`$STATIC_BUCKET\` |
| **GitHub Actions IAM User** | \`${GITHUB_USER_NAME:-None}\` |
| **GitHub Actions Role ARN** | \`${GITHUB_ROLE_ARN:-None}\` |
| **Region** | \`$AWS_REGION\` |
EOF
fi

