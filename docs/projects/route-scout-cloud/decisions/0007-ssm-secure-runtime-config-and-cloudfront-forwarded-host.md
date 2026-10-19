# ADR-0007: Runtime SSM SecureString Resolution and CloudFront Forwarded Host for OAuth2

* **Date:** 2026-10-19
* **Status:** Accepted
* **Deciders:** Eric, Antigravity
* **Related Work Package:** [WP-01-dual-mode-oidc-auth.md](../plan/active/WP-01-dual-mode-oidc-auth.md)

---

## 1. Context & Problem Statement
Implementing Milestone 1 (Stateless Dual-Mode Google OIDC Auth) on AWS Lambda behind CloudFront surfaces two infrastructure and runtime constraints:

1. **Secret Injection Under AWS Project SCP & CloudFormation:**
   * As documented in [ADR-0006](0006-aws-project-scp-iam-ci-deployer.md), the AWS Free Tier Project SCP (`Sid: DenySecurity`) blocks `secretsmanager:CreateSecret` while permitting AWS Systems Manager Parameter Store (`ssm:PutParameter` `SecureString`).
   * However, AWS CloudFormation explicitly forbids `{{resolve:ssm-secure:...}}` dynamic references inside `AWS::Lambda::Function` `Environment.Variables`.
   * Additionally, the AWS Lambda Web Adapter polls `GET /api/health` immediately during container initialization (`AWS_LWA_READINESS_CHECK_PATH=/api/health`). If the server crashes on startup before SSM parameters are populated, the Lambda function cannot initialize or pass smoke checks.

2. **Viewer Host Preservation Across CloudFront & Lambda Function URL:**
   * CloudFront routes `/api/*` to the Fastify Lambda Function URL using `OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER` because Lambda Function URLs reject requests whose `Host` header does not match `<url-id>.lambda-url.<region>.on.aws`.
   * Consequently, `request.headers.host` inside Fastify resolves to the internal `.lambda-url.<region>.on.aws` domain rather than the viewer's CloudFront domain (`d1xgc9hp77qmo9.cloudfront.net`).
   * Passing `distribution.distributionDomainName` into `FastifyApiFunction` environment variables is not possible because `CloudFrontDistribution` depends on `FunctionUrl`, which depends on `FastifyApiFunction`—creating a CloudFormation circular dependency.
   * Without the viewer's CloudFront hostname, `GET /api/auth/google` would construct a Google OAuth `redirect_uri` pointing to `.lambda-url.<region>.on.aws`, causing `Set-Cookie: copilot_session` to be scoped to the wrong domain.

## 2. Decision Drivers
* **100% Compliance with AWS Project SCPs & CloudFormation:** Must use SSM Parameter Store `SecureString` without triggering CloudFormation `ssm-secure` environment variable errors or `DenySecurity` SCP blocks.
* **Zero Circular Dependencies in AWS CDK:** `FastifyApiFunction` and `CloudFrontDistribution` must synthesize cleanly in a single stack.
* **Accurate OAuth2 Redirect URIs & Cookie Scoping:** Google OAuth2 callbacks and `copilot_session` cookies must stay strictly on the viewer's CloudFront origin (or `localhost:5173` in local Vite dev).
* **Resilient Lambda Web Adapter Startup:** `GET /api/health` must always succeed (`200 OK`) even before an operator populates SSM parameters in a fresh environment, while protected `/api/*` routes fail-closed (`401`/`503`) if `AUTH_ENABLED=true` and secrets are missing.

## 3. Considered Options
* **Option A: Store Plaintext Secrets in CDK Context / Lambda Env & Hardcode CloudFront Domain Post-Deploy:**
  * Exposes `GOOGLE_CLIENT_SECRET` and `JWT_SECRET` in plaintext CloudFormation templates and requires a two-pass deployment to hardcode the CloudFront domain.
* **Option B: Runtime SSM `SecureString` Resolution (`@aws-sdk/client-ssm`) + CloudFront `/api/*` `VIEWER_REQUEST` Header Function:**
  * Configure SSM parameter path environment variables (`/roadtrip-copilot/auth/*`) on `FastifyApiFunction` and grant least-privilege `ssm:GetParameter` / `ssm:GetParameters` + `kms:Decrypt` (via SSM) IAM permissions.
  * Load SSM parameters at runtime via `@aws-sdk/client-ssm` (`GetParametersCommand` with `WithDecryption: true`) with in-memory caching when direct env vars (`GOOGLE_CLIENT_SECRET`, `JWT_SECRET`, `GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS`) are not already set.
  * Attach a lightweight CloudFront Function on the `/api/*` behavior (`VIEWER_REQUEST`) that copies `event.request.headers.host.value` into `x-forwarded-host` and sets `x-forwarded-proto: https`, which `ALL_VIEWER_EXCEPT_HOST_HEADER` forwards intact to Fastify.

## 4. Decision Outcome
Chosen Option: **Option B (Runtime SSM `SecureString` Resolution + CloudFront `/api/*` `VIEWER_REQUEST` Header Function)**.

### Positive Consequences
* Secrets (`GOOGLE_CLIENT_SECRET`, `JWT_SECRET`) are encrypted at rest in SSM Parameter Store (`SecureString`) at `$0.00/month` and never appear in plaintext in CloudFormation templates or git.
* Updating `ALLOWED_EMAILS` or rotating secrets in SSM Parameter Store does not require re-synthesizing or redeploying the CDK stack.
* CloudFront forwards the exact viewer hostname in `x-forwarded-host` to Fastify on `/api/*` with sub-millisecond edge execution and zero CloudFormation circular dependencies.
* Local development (`npm run dev`) and Vitest suites continue using standard environment variables (`process.env.*`) with zero AWS SDK calls when `AUTH_ENABLED !== 'true'` or when direct env vars are supplied.

### Negative Consequences / Trade-offs
* Adds one cached `ssm:GetParameters` call (~30–50ms) on the first authenticated request during a Lambda cold start when secrets are resolved from SSM rather than direct env vars.

## 5. Implementation Notes & Code Touchpoints
* **CDK Stack (`infra/lib/roadtrip-cloud-stack.ts`):**
  * Sets `AUTH_ENABLED: 'true'` and SSM parameter names (`GOOGLE_CLIENT_ID_SSM_PARAM`, `GOOGLE_CLIENT_SECRET_SSM_PARAM`, `JWT_SECRET_SSM_PARAM`, `ALLOWED_EMAILS_SSM_PARAM`) on `FastifyApiFunction`.
  * Grants `ssm:GetParameter` and `ssm:GetParameters` on `arn:${cdk.Aws.PARTITION}:ssm:${this.region}:${this.account}:parameter/roadtrip-copilot/*` and `kms:Decrypt` via SSM service condition.
  * Attaches `ApiForwardedHostFunction` (`cloudfront.Function` on `VIEWER_REQUEST`) to `/api/*` cache behavior to populate `x-forwarded-host` and `x-forwarded-proto`.
* **Server Auth Config (`route-builder/server/services/authService.ts`):**
  * Resolves auth config from direct env vars first, falling back to cached `@aws-sdk/client-ssm` `GetParametersCommand({ WithDecryption: true })` when `AUTH_ENABLED === 'true'` in AWS Lambda.
  * Enforces a 15-minute in-memory configuration cache TTL (`CONFIG_CACHE_TTL_MS`) and a 30-second retry cooldown (`LOAD_RETRY_COOLDOWN_MS`) on resolution failures to prevent SSM throttling.

---

## 6. Trust Boundary Hardening & Future Custom Domain Architecture

### A. Edge-to-Origin Verification (`x-copilot-origin-verify`)
Because the Lambda Function URL has `AuthType: NONE` (invoked via CloudFront's `FunctionUrlOrigin`), a direct caller could attempt host header poisoning by supplying spoofed `x-forwarded-host` and `Host` headers.
1. CloudFront attaches a custom origin header (`x-copilot-origin-verify: roadtrip-copilot-edge`) on the `/api/*` `FunctionUrlOrigin`. Viewer requests cannot spoof custom origin headers because CloudFront automatically overrides them before forwarding.
2. In `AuthService.resolvePublicBaseUrl`:
   - If `x-copilot-origin-verify` matches `ORIGIN_VERIFY_SECRET` and `candidateHost` is syntactically valid, `candidateHost` is trusted (enforcing `https://` proto).
   - If origin verification is absent (direct calls or local dev), `candidateHost` is strictly validated against `SAFE_HOST_PATTERN` or `ALLOWED_HOSTS`.
   - `fallbackHost` (`Host` header) is always re-validated against `SAFE_HOST_PATTERN` or `ALLOWED_HOSTS`; if untrusted, it defaults to `localhost:3001`.

### B. Requirements for Future Custom Domain Support
When migrating from the default CloudFront domain (`*.cloudfront.net`) to a custom domain (e.g. `copilot.roadtrip.com`):
1. **AWS Certificate Manager (ACM):** Request/validate an ACM TLS certificate in `us-east-1` covering the custom domain (CloudFront strictly requires viewer certificates in `us-east-1`).
2. **CloudFront CNAME & Viewer Certificate:** In `infra/lib/roadtrip-cloud-stack.ts`, configure `domainNames: ['copilot.roadtrip.com']` and `certificate: acmCertificate` on `CloudFrontDistribution`.
3. **DNS Alias:** Create Route 53 `A` / `AAAA` Alias record (or third-party CNAME) pointing the custom domain to the CloudFront distribution domain.
4. **Auth / Host Resolution Zero-Code Guarantee:**
   - Because CloudFront passes `x-copilot-origin-verify: roadtrip-copilot-edge`, `AuthService.resolvePublicBaseUrl` automatically trusts the custom domain forwarded by CloudFront without requiring code modifications.
   - Operators can also configure `PUBLIC_BASE_URL` (or SSM `/roadtrip-copilot/public-base-url`) to fix the authoritative public base URL, and/or supply `ALLOWED_HOSTS: 'copilot.roadtrip.com'` for explicit host allowlisting.
5. **Google Cloud OAuth Console:** Register `https://copilot.roadtrip.com/api/auth/callback/google` in Authorized Redirect URIs and `https://copilot.roadtrip.com` in Authorized JavaScript Origins.
