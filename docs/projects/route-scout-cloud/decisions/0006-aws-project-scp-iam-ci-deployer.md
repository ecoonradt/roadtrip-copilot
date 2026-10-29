# ADR-0006: Scoped IAM CI Deployer Under AWS Project SCP (`DenyIAMRestrictedActions`)

* **Date:** 2026-10-18
* **Status:** Accepted
* **Deciders:** Eric, Antigravity
* **Related Work Package:** [WP-00-cdk-and-cicd-foundation.md](../plan/archive/WP-00-cdk-and-cicd-foundation.md)

---

## 1. Context & Problem Statement
During the first live deployment of `RoadtripCopilotCloudStack` (`./scripts/deploy_cloud.sh`) in Milestone 0, CloudFormation successfully built and pushed the Fastify container image to ECR and created the S3 buckets and CloudFront Origin Access Control, but failed on `GitHubOidcProvider` (`Custom::AWSCDKOpenIdConnectProvider`) with:

> `AccessDenied: ... is not authorized to perform: iam:CreateOpenIDConnectProvider on resource: arn:aws:iam::597787441620:oidc-provider/token.actions.githubusercontent.com with an explicit deny in a service control policy: arn:aws:organizations::882166532917:policy/o-n3a4nwcfi1/service_control_policy/p-xfrfnt7k`

Inspecting the AWS documentation for the new AWS project experience ([Managed policies for your organization](https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html)) revealed that the mandatory Service Control Policy (`p-xfrfnt7k`) includes statement `Sid: DenyIAMRestrictedActions`, which explicitly blocks `"iam:*Provider*"` (preventing `iam:CreateOpenIDConnectProvider`) unless the user permanently converts their account via "Activate advanced AWS features" at `settings.aws.com`.

Additionally, the Free Tier SCP (`Sid: DenySecurity`) blocks `secretsmanager:CreateSecret` while permitting AWS Systems Manager Parameter Store (`ssm:PutParameter` `SecureString`).

## 2. Decision Drivers
* **Preserve Standard AWS Project Experience & Free Tier Protections:** Avoid irreversibly converting the AWS project into a full multi-account AWS Organization at `settings.aws.com`, preserving simplified project management, spend-limit protections, and the $120 Free Tier credit balance.
* **Maintain Full GitHub Actions CI/CD Automation:** Support automated deployments on `main` branch merges and on-demand `workflow_dispatch` deployments in `.github/workflows/deploy.yml`.
* **Least-Privilege Security:** Restrict CI deployment credentials strictly to CDK stack deployment, S3 static asset sync, and CloudFront cache invalidation, with zero console login access (`iam:*LoginProfile*`).

## 3. Considered Options
* **Option 1: Scoped IAM CI Deployer in CDK (with Optional External OIDC Provider ARN):**
  * Replace default creation of `iam.OpenIdConnectProvider` with a dedicated machine IAM user (`roadtrip-copilot-github-actions-deployer`) and scoped deployment role (`roadtrip-copilot-github-actions-deploy`) that comply with `DenyIAMRestrictedActions` and project RCPs.
  * Store an access key for `roadtrip-copilot-github-actions-deployer` in GitHub Encrypted Secrets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) alongside repository variables (`AWS_ROLE_ARN`, `AWS_REGION`).
  * Retain opt-in OIDC support when `githubOidcProviderArn` is explicitly provided.
* **Option 2: Activate Advanced AWS Features at `settings.aws.com`:**
  * Removes the `DenyIAMRestrictedActions` SCP so `iam:CreateOpenIDConnectProvider` succeeds, but is permanent and irreversible.
* **Option 3: Local-Only Cloud Deployments (`./scripts/deploy_cloud.sh`):**
  * Remove CI deployment resources and deploy exclusively from a local terminal.

## 4. Decision Outcome
Chosen Option: **Option 1 (Scoped IAM CI Deployer in CDK with Optional External OIDC Provider ARN)** because it preserves the standard AWS project experience and Free Tier guardrails while keeping full GitHub Actions deployment automation (`deploy.yml`) with a tightly scoped blast radius.

### Positive Consequences
* `RoadtripCopilotCloudStack` deploys cleanly in standard AWS project accounts without triggering `DenyIAMRestrictedActions` (`iam:*Provider*`).
* Both automatic `main` deployments and manual `workflow_dispatch` runs in GitHub Actions work out of the box.
* Future milestones (M1+) will also use SSM Parameter Store (`ssm:*`) rather than Secrets Manager (`secretsmanager:CreateSecret`) to stay 100% compliant with the Free Tier SCP (`DenySecurity`).

### Negative Consequences / Trade-offs
* Requires storing `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for `roadtrip-copilot-github-actions-deployer` in GitHub Encrypted Secrets (and rotating them periodically) unless an external OIDC provider ARN is supplied.

## 5. Implementation Notes & Code Touchpoints
* **`infra/lib/roadtrip-cloud-stack.ts`:**
  * By default (when `githubOidcProviderArn` is not supplied), provisions `iam.User` (`roadtrip-copilot-github-actions-deployer`) and `iam.Role` (`roadtrip-copilot-github-actions-deploy`) without creating `iam.OpenIdConnectProvider`.
  * Grants least-privilege permissions for CDK bootstrap role assumption (`arn:*:iam::*:role/cdk-*`), `ecr:GetAuthorizationToken`, `cloudformation:DescribeStacks`, `sts:GetCallerIdentity`, `StaticSiteBucket` read/write sync, and `CloudFrontDistribution` cache invalidation.
  * Exports `GitHubActionsUserName` (`roadtrip-copilot-github-actions-deployer`) and `GitHubActionsRoleArn` in `CfnOutput`.
* **`.github/workflows/deploy.yml`:**
  * Passes `aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}`, `aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}`, `role-to-assume: ${{ vars.AWS_ROLE_ARN }}`, and `aws-region: ${{ vars.AWS_REGION }}` to `aws-actions/configure-aws-credentials@v4`.

## 6. Addendum (2026-10-23): Activation of Advanced Features & Keyless OIDC Roadmap
On 2026-10-23, the AWS account upgraded to Paid and activated Advanced Features, transitioning to a standard AWS account model with full AWS Organizations capabilities. This permanently lifted the `DenyIAMRestrictedActions` SCP that originally blocked `iam:CreateOpenIDConnectProvider`.

* **Current Status (Resolved):** Migrated to keyless GitHub Actions OIDC federation ([GitHub Issue #7](https://github.com/ecoonradt/roadtrip-copilot/issues/7)). 
  * The static IAM user `roadtrip-copilot-github-actions-deployer` has been deleted from AWS, and `.github/workflows/deploy.yml` authenticates keylessly with short-lived OIDC tokens.
  * Static GitHub repository secrets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) are deprecated and removed.
  * Day-0 bootstrapping for new AWS environments is managed via `scripts/bootstrap_ci_oidc.sh`, which provisions the OpenID Connect Provider (`token.actions.githubusercontent.com`) and the deployment IAM role (`roadtrip-copilot-github-actions-deploy`) with dual-format GitHub subject matching (`repo:org/repo:*` and `repo:owner@id/repo@id:*`).
  * In `RoadtripCopilotCloudStack`, `GitHubActionsDeployRole` is marked with `applyRemovalPolicy(cdk.RemovalPolicy.RETAIN)` to prevent CloudFormation from deleting CI/CD deploy credentials during stack lifecycle decoupling.


