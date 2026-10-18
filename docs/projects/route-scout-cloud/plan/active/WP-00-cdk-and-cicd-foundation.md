# Work Package WP-00: AWS CDK Foundation, Unified Deploy Scripts & GitHub Actions CI/CD

* **Milestone:** M0 — AWS CDK Foundation, Unified Deploy Scripts & GitHub Actions CI/CD
* **Status:** Approved — Ready for Execution
* **Governing ADRs:** [ADR-0003 (Amazon S3 Atomic JSON Persistence)](../../decisions/0003-s3-atomic-json-persistence.md), [ADR-0005 (AWS CDK IaC, GitHub Actions CI/CD & Continuous Deployment)](../../decisions/0005-cdk-iac-and-github-actions-cicd.md)

---

## 1. Objective & Explicit Non-Goals

### Objective
Establish the complete production infrastructure-as-code (`infra/` AWS CDK in TypeScript), container/Lambda packaging, unified verification and deployment scripts (`scripts/ci_check.sh` and `scripts/deploy_cloud.sh`), and GitHub Actions CI/CD workflows (`.github/workflows/ci.yml` and `.github/workflows/deploy.yml`) so that Roadtrip Co-Pilot can be deployed to AWS on-demand from either a local machine or GitHub Actions, verified on every push/PR, and manually tested live in AWS starting from Milestone 0.

### Explicit Non-Goals (Out of Scope for WP-00)
* **No Google OIDC Authentication Code Yet:** Dual-mode OIDC auth and `ALLOWED_EMAILS` gating belong to **Milestone 1 (`WP-01`)**. In M0, the deployed baseline stack serves the existing Route Builder Web Studio and `/api/health` + `/api/routing/*` + bundled sample itinerary so we can verify CloudFront $\to$ S3 and CloudFront $\to$ Lambda streaming end-to-end before adding auth gates in M1.
* **No S3 Application Code Changes Yet:** While M0 provisions the private `S3 App Data Bucket` in CDK, refactoring `ItineraryStorageService` to read/write S3 belongs to **Milestone 2 (`WP-02`)**.
* **No Bedrock Application Code Changes Yet:** Implementing `AwsBedrockHarnessAdapter` belongs to **Milestone 3 (`WP-03`)**.

---

## 2. Affected Files & Interfaces

### 1. Fastify Lambda Container Packaging (`route-builder/Dockerfile` & `.dockerignore`)
* **`route-builder/Dockerfile`**
  * Multi-stage Docker build:
    1. **Builder stage (`public.ecr.aws/docker/library/node:20-slim`):** Installs dependencies and runs `npm run build:server` (`dist-server/`).
    2. **Runtime stage (`public.ecr.aws/docker/library/node:20-slim`):**
       * Copies the official AWS Lambda Web Adapter binary (`COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4 /lambda-adapter /opt/extensions/lambda-adapter`).
       * Sets environment variables:
         * `PORT=3001`
         * `AWS_LWA_INVOKE_MODE=response_stream` (enables native SSE streaming over Lambda Function URLs)
         * `AWS_LWA_READINESS_CHECK_PATH=/api/health`
       * Copies production `node_modules`, `dist-server/`, and bundled `itineraries/sample_itinerary.json`.
       * Starts `node dist-server/index.js`.

### 2. AWS CDK Workspace (`infra/`)
A standalone, strict TypeScript AWS CDK v2 package at the repository root:
* **`infra/package.json`**
  * Scripts: `build` (`tsc`), `test` (`vitest run`), `synth` (`cdk synth`), `deploy` (`cdk deploy --require-approval never --outputs-file cdk-outputs.json`).
  * Dependencies: `aws-cdk-lib`, `constructs`.
  * DevDependencies: `aws-cdk`, `typescript`, `tsx`, `vitest`, `@types/node`.
* **`infra/tsconfig.json` & `infra/cdk.json`**
  * Configured with `"app": "npx tsx bin/infra.ts"`, strict TypeScript (`noImplicitAny: true`, `strictNullChecks: true`).
* **`infra/bin/infra.ts`**
  * Instantiates `RoadtripCopilotCloudStack` strictly in the project's assigned **selected Region** (`process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION`, never hardcoding a cross-Region fallback) and account (`process.env.CDK_DEFAULT_ACCOUNT`), passing optional context/env parameters (`githubRepo`, e.g., `owner/roadtrip-copilot`).
* **`infra/lib/roadtrip-cloud-stack.ts`**
  * Defines `RoadtripCopilotCloudStack` (compliant with AWS Project-Based SCPs/RCPs—all Regional resources in the selected Region, zero `Lambda@Edge`, and all custom IAM roles outside the protected `arn:*:iam::*:role/managed/*` namespace):
    1. **`StaticSiteBucket` (`s3.Bucket`):**
       * `blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL`, `encryption: s3.BucketEncryption.S3_MANAGED`.
       * Served exclusively via CloudFront Origin Access Control (OAC).
    2. **`AppDataBucket` (`s3.Bucket`):**
       * `blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL`, `encryption: s3.BucketEncryption.S3_MANAGED`, `versioned: false`.
       * Holds `users/{email}/itineraries/*.json` and `users/{email}/wallet.json` (used starting in M2).
    3. **`FastifyApiFunction` (`lambda.DockerImageFunction`):**
       * Built from `../route-builder` (`Dockerfile`), architecture `lambda.Architecture.X86_64`, memory `512 MB`, timeout `Duration.minutes(5)`.
       * Environment variables: `NODE_ENV=production`, `PORT=3001`, `AWS_LWA_INVOKE_MODE=response_stream`, `S3_STORAGE_BUCKET=appDataBucket.bucketName` (ready for M2).
       * Function URL configured with `authType: lambda.FunctionUrlAuthType.NONE` and `invokeMode: lambda.InvokeMode.RESPONSE_STREAM`.
    4. **`CloudFrontDistribution` (`cloudfront.Distribution`):**
       * **Default Behavior (`/*` $\to$ `S3BucketOrigin.withOriginAccessControl(staticSiteBucket)`):**
         * Viewer protocol policy: `REDIRECT_TO_HTTPS`, compression enabled, `index.html` default root object, custom error responses mapping `403`/`404` on non-`/api/*` paths to `/index.html` (`200 OK`) for React SPA routing.
       * **Additional Behavior (`/api/*` $\to$ `FunctionUrlOrigin`):**
         * `AllowedMethods.ALLOW_ALL`, `CachePolicy.CACHING_DISABLED`, `OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER` (forwards `Cookie`, `Authorization`, query strings, and headers to Fastify), `readTimeout: Duration.seconds(60)`.
    5. **Optional `GitHubActionsOidcRole` (`iam.Role` + `iam.OpenIdConnectProvider`):**
       * When `GITHUB_REPO` (e.g., `owner/roadtrip-copilot`) is provided, provisions (or references) the `token.actions.githubusercontent.com` OIDC provider and creates an IAM role assumable by GitHub Actions for keyless CDK & S3/CloudFront deployments.
    6. **`CfnOutput` Exports:**
       * `CloudFrontUrl` (`https://${distribution.distributionDomainName}`)
       * `DistributionId` (`distribution.distributionId`)
       * `StaticSiteBucketName` (`staticSiteBucket.bucketName`)
       * `AppDataBucketName` (`appDataBucket.bucketName`)
       * `LambdaFunctionUrl` (`fnUrl.url`)
       * `GitHubActionsRoleArn` (when configured)
* **`infra/test/roadtrip-cloud-stack.test.ts`**
  * Vitest assertion suite using `aws-cdk-lib/assertions` (`Template.fromStack`) verifying:
    * Both S3 buckets have `BlockPublicAccess` enabled.
    * Lambda function has `InvokeMode: RESPONSE_STREAM` Function URL and `AWS_LWA_INVOKE_MODE: response_stream`.
    * CloudFront distribution routes `/api/*` with `CachingDisabled` and `AllViewerExceptHostHeader` origin request policy.

### 3. Unified Verification & Deployment Scripts (`scripts/`)
* **`scripts/ci_check.sh`**
  * Runs the full verification pipeline locally or in CI:
    1. `route-builder`: `npm test` and `npm run build`.
    2. `infra`: `npm test` (CDK stack assertions) and `npx cdk synth --quiet` (verifies valid CloudFormation synthesis).
    3. Android (when Java/Android SDK is present or `--skip-android` is not passed): `./gradlew testDebugUnitTest`.
* **`scripts/deploy_cloud.sh`**
  * Single source of truth for on-demand local deployments and CI deployments:
    1. Verifies AWS CLI authentication (`aws sts get-caller-identity`) and resolves the project's **selected Region** (`AWS_REGION` / `aws configure get region`).
    2. Builds the React Web Studio (`cd route-builder && npm run build`).
    3. Runs `cd infra && npx cdk deploy --require-approval never --outputs-file cdk-outputs.json`.
    4. Parses `StaticSiteBucketName`, `DistributionId`, and `CloudFrontUrl` from `infra/cdk-outputs.json`.
    5. Syncs `route-builder/dist/` to `s3://${StaticSiteBucketName}/` (`aws s3 sync --delete`).
    6. Creates a CloudFront cache invalidation (`aws cloudfront create-invalidation --distribution-id "${DistributionId}" --paths "/*"`).
    7. Executes a live HTTP smoke check against `${CloudFrontUrl}/api/health` (retrying up to 5 times with backoff for initial propagation) and prints the live URL.

### 4. GitHub Actions Workflows (`.github/workflows/`)
* **`.github/workflows/ci.yml`**
  * Triggers on:
    * `push` (all branches)
    * `pull_request` (all branches)
  * Runs on `ubuntu-latest` with Node 20 and Java 17 caches, installs `route-builder` and `infra` dependencies, and executes `./scripts/ci_check.sh`.
* **`.github/workflows/deploy.yml`**
  * Triggers on:
    * `push` to `main` (automatic production deployment on merge)
    * `workflow_dispatch` (on-demand manual trigger from any branch in the GitHub Actions UI)
  * Steps:
    1. Runs `./scripts/ci_check.sh` to guarantee broken code is never deployed.
    2. Authenticates to AWS via `aws-actions/configure-aws-credentials@v4` using OIDC (`role-to-assume: ${{ vars.AWS_ROLE_ARN }}` in `${{ vars.AWS_REGION }}`).
    3. Runs `./scripts/deploy_cloud.sh` and publishes the live `CloudFrontUrl` to the GitHub Actions Job Summary.

### 5. Non-Project Living Documentation Updates
* Keep non-project docs synchronized in-flight:
  * [`docs/reference/directory-layout.md`](../../../../docs/reference/directory-layout.md) and [`AGENTS.md`](../../../../AGENTS.md) Section 4: Update directory layout and environment/build commands to include `infra/`, `.github/workflows/`, `./scripts/ci_check.sh`, and `./scripts/deploy_cloud.sh`.
  * [`README.md`](../../../../README.md), [`route-builder/AGENTS.md`](../../../../route-builder/AGENTS.md), [`route-builder/README.md`](../../../../route-builder/README.md), and [`docs/README.md`](../../../README.md): Document the CDK infrastructure directory, CI verification script, and cloud deployment commands.

---

## 3. Step-by-Step Tactical Steps

- [ ] **Step 1: Author Fastify Lambda Container Packaging (`route-builder/Dockerfile` & `.dockerignore`)**
  - Create multi-stage `route-builder/Dockerfile` with AWS Lambda Web Adapter (`0.8.4`), `AWS_LWA_INVOKE_MODE=response_stream`, and `/api/health` readiness check.
  - Create `route-builder/.dockerignore` excluding `node_modules`, `dist`, `dist-server`, and `tests`.
- [ ] **Step 2: Author AWS CDK Infrastructure Workspace (`infra/`) & CDK Unit Tests**
  - Initialize `infra/` with `package.json`, `tsconfig.json`, `cdk.json`, `bin/infra.ts`, `lib/roadtrip-cloud-stack.ts`, and `test/roadtrip-cloud-stack.test.ts`.
  - Install dependencies in `infra/` and verify `npm test` and `npx cdk synth` succeed cleanly.
- [ ] **Step 3: Author Unified Verification & Deployment Scripts (`scripts/ci_check.sh` & `scripts/deploy_cloud.sh`)**
  - Create executable `scripts/ci_check.sh` and `scripts/deploy_cloud.sh`.
  - Run `./scripts/ci_check.sh` locally to verify `route-builder` tests + build, Android unit tests, and `infra` CDK tests + `cdk synth` all pass.
- [ ] **Step 4: Author GitHub Actions Workflows & Sync Non-Project Documentation**
  - Create `.github/workflows/ci.yml` (push + PR verification) and `.github/workflows/deploy.yml` (`main` push + `workflow_dispatch` on-demand deployment).
  - Update [`AGENTS.md`](../../../../AGENTS.md), [`README.md`](../../../../README.md), [`route-builder/AGENTS.md`](../../../../route-builder/AGENTS.md), [`route-builder/README.md`](../../../../route-builder/README.md), and [`docs/README.md`](../../../README.md) with the new `infra/`, `.github/workflows/`, and `scripts/` documentation.
- [ ] **Step 5: GitHub Remote Switch, AWS CDK Bootstrap & First Live Deployment (Interactive with User)**
  - Point `git remote` to the new GitHub repository and push branch.
  - Once AWS CLI credentials are configured (`aws sts get-caller-identity`), run `npx cdk bootstrap` in `infra/`.
  - Execute `./scripts/deploy_cloud.sh` locally to deploy the stack to AWS.
  - Configure `AWS_ROLE_ARN` repository variable in GitHub and verify `.github/workflows/ci.yml` and on-demand `.github/workflows/deploy.yml` (`workflow_dispatch`).
- [ ] **Step 6: Manual Cloud Verification**
  - Verify `https://<cloudfront-domain>/api/health` returns `200 OK`.
  - Open `https://<cloudfront-domain>/` in a browser and confirm the Route Builder Web Studio loads over CloudFront, renders the sample itinerary on the map, and calculates OSRM routes via the Lambda backend.

---

## 4. Verification Plan

### Automated Verification Commands
```bash
./scripts/ci_check.sh
```
*(Which executes `cd route-builder && npm test && npm run build`, `cd infra && npm test && npx cdk synth`, and `./gradlew testDebugUnitTest`).*

### Live Deployment & Manual Cloud Verification Checklist
1. `./scripts/deploy_cloud.sh` completes `cdk deploy`, S3 static sync, CloudFront invalidation, and `/api/health` smoke check with exit code `0`.
2. Opening the output `CloudFrontUrl` in a browser loads the Route Builder Web Studio over HTTPS and proxies `/api/routing/route` and `/api/itineraries` through the AWS Lambda container.
3. GitHub Actions `ci.yml` passes on branch push, and `deploy.yml` succeeds via `workflow_dispatch`.

---

## 5. Discoveries & Deviations Log

* **2026-10-18 — Shift-Left Infrastructure & GitHub Migration ([ADR-0005](../../decisions/0005-cdk-iac-and-github-actions-cicd.md)):**
  * During Milestone 1 planning review, we identified that deferring AWS CDK, deployment scripting, and live manual verification to a final milestone left Milestones 1–4 unverified in the cloud.
  * **Adjustment:** Introduced **Milestone 0 (`WP-00-cdk-and-cicd-foundation.md`)** as the foundational first work package, decided to migrate from self-hosted Gitea to GitHub upfront for unified CI and keyless AWS OIDC federation, and updated `ROADMAP.md` so every milestone (M0–M4) requires CDK updates, live deployment (`./scripts/deploy_cloud.sh`), and manual cloud verification.

---

## 6. Next Session Handoff

* **Current State:** `ADR-0005`, `DECISIONS.md`, `ROADMAP.md`, `WORKING_MODEL.md`, and `WP-00-cdk-and-cicd-foundation.md` are approved and committed. Repository is being scrubbed for PII and migrated to GitHub prior to starting M0 execution.
* **Next Immediate Step:** Begin executing `WP-00-cdk-and-cicd-foundation.md`: delegate Steps 1–4 (`route-builder/Dockerfile` & `.dockerignore`, `infra/` CDK stack + unit tests, `scripts/ci_check.sh` + `scripts/deploy_cloud.sh`, `.github/workflows/ci.yml` + `deploy.yml`, and non-project living doc updates) to worker subagents per the active harness adapter, then proceed to Step 5 (`cdk bootstrap` + `./scripts/deploy_cloud.sh`) and Step 6 (manual CloudFront verification).
