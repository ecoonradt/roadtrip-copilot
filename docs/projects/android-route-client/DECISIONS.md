# Android Route Client: Architecture Decision Records (ADRs)

This document is the high-level Table of Contents and index for all Architecture Decision Records (ADRs) made during the **Android On-the-Fly Route Editing & Cloud Co-Pilot Client** project.

> [!IMPORTANT]
> **Project Status: QUEUED (Phase 2)**  
> This project depends on the cloud backend and endpoints defined in [`docs/projects/route-scout-cloud/`](../route-scout-cloud/WORKING_MODEL.md). Active implementation is paused until Phase 1 cloud deliverables reach completion.

---

## Decision Index

| ID | Date | Title | Status | Summary | Details |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **ADR-0001** | 2026-10-17 | Two-Tier Architecture: Offline Core vs Metered Cloud | Accepted | Tier 1 local route editing (cascade & Google Maps URL) operates 100% offline & free; Tier 2 cloud sync & Route Scout requires online Google SSO. | [0001-two-tier-offline-core-vs-metered-cloud.md](decisions/0001-two-tier-offline-core-vs-metered-cloud.md) |
| **ADR-0002** | 2026-10-17 | Native Android Credential Manager for Google OIDC | Accepted | Uses `androidx.credentials` + Google ID for 1-tap native login, exchanging Google `id_token` for Fastify session JWT in EncryptedSharedPreferences. | [0002-native-android-credential-manager.md](decisions/0002-native-android-credential-manager.md) |
| **ADR-0003** | 2026-10-17 | Phone-Screen-Only Route Editing & Scout UX | Accepted | All active route editing and conversational Route Scout chat live exclusively on the phone screen to enforce Android Auto distraction compliance. | [0003-phone-screen-only-editing-ux.md](decisions/0003-phone-screen-only-editing-ux.md) |

---

## How to Record a New ADR
1. Copy [`decisions/0000-template.md`](decisions/0000-template.md) to `decisions/XXXX-<slug>.md` (incrementing the 4-digit number).
2. Fill out Context, Decision Drivers, Considered Options, Outcome, and Implementation Notes.
3. Add a row to the table above with status, summary, and relative file link.
4. Record the decision in the active work package under `docs/projects/android-route-client/plan/active/`.
