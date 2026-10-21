# WP-02: Amazon S3 Atomic Itinerary Storage Service

* **Milestone:** Milestone 2 (M2) — Amazon S3 Atomic Itinerary Storage Service
* **Status:** In Progress
* **Branch:** `feat/m2-s3-itinerary-storage`
* **Governing Documents:**
  * Architecture Blueprint: [`route_scout_cloud_architecture.md`](../../route_scout_cloud_architecture.md)
  * Phase Roadmap: [`plan/ROADMAP.md`](../ROADMAP.md)
  * Architecture Decisions: [`DECISIONS.md`](../../DECISIONS.md), [`ADR-0003`](../../decisions/0003-s3-atomic-json-persistence.md), [`ADR-0004`](../../decisions/0004-hybrid-local-dev-mode.md), [`ADR-0005`](../../decisions/0005-cdk-iac-and-github-actions-cicd.md)

---

## 1. Objective & Explicit Non-Goals

### Objective
Implement cloud-native itinerary persistence backed by Amazon S3 (`users/{email}/itineraries/{slug}.json`) with conditional write safety (`If-Match` / `If-None-Match` & `ETag`) when `S3_STORAGE_BUCKET` is configured, while keeping local filesystem storage (`itineraries/*.json`) strictly isolated as the default fallback for local feature development (`npm run dev`) per ADR-0003 and ADR-0004. Ensure bundled `sample_itinerary.json` remains visible and protected across both storage backends.

### Explicit Non-Goals
* **No Bedrock AI Implementation:** Amazon Bedrock adapter and model selector are strictly queued for Milestone 3 (M3).
* **No Stripe Billing or User Wallet Ledgers:** Wallet management and Stripe checkout are deferred to Phase 2 (M5).
* **No Cloud Deployment Without User Permission:** All changes are authored, verified via automated test suites and CDK synthesis, and prepared for a pull request without unprompted cloud deployment.

---

## 2. Affected Files & Interfaces

### Backend & Storage Services (`route-builder/server/`)
* `package.json` — Add `@aws-sdk/client-s3` dependency.
* `server/services/itineraryStorageService.ts` — Define storage interface (`IItineraryStorageService`), implement local disk storage (`LocalFileSystemStorageService`) with ETag support, and implement S3 storage adapter (`S3ItineraryStorageService`) scoped to `users/{email}/itineraries/` with conditional writes (`IfMatch` / `IfNoneMatch`) and fallback to bundled `sample_itinerary.json`.
* `server/routes/itineraries.ts` — Pass authenticated user context (`request.authUser?.email`), forward `If-Match` / `If-None-Match` headers, handle `HTTP 412 Precondition Failed` responses, and set `ETag` headers on responses.
* `server/app.ts` — Instantiate storage service based on `process.env.S3_STORAGE_BUCKET` or options.

### Frontend API Client (`route-builder/src/`)
* `src/services/api.ts` — Update `saveItinerary`, `fetchItinerary`, and `deleteItinerary` to support optional ETag headers (`ifMatch`, `ifNoneMatch`) and propagate ETag on retrieval.
* `src/App.tsx` — Track active itinerary ETag and pass on save if present to protect against concurrent edits.

### Infrastructure & CDK (`infra/`)
* `infra/lib/roadtrip-cloud-stack.ts` — Verify and assert `S3_STORAGE_BUCKET` environment variable and least-privilege IAM permissions (`s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`) on `AppDataBucket`.
* `infra/test/roadtrip-cloud-stack.test.ts` — Unit tests for S3 bucket configuration and IAM policies.

### Test Suites (`route-builder/tests/`)
* `tests/backend/itineraries.test.ts` — Comprehensive unit and integration tests covering:
  1. Local filesystem storage (with ETag computation and conditional writes).
  2. S3 storage adapter (with mocked S3 client for list, get, put, delete, and conditional write race defense).
  3. Per-user namespace isolation (`users/{email}/itineraries/`).
  4. Bundled `sample_itinerary.json` visibility and deletion protection.
  5. API route responses (`412 Precondition Failed` on ETag mismatch).
* `tests/backend/s3Storage.test.ts` — Dedicated unit tests for `S3ItineraryStorageService`.

---

## 3. Step-by-Step Tactical Steps

- [x] **Step 1: Install `@aws-sdk/client-s3` in `route-builder/`**
  - Add `@aws-sdk/client-s3` to `route-builder/package.json`.
  - Run `npm install` in `route-builder/` and verify clean build.
- [x] **Step 2: Refactor Itinerary Storage Interface & Local Adapter**
  - Define `IItineraryStorageService` interface in `itineraryStorageService.ts` with `userEmail`, `ifMatch`, and `ifNoneMatch` support.
  - Add ETag calculation and conditional write enforcement (`If-Match`, `If-None-Match`) to local filesystem storage.
- [x] **Step 3: Implement `S3ItineraryStorageService`**
  - Implement S3 client interactions (`ListObjectsV2Command`, `GetObjectCommand`, `PutObjectCommand`, `DeleteObjectCommand`).
  - Scope keys to `users/{email}/itineraries/{slug}.json` (with email lowercasing and sanitization).
  - Inject optional S3 client / mock loader for unit testing without network calls.
  - Support fallback read access to bundled `sample_itinerary.json` when requested.
  - Implement conditional writes (`IfMatch`, `IfNoneMatch: '*'`) with `PreconditionFailed` (412) error mapping.
- [x] **Step 4: Update Fastify Routes (`server/routes/itineraries.ts`)**
  - Extract `request.authUser?.email` and pass to storage service.
  - Read `If-Match` and `If-None-Match` request headers.
  - Set `ETag` response header on `GET` and `POST`.
  - Map S3 / local precondition errors to `HTTP 412 Precondition Failed`.
- [x] **Step 5: Author Comprehensive Unit & Integration Tests**
  - Update `tests/backend/itineraries.test.ts` and add `tests/backend/s3Storage.test.ts`.
  - Cover happy paths, 412 race conditions, user isolation, and sample protection.
- [x] **Step 6: Update Living Documentation & Verification**
  - Update `AGENTS.md`, `README.md`, `route-builder/AGENTS.md`, `route-builder/README.md`, `docs/reference/directory-layout.md`.
  - Run full `./scripts/ci_check.sh` verification.
  - Record handoff and prepare PR.

---

## 4. Verification Plan

* **Backend Test Suite:**
  ```bash
  cd route-builder && npm run test:backend
  ```
  *Result:* Passed (7/7 test files, 104/104 tests passed).
* **Full Route Builder Test Suite:**
  ```bash
  cd route-builder && npm test
  ```
  *Result:* Passed (19/19 test files, 307/307 tests passed).
* **Browser Test Suite:**
  ```bash
  cd route-builder && npm run test:browser
  ```
  *Result:* Passed (22/22 browser tests passed).
* **CDK Infrastructure Tests & Synthesis:**
  ```bash
  cd infra && npm test && npx cdk synth
  ```
  *Result:* Passed (18/18 tests passed; CloudFormation synthesized cleanly).
* **Unified Verification Pipeline:**
  ```bash
  ./scripts/ci_check.sh
  ```
  *Result:* Passed across all subprojects (Route Builder, Infra CDK, Android).

---

## 5. Discoveries & Deviations Log

1. **Non-Breaking ETag Integration on ItineraryRecord:** To preserve 100% backward compatibility with existing tests and callers expecting `Record<string, unknown>` directly from `getItinerary`, `ItineraryRecord` extends `Record<string, unknown>` with optional `_etag?: string`, `_lastModified?: string`, and `_isProtected?: boolean`. This enables Fastify routes to propagate the `ETag` HTTP response header while preserving direct property access (`itinerary.trip_name`).
2. **Frontend Concurrency Conflict Alert:** In `App.tsx` and `RouteSelectorModal.tsx`, `saveItinerary` and `deleteItinerary` propagate `If-Match` using the itinerary's active `etag`. If a concurrent update occurs elsewhere, the backend returns HTTP 412, and the UI displays a clean, user-friendly conflict notice advising the user to reload before overwriting.
3. **CDK `grantReadWrite` Policy Statement Action:** AWS CDK's `bucket.grantReadWrite(grantee)` produces discrete IAM actions including `'s3:PutObject'`, `'s3:PutObjectLegalHold'`, `'s3:PutObjectRetention'` rather than wildcard `'s3:PutObject*'`. CDK unit tests were calibrated to match this exact least-privilege policy structure.
4. **Code Review Concurrency & Namespace Hardening:** Hardened S3 namespace scoping against cross-user collisions (`+` character preservation and hex percent-encoding in `getUserPrefix`), eliminated slow-save trip overwrite and state reversion in `App.tsx` via revision guards and functional state updates, enforced create-only write protection (`If-None-Match: *`) for new trips and imports, cleared foreign ETags on imported JSON and unpersisted fallback templates, ensured atomic local write/delete synchronization via in-memory keyed FIFO locks and temp file renames, added S3 continuation pagination handling, and eliminated hardcoded `us-east-1` client region defaulting.

---

## 6. Next Session Handoff

* **Where We Stopped:** Milestone 2 implementation, independent review fixes, comprehensive regression tests, CDK assertions, and living documentation are 100% complete and verified green locally (`./scripts/ci_check.sh` and `npm run test:browser`).
* **Next Step:** Push branch `feat/m2-s3-itinerary-storage` to GitHub and open pull request targeting `main`. Cloud deployment will be performed upon user instruction or CI merge.

