# ADR-0002: Native Android Credential Manager for Google OIDC Token Exchange

* **Date:** 2026-10-17
* **Status:** Accepted
* **Deciders:** Eric, Antigravity
* **Related Work Package:** N/A (Foundational Blueprint)

---

## 1. Context & Problem Statement
When online, Tier 2 features (Route Scout bottom sheet and 2-way S3 sync) communicate with the Fastify cloud backend on AWS. The cloud backend enforces zero-trust authentication via Google OIDC and an `ALLOWED_EMAILS` allowlist (ADR-0002 in `route-scout-cloud`).

On Android, opening an external web browser for OAuth2 redirects and cookie flows creates high user friction, requires Custom Tabs, and complicates session management for background API calls.

## 2. Decision Drivers
* Frictionless 1-tap native mobile user experience.
* Cryptographic authenticity of user email claim directly from Google's Android identity system.
* Secure storage of session JWT on-device without third-party SDK bloat.
* Clean integration with Fastify's dual-mode auth preHandler (`Authorization: Bearer <jwt>`).

## 3. Considered Options
* **Option A: In-App Browser OAuth2 Redirect Flow (Custom Tabs / Cookies):** Requires launching Chrome Custom Tabs, handling deep-link redirects back into Android, and extracting session cookies for OkHttp requests.
* **Option B: Google Sign-In Legacy API (`GoogleSignInClient`):** Deprecated by Google as of Android 14.
* **Option C: Android Credential Manager (`androidx.credentials` + Google ID):** Google's modern, recommended identity framework for Android. Acquires a Google-signed OIDC `id_token` in 1 tap natively without leaving the app.

## 4. Decision Outcome
Chosen Option: **Option C (Android Credential Manager)**.

The Android app invokes `CredentialManager.getCredential()` to obtain Google's signed `id_token`, posts it to `POST /api/auth/mobile/google`, and receives a Fastify session JWT. The JWT is stored in `EncryptedSharedPreferences` and attached to all cloud requests as `Authorization: Bearer <jwt>`.

### Positive Consequences
* Modern Google-recommended identity stack with native bottom-sheet OS UX.
* Zero third-party auth libraries or SaaS fees.
* Tokens are stored encrypted at rest via Android Keystore.
* Works seamlessly with the dual-mode Fastify auth hook.

### Negative Consequences / Trade-offs
* Requires configuring the Android SHA-1 fingerprint and package name in the Google Cloud Console OAuth Client settings, while passing the Web Application OAuth Client ID (`GOOGLE_CLIENT_ID`) to `GetGoogleIdOption.Builder().setServerClientId(...)` so the token `aud` claim matches the Fastify backend verifier.

## 5. Implementation Notes & Code Touchpoints
* Blueprint: [android_route_editing_and_cloud_client.md](../android_route_editing_and_cloud_client.md#3-tier-2-cloud-connected-route-scout--2-way-sync-on-android-online)
* Android dependencies: `androidx.credentials:credentials`, `androidx.credentials:credentials-play-services-auth`, `com.google.android.libraries.identity.googleid:googleid`
* Storage: Android Keystore-backed token persistence (`EncryptedSharedPreferences` via `androidx.security:security-crypto` or standard `AndroidKeyStore` AES-GCM wrapper)
