# Roadtrip Co-Pilot Cloud Infrastructure (`infra/`)

This directory contains the AWS Cloud Development Kit (CDK) infrastructure as code for the Roadtrip Co-Pilot serverless cloud stack (`RoadtripCopilotCloudStack`), targeting `us-east-2`.

## Architecture Overview

* **Static Hosting:** Amazon S3 bucket (`StaticSiteBucket`) fronted by Amazon CloudFront with Origin Access Control (OAC) and single-page application (SPA) client-side rewrite functions.
* **App Data Persistence:** Amazon S3 bucket (`AppDataBucket`) holding user itineraries with encryption and non-public access controls.
* **Backend API & Web Studio:** Containerized Node.js/Fastify server packaged via AWS Lambda Web Adapter (`DockerImageFunction`) with streaming HTTP response support.
* **Security & Auth:** SSM Parameter Store integration (`/roadtrip-copilot/*`) with KMS decryption, and origin verification header (`x-copilot-origin-verify`) between CloudFront and Lambda.
* **AI Engine:** Least-privilege Amazon Bedrock foundation model inference permissions (`us.moonshotai.kimi-k3` for Route Scout and `us.amazon.nova-2-lite-v1:0` for Copywriter).

---

## Day-0: Bootstrapping a New AWS Environment

When setting up Roadtrip Co-Pilot in a new or clean AWS account:

### 1. Prerequisites
* AWS CLI installed and configured with administrator credentials (`aws sts get-caller-identity`).
* Node.js 20+ and npm 9+.
* Docker running locally (for building the Lambda container image asset).

### 2. Bootstrap AWS CDK
Synthesize the CDK bootstrapping resources in the target account and region:
```bash
npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-2
```

### 3. Bootstrap CI/CD OIDC Federation & Deploy Role
Run the standalone bootstrap script to create the GitHub Actions OIDC Provider (`token.actions.githubusercontent.com`) and the scoped deployment IAM role (`roadtrip-copilot-github-actions-deploy`):
```bash
./scripts/bootstrap_ci_oidc.sh ecoonradt/roadtrip-copilot us-east-2
```
This script:
- Idempotently creates or verifies the IAM OpenID Connect Provider.
- Configures the assume-role trust policy with dual-format GitHub subject verification (matching both classic `repo:org/repo:*` and immutable ID format `repo:owner@id/repo@id:*`).
- Attaches the least-privilege `RoadtripCopilotDeployerPolicy` for CDK deployments, ECR Public container pulls, S3 static asset sync, CloudFront cache invalidation, and SSM parameter management.

### 4. Configure GitHub Repository Variables
In your GitHub repository settings (**Settings -> Secrets and variables -> Actions -> Variables**):
* Set `AWS_ROLE_ARN` = `arn:aws:iam::<ACCOUNT_ID>:role/roadtrip-copilot-github-actions-deploy`
* Set `AWS_REGION` = `us-east-2`

> **Note on GitHub Secrets:** Static `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` secrets are **not required**. Authentication is 100% keyless via short-lived OIDC web identity tokens.

---

## Day-1+: CI/CD & Local Development

### Automated GitHub Actions Deployments
Every push to `main` triggers `.github/workflows/deploy.yml`:
1. Requests an OIDC JSON Web Token (JWT) from GitHub Actions with `id-token: write`.
2. Assumes `roadtrip-copilot-github-actions-deploy` via `aws-actions/configure-aws-credentials@v4`.
3. Runs `./scripts/deploy_cloud.sh`, which compiles the web studio, deploys the CDK stack, syncs static assets to S3, invalidates CloudFront, and validates health via `/api/health`.

### Manual Cloud Deployment
To deploy manually from your workstation:
```bash
./scripts/deploy_cloud.sh
```

### Running Verification Tests
```bash
cd infra
npm test            # Run CDK Vitest unit tests
npx cdk synth       # Validate CloudFormation synthesis
```
