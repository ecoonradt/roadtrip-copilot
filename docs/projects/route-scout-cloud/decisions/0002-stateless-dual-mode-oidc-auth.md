# ADR-0002: Stateless Dual-Mode Google OIDC Authentication with Allowlist Gating

* **Date:** 2026-10-17
* **Status:** Accepted
* **Deciders:** Eric, Antigravity
* **Related Work Package:** N/A (Foundational Blueprint)

---

## 1. Context & Problem Statement
Deploying the Route Builder Fastify server to the public internet on AWS Lambda with Bedrock AI inference connected to an AWS account requires immediate, airtight access gating. Furthermore, two distinct clients interact with the cloud API:
1. The **Route Builder Web Studio** (browser-based React SPA).
2. The **Android Co-Pilot App** (native mobile client running Kotlin).

We need an authentication gate that prevents unauthorized public traffic from incurring AWS costs, requires zero recurring monthly SaaS fees (no Clerk, Auth0, or Cognito MAU charges), and provides seamless native UX on both web and Android.

## 2. Decision Drivers
* Zero monthly SaaS subscription fees ($0.00 base cost).
* Dual-client support: browser sessions (cookies) and native Android (Bearer headers).
* Cryptographic anti-spoofing guarantee on user identity.
* Simple admin gating: incoming users must match an `ALLOWED_EMAILS` whitelist.
* Fast, stateless verification (<1ms in Fastify hooks) without querying external databases.

## 3. Considered Options
* **Option A: Third-Party Auth SaaS (Clerk / Auth0 / Supabase Auth):** Fast setup, but adds third-party dependencies, network latency per request, and recurring monthly subscriptions once past narrow free tiers.
* **Option B: AWS Cognito:** Native to AWS, but notorious for complex configuration, frustrating UI customizations, and separate MAU pricing tiers.
* **Option C: Stateless Dual-Mode Google OIDC + Server-Signed JWT:**
  * Uses Google OpenID Connect (already free via Google Cloud Console).
  * Web flow: Google OAuth2 redirect -> server issues `HTTP-Only`, `Secure`, `SameSite=Lax` JWT cookie.
  * Android flow: Android Credential Manager (`Sign in with Google`) -> sends Google `id_token` to server -> server verifies JWKS and returns a server-signed JWT stored in `EncryptedSharedPreferences` and sent as `Authorization: Bearer <token>`.
  * Fastify `preHandler` hook inspects cookie first, then Bearer header, validates signature with server `JWT_SECRET`, and checks `ALLOWED_EMAILS`.

## 4. Decision Outcome
Chosen Option: **Option C (Stateless Dual-Mode Google OIDC)**.

Fastify uses `@fastify/oauth2`, `@fastify/jwt`, and `@fastify/cookie`. The verification hook rejects non-whitelisted emails with `HTTP 403 Forbidden` and unauthenticated requests with `HTTP 401 Unauthorized`. When running locally in offline/desktop development mode without cloud auth enabled (`AUTH_ENABLED !== 'true'`), the auth hook gracefully bypasses enforcement so zero-config local authoring and existing Vitest suites continue to work seamlessly.

### Positive Consequences
* Zero third-party recurring auth costs ($0.00/month).
* Seamless native UX: Web gets secure cookies; Android gets native Credential Manager one-tap sign-in.
* Cryptographically impossible to spoof emails: Google's IdP cryptographically signs the identity tokens.
* Zero database queries required for session verification (stateless JWT signature check in <1ms).

### Negative Consequences / Trade-offs
* One-time setup of Google OAuth Client IDs (Web and Android) in Google Cloud Console (Android Credential Manager passes the Web Client ID via `setServerClientId` so `POST /api/auth/mobile/google` verifies the token `aud` claim against `GOOGLE_CLIENT_ID`).
* User allowlist is stored in environment configuration (`ALLOWED_EMAILS`).

## 5. Implementation Notes & Code Touchpoints
* Blueprint: [route_scout_cloud_architecture.md](../route_scout_cloud_architecture.md#4-authentication--access-gating-dual-mode-zero-trust-web--android)
* Packages: `@fastify/oauth2`, `@fastify/jwt`, `@fastify/cookie`, `google-auth-library`
* Server files to build/update: `route-builder/server/routes/auth.ts`, `route-builder/server/hooks/authGuard.ts`, `route-builder/server/app.ts`
* Environment variables: `AUTH_ENABLED`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `JWT_SECRET`, `ALLOWED_EMAILS`
