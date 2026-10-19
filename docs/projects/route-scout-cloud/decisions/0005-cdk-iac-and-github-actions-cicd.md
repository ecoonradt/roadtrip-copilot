# ADR-0005: AWS CDK Infrastructure-as-Code, GitHub Actions CI/CD, and Continuous Milestone Deployment

* **Date:** 2026-10-18
* **Status:** Accepted
* **Deciders:** Eric, Antigravity
* **Related Work Package:** [WP-00-cdk-and-cicd-foundation.md](../plan/archive/WP-00-cdk-and-cicd-foundation.md)

---

## 1. Context & Problem Statement
The original Phase 1 rollout sequence placed AWS deployment at the very end of the project (Step 5), after Auth (M1), S3 Persistence (M2), Bedrock AI (M3), and Grounding Tools (M4). In a real production system, deferring Infrastructure-as-Code (IaC), CI/CD automation, and live cloud verification until the final step creates severe integration risk: four milestones of code would only be validated against local mocks (`vitest`), leaving IAM permissions, CloudFront origin routing, cookie `SameSite`/`Secure` behavior, S3 bucket policies, and Lambda response streaming untested in AWS until the end.

Additionally, we need a conventional CI/CD pipeline (PR verification checks + automated deployment on merge to `main` + on-demand deployments from feature branches via both CI and local developer terminals) and must decide whether to configure CI on the existing self-hosted Gitea server or migrate to GitHub first.

## 2. Decision Drivers
* **Shift-Left Cloud Verification:** Every milestone (M0 through M4) must include its corresponding AWS CDK infrastructure changes, a live deployment to AWS, and manual verification against the deployed CloudFront URL.
* **Reproducible Infrastructure-as-Code:** All AWS resources (S3 buckets, Lambda container/function, CloudFront distribution, IAM roles, OIDC providers) must be declaratively managed in TypeScript via AWS CDK.
* **Local & CI Deployment Parity:** Deploying to AWS must work identically whether triggered on-demand from a local developer machine (`./scripts/deploy_cloud.sh` on an unmerged project branch), on-demand via GitHub Actions (`workflow_dispatch`), or automatically upon merging to `main`.
* **Single Setup for CI & Keyless AWS Auth:** Migrating to GitHub before wiring up CI runners, branch protection, and AWS IAM OIDC federation avoids configuring runners and secrets twice (once in Gitea, once in GitHub) and eliminates static long-lived AWS keys in CI.

## 3. Considered Options
* **Option A: Defer Deployment to Milestone 5 & Manual AWS Console Setup:** Fast to start coding M1, but accumulates unverified cloud integration risk across 4 milestones and leaves infrastructure unversioned.
* **Option B: Stay on Self-Hosted Gitea Now, Migrate to GitHub Later:** Works via `.github/workflows/` compatibility, but requires maintaining `act_runner` locally, using static IAM keys if Gitea OIDC isn't publicly federated with AWS IAM, and re-configuring secrets and branch rules upon GitHub migration.
* **Option C: Establish Milestone 0 (AWS CDK + GitHub Actions CI/CD + Unified Deploy Script) First & Require Live Deployment in Every Milestone:**
  * Migrate repository to GitHub upfront.
  * Create an `infra/` AWS CDK TypeScript workspace managing the full serverless stack (S3 static + data buckets, Fastify Lambda with Web Adapter response streaming, CloudFront distribution, and GitHub Actions OIDC IAM role).
  * Build unified scripts (`scripts/ci_check.sh` and `scripts/deploy_cloud.sh`) invoked by both developers locally and GitHub Actions (`ci.yml` on all pushes/PRs; `deploy.yml` on `main` merges and `workflow_dispatch`).
  * Make CDK updates, live deployment, and manual verification mandatory in the Definition of Done for every milestone (M0–M4), retiring the standalone late-stage M5 deployment milestone.

## 4. Decision Outcome
Chosen Option: **Option C (Milestone 0 CDK + GitHub Actions Foundation with Continuous Milestone Deployment)**.

### Positive Consequences
* Cloud infrastructure (CloudFront, Lambda streaming, S3, IAM) is proven live in **Milestone 0** before application complexity is layered on.
* Every milestone (M1 Auth, M2 S3, M3 Bedrock, M4 Tools) is deployed and manually verified in the real AWS environment before moving to the next milestone.
* Zero duplicated CI/CD setup work by migrating to GitHub first, with keyless AWS IAM OIDC authentication (`token.actions.githubusercontent.com`) for GitHub Actions.
* Feature branches can be deployed to AWS on-demand from either the local terminal (`./scripts/deploy_cloud.sh`) or GitHub Actions (`workflow_dispatch`) without premature merges to `main`.

### Negative Consequences / Trade-offs
* Adds a foundational Milestone 0 before starting M1 (Google OIDC Auth), requiring initial AWS account bootstrapping (`npx cdk bootstrap`) and GitHub remote switch.

## 5. Implementation Notes & Code Touchpoints
* **CDK Workspace:** `infra/` (`bin/infra.ts`, `lib/roadtrip-cloud-stack.ts`, `cdk.json`, `package.json`, `tsconfig.json`, `test/roadtrip-cloud-stack.test.ts`).
* **Fastify Lambda Packaging:** `route-builder/Dockerfile` (Node 20 slim + AWS Lambda Web Adapter extension with `AWS_LWA_INVOKE_MODE=response_stream` and `PORT=3001`).
* **Unified Scripts:**
  * `scripts/ci_check.sh`: Runs `route-builder` tests + build, Android unit tests (`./gradlew testDebugUnitTest`), and `infra` CDK tests + `cdk synth`.
  * `scripts/deploy_cloud.sh`: Builds `route-builder`, runs `cdk deploy`, syncs `route-builder/dist/` to the S3 static bucket, invalidates CloudFront, and runs a live `/api/health` smoke check.
* **GitHub Actions Workflows:**
  * `.github/workflows/ci.yml`: Triggers on `push` (all branches) and `pull_request`; blocks PRs on failure.
  * `.github/workflows/deploy.yml`: Triggers on `push` to `main` and `workflow_dispatch` (allowing on-demand branch deployment from GitHub UI).
