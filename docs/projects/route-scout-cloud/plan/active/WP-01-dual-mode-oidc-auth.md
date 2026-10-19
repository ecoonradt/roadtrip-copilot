# Work Package WP-01: Stateless Dual-Mode Google OIDC Auth & Allowlist Gating

* **Milestone:** M1 — Stateless Dual-Mode Google OIDC Auth & Allowlist Gating
* **Status:** In Progress (`feat/m1-dual-mode-oidc-auth`)
* **Governing ADRs:** [ADR-0002 (Stateless Dual-Mode Google OIDC Authentication)](../../decisions/0002-stateless-dual-mode-oidc-auth.md), [ADR-0004 (Hybrid Local Feature Development Mode)](../../decisions/0004-hybrid-local-dev-mode.md), [ADR-0005 (AWS CDK IaC, GitHub Actions CI/CD & Continuous Deployment)](../../decisions/0005-cdk-iac-and-github-actions-cicd.md), [ADR-0007 (Runtime SSM SecureString Resolution & CloudFront Forwarded Host)](../../decisions/0007-ssm-secure-runtime-config-and-cloudfront-forwarded-host.md)

---

## 1. Objective & Explicit Non-Goals

### Objective
Protect `/api/*` endpoints with zero-trust Google OpenID Connect (OIDC) authentication supporting both Web Browser sessions (`HTTP-Only` signed JWT cookies) and Android native clients (`Authorization: Bearer <jwt>` headers), gated by an `ALLOWED_EMAILS` admin allowlist, while preserving frictionless local development bypass when `AUTH_ENABLED !== 'true'`. Update the React Web Studio with a Google Sign-In / 403 Private Preview gate and header account controls, and update the AWS CDK stack (`infra/`) with SSM Parameter Store permissions, auth environment configuration, and CloudFront `/api/*` `x-forwarded-host` preservation.

### Explicit Non-Goals (Out of Scope for WP-01)
* **No S3 Itinerary Storage Refactor Yet:** Scoping `ItineraryStorageService` to `s3://<bucket>/users/{email}/itineraries/*.json` belongs to **Milestone 2 (`WP-02`)**.
* **No Amazon Bedrock AI Adapter Yet:** Implementing `AwsBedrockHarnessAdapter` belongs to **Milestone 3 (`WP-03`)**.
* **No Android Native App Kotlin Changes Yet:** Native Android Credential Manager sign-in UI belongs to Phase 2 (`docs/projects/android-route-client/`), though the backend `POST /api/auth/mobile/google` endpoint and Bearer JWT verification in `authGuard` are built and tested in this work package.

---

## 2. Affected Files & Interfaces

### 1. Backend Auth Types, Service, Hook & Routes (`route-builder/server/`)
* **`route-builder/package.json`**
  * Add dependencies: `@fastify/cookie`, `@fastify/jwt`, `@fastify/oauth2`, `google-auth-library`, `@aws-sdk/client-ssm`.
* **`route-builder/server/types/auth.ts`**
  * Defines strict TypeScript contracts:
    ```typescript
    export interface AuthUser {
      sub: string;
      email: string;
      name: string;
      picture?: string;
    }

    export interface AuthStatusResponse {
      authEnabled: boolean;
      authenticated: boolean;
      authorized: boolean;
      user: AuthUser | null;
      message?: string;
    }

    export interface MobileGoogleAuthRequest {
      idToken?: string;
      id_token?: string;
    }

    export interface MobileGoogleAuthResponse {
      token: string;
      user: AuthUser;
    }
    ```
  * Augments `FastifyRequest` with `authUser?: AuthUser`.
* **`route-builder/server/services/authService.ts`**
  * Encapsulates:
    * Runtime configuration & secret resolution: reads `AUTH_ENABLED`, `ALLOWED_EMAILS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `JWT_SECRET` from environment variables first, falling back to cached `@aws-sdk/client-ssm` (`GetParametersCommand` with `WithDecryption: true`) when SSM parameter paths (`*_SSM_PARAM`) are configured in AWS Lambda per [ADR-0007](../../decisions/0007-ssm-secure-runtime-config-and-cloudfront-forwarded-host.md).
    * Allowlist evaluation: `isEmailAllowed(email: string, allowedEmailsRaw: string): boolean` (case-insensitive comma/whitespace-delimited check; fails closed when `ALLOWED_EMAILS` is empty).
    * Session JWT signing and verification (`signSessionToken(user: AuthUser)`, `verifySessionToken(token: string)`) using HMAC-SHA256 with `JWT_SECRET`.
    * Stateless OAuth2 PKCE + `state` token signing/verification (`createOAuthChallenge()`, `verifyOAuthStateCookie(cookieToken, queryState)`) for CSRF and PKCE protection across stateless Lambda instances.
    * Public base URL resolution (`resolvePublicBaseUrl(request)`): respects `PUBLIC_BASE_URL`, `x-forwarded-proto` + `x-forwarded-host`, or `request.protocol` + `request.headers.host`.
    * Google OAuth2 authorization URL builder, authorization code exchange (`oauth2.googleapis.com/token`), and Google ID token verification via `google-auth-library` (`OAuth2Client.verifyIdToken`).
* **`route-builder/server/hooks/authGuard.ts`**
  * Fastify `preHandler` hook `createAuthGuard(authService)`:
    * When `authService.isAuthEnabled()` is `false` (`AUTH_ENABLED !== 'true'`): attaches deterministic local dev user (`{ sub: 'local-dev', email: 'local-dev@localhost', name: 'Local Developer' }`) and proceeds immediately (`<1ms`).
    * When `authService.isAuthEnabled()` is `true`:
      * Exempts `OPTIONS` preflight requests, `GET /api/health`, and `/api/auth/*` endpoints.
      * Extracts JWT from `request.cookies?.copilot_session` first, or `Authorization: Bearer <token>` header second.
      * Returns `HTTP 401 Unauthorized` if no token is present or if signature/expiration verification fails.
      * Returns `HTTP 403 Forbidden` (`{ error: 'Forbidden', message: 'Roadtrip Co-Pilot is in private preview. Your account is not on the authorized allowlist.' }`) if `user.email` is not in `ALLOWED_EMAILS`.
      * Attaches `request.authUser = user` on success.
* **`route-builder/server/routes/auth.ts`**
  * Registers `/api/auth/*` endpoints:
    * `GET /api/auth/status`: Returns `AuthStatusResponse` (`authEnabled`, `authenticated`, `authorized`, `user`, optional `message`).
    * `GET /api/auth/google`: Generates PKCE + `state`, sets `copilot_oauth_state` `HTTP-Only` cookie, and redirects (`302`) to Google OAuth2 authorization endpoint (`prompt=select_account`).
    * `GET /api/auth/callback/google`: Validates `state` and PKCE cookie, exchanges `code` for tokens, verifies Google `id_token` (`email_verified === true`), issues `copilot_session` `HTTP-Only`, `SameSite=Lax`, `Secure` (on HTTPS) cookie, and redirects to `/`.
    * `POST /api/auth/mobile/google`: Verifies Android native Google `id_token`, enforces `ALLOWED_EMAILS` (`403` if unauthorized, `401` if invalid token, `400` if missing), and returns `{ token, user }`.
    * `POST /api/auth/logout`: Clears `copilot_session` cookie and returns `{ success: true }`.
* **`route-builder/server/app.ts`**
  * Registers `@fastify/cookie`, `@fastify/jwt`, `@fastify/oauth2` compatibility/routes (`authRoutes`), and registers the `authGuard` `onRequest`/`preHandler` hook for `/api/*` routes.
* **`route-builder/vite.config.ts`**
  * Adds `xfwd: true` to `/api` proxy configuration so `x-forwarded-host` and `x-forwarded-proto` are passed in local development.

### 2. Frontend Auth Gate & Header Controls (`route-builder/src/`)
* **`route-builder/src/types/auth.ts`**
  * Frontend TypeScript interfaces (`AuthUser`, `AuthStatusResponse`).
* **`route-builder/src/services/api.ts`**
  * Adds `fetchAuthStatus(): Promise<AuthStatusResponse>` and `logoutAuth(): Promise<void>`.
* **`route-builder/src/components/AuthGateScreen.tsx`**
  * Clean, dark-automotive-themed authentication gate rendered when `authStatus.authEnabled` is `true` and the user is either:
    1. **Unauthenticated (`!authStatus.authenticated`):** Displays the Roadtrip Co-Pilot branding, explanation of private cloud access, and a **"Sign in with Google"** CTA button linking to `/api/auth/google`.
    2. **Unauthorized (`authStatus.authenticated && !authStatus.authorized` — `403` Private Preview):** Displays the `"Roadtrip Co-Pilot is in private preview"` message, shows the currently signed-in Google account (`user.email`), and provides a **"Sign Out / Switch Account"** button that invokes `POST /api/auth/logout` and redirects to `/api/auth/google`.
* **`route-builder/src/components/AppHeader.tsx` & `route-builder/src/App.tsx`**
  * `App.tsx` queries `fetchAuthStatus()` on mount alongside existing initialization (keeping optimistic initial state so existing unit tests and authenticated sessions experience zero waterfall delay).
  * When `authStatus.authEnabled && (!authStatus.authenticated || !authStatus.authorized)`, `App.tsx` renders `<AuthGateScreen />`.
  * `AppHeader.tsx` accepts optional `authUser?: AuthUser | null`, `authEnabled?: boolean`, and `onLogout?: () => void`, displaying a compact signed-in user badge (avatar/initial + email/name) and Sign Out button when `authEnabled && authUser` is present.

### 3. AWS CDK Infrastructure Updates (`infra/`)
* **`infra/lib/roadtrip-cloud-stack.ts` & `infra/bin/infra.ts`**
  * Extend `RoadtripCopilotCloudStackProps` with optional `authEnabled`, `allowedEmails`, `googleClientId`, `googleClientIdSsmParam`, `googleClientSecretSsmParam`, `jwtSecretSsmParam`, and `allowedEmailsSsmParam`.
  * Configure `FastifyApiFunction` environment variables:
    * `AUTH_ENABLED: props?.authEnabled ?? 'true'`
    * `ALLOWED_EMAILS: props?.allowedEmails ?? ''`
    * `GOOGLE_CLIENT_ID: props?.googleClientId ?? ''`
    * `GOOGLE_CLIENT_ID_SSM_PARAM: props?.googleClientIdSsmParam ?? '/roadtrip-copilot/google-client-id'`
    * `GOOGLE_CLIENT_SECRET_SSM_PARAM: props?.googleClientSecretSsmParam ?? '/roadtrip-copilot/google-client-secret'`
    * `JWT_SECRET_SSM_PARAM: props?.jwtSecretSsmParam ?? '/roadtrip-copilot/jwt-secret'`
    * `ALLOWED_EMAILS_SSM_PARAM: props?.allowedEmailsSsmParam ?? '/roadtrip-copilot/allowed-emails'`
  * Grant `FastifyApiFunction` IAM permissions for `ssm:GetParameter` and `ssm:GetParameters` on `arn:${cdk.Aws.PARTITION}:ssm:${this.region}:${this.account}:parameter/roadtrip-copilot/*` and `kms:Decrypt` via `ssm.${this.region}.amazonaws.com`.
  * Add `ApiForwardedHostFunction` (`cloudfront.Function` on `VIEWER_REQUEST`) to the `/api/*` CloudFront behavior so `x-forwarded-host` and `x-forwarded-proto` are preserved across `ALL_VIEWER_EXCEPT_HOST_HEADER`.
* **`infra/test/roadtrip-cloud-stack.test.ts`**
  * Add unit tests verifying:
    * `FastifyApiFunction` has `AUTH_ENABLED: 'true'` and SSM parameter environment variables.
    * `FastifyApiFunction` execution role has `ssm:GetParameter` and `ssm:GetParameters` permissions scoped to `/roadtrip-copilot/*`.
    * CloudFront `/api/*` behavior attaches `ApiForwardedHostFunction` on `viewer-request` and preserves `x-forwarded-host`.

### 4. Automated Test Suites (`route-builder/tests/`)
* **`route-builder/tests/backend/auth.test.ts`**
  * Comprehensive backend integration test suite covering:
    * Local dev bypass (`AUTH_ENABLED !== 'true'`): injects `local-dev@localhost`, allows `/api/itineraries`, `/api/routing/*`, etc., and `GET /api/auth/status` reports `authEnabled: false, authenticated: true, authorized: true`.
    * Protected `/api/*` enforcement (`AUTH_ENABLED === 'true'`):
      * `GET /api/health` remains public (`200 OK`).
      * Unauthenticated requests to `/api/itineraries`, `/api/routing/geocode`, `/api/ai/status` return `401 Unauthorized`.
      * Tampered or expired cookies and Bearer tokens return `401 Unauthorized`.
      * Valid session cookie or `Authorization: Bearer <jwt>` for a non-allowlisted email returns `403 Forbidden`.
      * Valid session cookie or `Authorization: Bearer <jwt>` for an allowlisted email (case-insensitive) succeeds (`200 OK`) and populates `request.authUser`.
    * Web OAuth2 flow (`GET /api/auth/google` & `GET /api/auth/callback/google`):
      * Redirects to Google OAuth2 with PKCE `code_challenge` (`S256`) and `state`, setting `copilot_oauth_state` cookie, using `x-forwarded-host` when present.
      * Rejects callback with mismatched `state` or missing cookie (`400`/`401`).
      * Exchanges valid `code`, verifies Google `id_token`, issues `HTTP-Only` `copilot_session` cookie, and redirects to `/`.
    * Android Mobile OIDC flow (`POST /api/auth/mobile/google`):
      * Missing `idToken` returns `400`.
      * Invalid Google `id_token` returns `401`.
      * Valid Google `id_token` for non-allowlisted email returns `403 Forbidden`.
      * Valid Google `id_token` for allowlisted email returns `200 OK` with signed Bearer `token` and `user`, and that Bearer `token` authenticates subsequent `/api/itineraries` calls.
    * Logout (`POST /api/auth/logout`): clears `copilot_session` cookie.
* **`route-builder/tests/ui/authGate.test.tsx` & `route-builder/tests/ui/harness.tsx`**
  * Update `tests/ui/harness.tsx` with `fetchAuthStatus` and `logoutAuth` mocks.
  * Add `tests/ui/authGate.test.tsx` verifying:
    * Renders `<AuthGateScreen />` with Google Sign-In CTA when `authEnabled: true, authenticated: false`.
    * Renders `403 Private Preview` screen with signed-in email and Sign Out action when `authEnabled: true, authenticated: true, authorized: false`.
    * Renders main studio and passes `authUser` / `onLogout` to `AppHeader` when `authEnabled: true, authenticated: true, authorized: true`.

---

## 3. Step-by-Step Tactical Steps

- [x] **Step 1: Install Dependencies & Implement Backend Auth Service, Guard Hook & Routes (`route-builder/server/`)**
  - Install `@fastify/cookie`, `@fastify/jwt`, `@fastify/oauth2`, `google-auth-library`, and `@aws-sdk/client-ssm` in `route-builder/`.
  - Implement `server/types/auth.ts`, `server/services/authService.ts`, `server/hooks/authGuard.ts`, and `server/routes/auth.ts`.
  - Wire `authRoutes` and `authGuard` into `server/app.ts` and update `vite.config.ts`.
  - Write and pass `tests/backend/auth.test.ts` (20 tests).
- [x] **Step 2: Implement Frontend Auth Gate Screen & AppHeader User Controls (`route-builder/src/`)**
  - Create `src/types/auth.ts` and `src/components/AuthGateScreen.tsx`.
  - Add `fetchAuthStatus` and `logoutAuth` to `src/services/api.ts`.
  - Update `src/App.tsx` and `src/components/AppHeader.tsx` to handle unauthenticated (`401`), unauthorized (`403`), and authenticated states.
  - Update `tests/ui/harness.tsx` and write `tests/ui/authGate.test.tsx` (4 tests).
- [x] **Step 3: Update AWS CDK Stack & Infrastructure Unit Assertions (`infra/`)**
  - Update `infra/lib/roadtrip-cloud-stack.ts` and `infra/bin/infra.ts` with `AUTH_ENABLED`, SSM parameter configuration, IAM `ssm:GetParameter*` permissions, and `ApiForwardedHostFunction` on `/api/*`.
  - Update `infra/test/roadtrip-cloud-stack.test.ts` (15 tests) and verify `npm test` and `npx cdk synth` pass.
- [x] **Step 4: Full Verification Pipeline, Living Docs Sync & Pull Request**
  - Update [`AGENTS.md`](../../../../AGENTS.md), [`README.md`](../../../../README.md), [`route-builder/AGENTS.md`](../../../../route-builder/AGENTS.md), [`route-builder/README.md`](../../../../route-builder/README.md), and [`docs/reference/directory-layout.md`](../../../reference/directory-layout.md).
  - Run `./scripts/ci_check.sh` across `route-builder` (224 tests + build), `infra` (15 CDK tests + `cdk synth`), and Android unit tests.
  - Push `feat/m1-dual-mode-oidc-auth` and open a green Pull Request (awaiting user permission before live AWS deployment).

---

## 4. Verification Plan

### Automated Verification Commands
```bash
./scripts/ci_check.sh
```
*(Executes `cd route-builder && npm test && npm run build`, `cd infra && npm test && npx cdk synth`, and `./gradlew testDebugUnitTest`).*

### Live Deployment & Manual Cloud Verification Checklist (After User Permission)
1. Store Google OAuth credentials and JWT secret in SSM Parameter Store (`/roadtrip-copilot/google-client-id`, `/roadtrip-copilot/google-client-secret`, `/roadtrip-copilot/jwt-secret`, `/roadtrip-copilot/allowed-emails`).
2. Run `./scripts/deploy_cloud.sh` (or GitHub Actions `workflow_dispatch`).
3. Visit CloudFront URL in an incognito window: verify `/api/itineraries` returns `401` and the Google Sign-In screen is displayed; sign in with a non-allowlisted Google account to verify the `403` private preview screen; sign in with Eric's allowlisted account to verify studio access and Sign Out.

---

## 5. Discoveries & Deviations Log

* **2026-10-19 — Runtime SSM `SecureString` Resolution & CloudFront `/api/*` Forwarded Host ([ADR-0007](../../decisions/0007-ssm-secure-runtime-config-and-cloudfront-forwarded-host.md)):**
  * CloudFormation does not support `{{resolve:ssm-secure:...}}` dynamic references in `AWS::Lambda::Function` `Environment.Variables`, and the AWS Project Free Tier SCP (`DenySecurity`) blocks Secrets Manager while allowing SSM Parameter Store `SecureString`. Furthermore, `OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER` strips the viewer's CloudFront `Host` header when calling the Lambda Function URL, and passing `distribution.distributionDomainName` to `FastifyApiFunction` would create a CloudFormation circular dependency.
  * **Adjustment:** Recorded [ADR-0007](../../decisions/0007-ssm-secure-runtime-config-and-cloudfront-forwarded-host.md). `AuthService` resolves `/roadtrip-copilot/*` SSM `SecureString` parameters at runtime via `@aws-sdk/client-ssm` (`GetParametersCommand` with `WithDecryption: true`) when direct env vars are not set, and `RoadtripCopilotCloudStack` attaches `ApiForwardedHostFunction` (`VIEWER_REQUEST`) to `/api/*` so `x-forwarded-host` carries the CloudFront domain to Fastify.
* **2026-10-19 — Independent Review Findings Hardening & Package Hygiene:**
  * Addressed review findings on auth boundaries: restricted CORS to local development/allowlisted origins; validated `x-forwarded-host` against `SAFE_HOST_PATTERN` in `AuthService.resolvePublicBaseUrl`; enforced fail-closed frontend auth status on API/network errors with retry UI; added 15-minute SSM cache TTL and 30-second retry cooldown on resolution failure; asserted `alg: 'HS256'` in JWT verification; handled Google OAuth cancellation redirects cleanly back to `/`; and removed unused `@fastify/jwt` and `@fastify/oauth2` dependencies.

---

## 6. Next Session Handoff

* **Current State:** All Milestone 1 code, unit tests (`229/229` in `route-builder`, `15/15` in `infra`), CDK synthesis, and living documentation updates are complete on `feat/m1-dual-mode-oidc-auth` with an open Pull Request.
* **Next Immediate Step:** Upon user permission, populate the 4 SSM Parameter Store values (`/roadtrip-copilot/google-client-id`, `/roadtrip-copilot/google-client-secret`, `/roadtrip-copilot/jwt-secret`, `/roadtrip-copilot/allowed-emails`), run `./scripts/deploy_cloud.sh` to deploy M1 to AWS, complete manual cloud verification, and archive `WP-01-dual-mode-oidc-auth.md`.
