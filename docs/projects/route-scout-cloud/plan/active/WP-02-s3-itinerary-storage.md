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
Implement cloud-native itinerary persistence backed by Amazon S3 (`users/{email}/itineraries/{slug}.json`) with conditional write safety (`If-Match` / `If-None-Match` & `ETag`) when `S3_STORAGE_BUCKET` is configured, while keeping local filesystem storage (`itineraries/*.json`) strictly isolated as the default fallback for local feature development (`npm run dev`) per ADR-0003 and ADR-0004. There is no bundled sample file in either backend: the sample route is generated in code (`src/engine/sampleTrip.ts`) and offered only while starting a new route.

### Explicit Non-Goals
* **No Bedrock AI Implementation:** Amazon Bedrock adapter and model selector are strictly queued for Milestone 3 (M3).
* **No Android-Side Sample or Blank-Route Authoring:** Routes are authored in the web studio and exported; the Android drive loop is unchanged.
* **No Stripe Billing or User Wallet Ledgers:** Wallet management and Stripe checkout are deferred to Phase 2 (M5).
* **No Cloud Deployment Without User Permission:** All changes are authored, verified via automated test suites and CDK synthesis, and prepared for a pull request without unprompted cloud deployment.

---

## 2. Affected Files & Interfaces

### Backend & Storage Services (`route-builder/server/`)
* `package.json` — Add `@aws-sdk/client-s3` dependency.
* `server/services/itineraryStorageService.ts` — Define storage interface (`IItineraryStorageService`), implement local disk storage (`LocalFileSystemStorageService`) with ETag support, and implement S3 storage adapter (`S3ItineraryStorageService`) scoped to `users/{email}/itineraries/` with conditional writes (`IfMatch` / `IfNoneMatch`). Every file is treated generically; the only protection rule is that records found outside the primary write directory are read-only. No sample key, fallback directory, or appended entry exists.
* `server/routes/itineraries.ts` — Pass authenticated user context (`request.authUser?.email`), forward `If-Match` / `If-None-Match` headers, handle `HTTP 412 Precondition Failed` responses, and set `ETag` headers on responses.
* `server/app.ts` — Instantiate storage service based on `process.env.S3_STORAGE_BUCKET` or options.

### Frontend API Client (`route-builder/src/`)
* `src/services/api.ts` — Update `saveItinerary`, `fetchItinerary`, and `deleteItinerary` to support optional ETag headers (`ifMatch`, `ifNoneMatch`) and propagate ETag on retrieval. `fetchItinerary` and `fetchItineraryList` throw `ApiError` with the HTTP status so the UI can distinguish "missing" from "broken".
* `src/App.tsx` — Track active itinerary ETag and pass on save if present to protect against concurrent edits. Model "no active route" explicitly (`hasActiveTrip`, `initialLoadError`, `resetToNoActiveRoute`), open `RouteSelectorModal` on first visit, and never write an active-file pointer for unsaved trips.
* `src/engine/sampleTrip.ts` — In-code `createSampleTrip()` factory: the single source of truth for the sample (relative/ad-hoc, single-day, no `target_time`).
* `src/components/RouteSelectorModal.tsx` — `dismissible` gating, "New Route" tab, and "Start from Sample Route" actions.
* `src/components/TimelineSidebar.tsx` — Remove the reset/load-sample affordances; empty state offers only "Add First Stop".
* `src/components/ExportModal.tsx` — Default export filename is `my_road_trip.json`.

### Deleted Assets
* `itineraries/sample_itinerary.json` and `route-builder/itineraries/sample_itinerary.json` deleted; `itineraries/.gitkeep` keeps the workspace directory, and the Docker build no longer copies a sample.

### Infrastructure & CDK (`infra/`)
* `infra/lib/roadtrip-cloud-stack.ts` — Verify and assert `S3_STORAGE_BUCKET` environment variable and least-privilege IAM permissions (`s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`) on `AppDataBucket`.
* `infra/test/roadtrip-cloud-stack.test.ts` — Unit tests for S3 bucket configuration and IAM policies.

### Test Suites (`route-builder/tests/`)
* `tests/backend/itineraries.test.ts` — Comprehensive unit and integration tests covering:
  1. Local filesystem storage (with ETag computation and conditional writes).
  2. S3 storage adapter (with mocked S3 client for list, get, put, delete, and conditional write race defense).
  3. Per-user namespace isolation (`users/{email}/itineraries/`).
  4. Generic read-only protection for any file found outside the primary write directory, plus creation of the primary write directory on first save.
  5. API route responses (`412 Precondition Failed` on ETag mismatch).
* `tests/backend/s3Storage.test.ts` — Dedicated unit tests for `S3ItineraryStorageService`.
* `tests/engine/sampleTrip.test.ts` — In-code sample shape, freshness, notifications, and V2 export round-trip.
* `tests/ui/scheduling.test.tsx` — No-active-route chooser, sample start/save, delete-to-chooser, unsaved-pointer, and load-error state machines.

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
  - Treat every object generically: no sample key, fallback directory, or first-save-over-sample path.
  - Implement conditional writes (`IfMatch`, `IfNoneMatch: '*'`) with `PreconditionFailed` (412) error mapping.
- [x] **Step 4: Update Fastify Routes (`server/routes/itineraries.ts`)**
  - Extract `request.authUser?.email` and pass to storage service.
  - Read `If-Match` and `If-None-Match` request headers.
  - Set `ETag` response header on `GET` and `POST`.
  - Map S3 / local precondition errors to `HTTP 412 Precondition Failed`.
- [x] **Step 5: Author Comprehensive Unit & Integration Tests**
  - Update `tests/backend/itineraries.test.ts` and add `tests/backend/s3Storage.test.ts`.
  - Cover happy paths, 412 race conditions, user isolation, generic read-only protection, and first-save directory creation.
- [x] **Step 6: Update Living Documentation & Verification**
  - Update `AGENTS.md`, `README.md`, `route-builder/AGENTS.md`, `route-builder/README.md`, `docs/reference/directory-layout.md`.
  - Run full `./scripts/ci_check.sh` verification.
  - Record handoff and prepare PR.
- [x] **Step 7: Replace Bundled Sample File with In-Code Sample Route (Scope Amendment, 2026-10-22)**
  - Add `src/engine/sampleTrip.ts` (`createSampleTrip()`: fresh relative/ad-hoc single-day trip, no `target_time`, notifications preserved) and `tests/engine/sampleTrip.test.ts` including a V2 serializer round-trip.
  - Delete `itineraries/sample_itinerary.json` and `route-builder/itineraries/sample_itinerary.json`; add `itineraries/.gitkeep`, simplify `itineraries/.gitignore`, and drop the Dockerfile sample copy.
  - Remove every storage special case: generic `isProtected` for non-primary directories, no sample delete guards, no fallback directories, no appended list entry, no first-save-over-sample; add `mkdir` before local writes.
  - Make `fetchItinerary`/`fetchItineraryList` throw `ApiError` with the HTTP status.
  - Rework `App.tsx`: placeholder trip, `hasActiveTrip`/`initialLoadError`, `resetToNoActiveRoute`, 404 → chooser, other failures → Retry error screen, Save gating, pointer persistence only for saved selections and successful saves, delete → chooser.
  - Rework `RouteSelectorModal` (`dismissible`, New Route tab, Start from Sample, empty-state actions, list Retry), remove sample affordances from `TimelineSidebar`, and update the Export filename placeholder.
  - Update backend/UI/browser tests and sync WP-02, ROADMAP, both AGENTS handbooks, and the directory layout (no ADR; see Discoveries 6).

---

## 4. Verification Plan

* **Backend Test Suite:**
  ```bash
  cd route-builder && npm run test:backend
  ```
  *Result:* Passed (7/7 test files, 118/118 tests passed).
* **Full Route Builder Test Suite:**
  ```bash
  cd route-builder && npm test
  ```
  *Result:* Passed (21/21 test files, 359/359 tests passed).
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
5. **Cross-Process Atomicity & Lifecycle Review Follow-up:** Initial replacement of per-instance locking with `CrossProcessFileLock` (OS-level lockfiles) was superseded by the in-process `KeyedMutex` per ADR-0008 (review proved file-level ownership can never be made safe under process pauses or PID reuse; local backend is dev-only, while S3 conditional writes provide cross-process safety in production); incremented `tripRevisionRef` across all initial-load paths to prevent slow saves from adopting newly loaded route identities; updated `handleSaveTrip` to adopt synchronized baseline state on clean saves eliminating dirty-state regressions; added conflict recovery in `handleRenameTrip` so 412 collisions on imported filenames can be renamed and saved under a new destination; resolved test gaps in `s3Storage.test.ts` (testing real SDK profile region resolution) and `scheduling.test.tsx` (realistic deferred save responses and zero alert assertions).
6. **Sample Route Is In-Code Content, Not a Storage Artifact (Requirement Change):** The bundled `sample_itinerary.json` assets were deleted and every storage special case removed (`isProtected` is now generic for files outside the primary write directory; no fallback directories, no appended list entry, no first-save-over-sample path). The drift was real: three copies existed (the root asset, a `route-builder/` copy for the container, and the `INITIAL_FALLBACK_TRIP` clone) with 3 vs 4 stops, and because `getItinerary` returned `_etag` for the primary directory, editing the auto-loaded sample and pressing Save could overwrite the tracked working-tree file. `src/engine/sampleTrip.ts` is the single source of truth and returns a fresh relative/ad-hoc, single-day trip that is offered only when starting a new route. "No active route" is now an explicit state: the non-dismissible `RouteSelectorModal` opens on first visit, a `404` clears the pointer and reopens the chooser, and other load failures show a Retry error screen. `copilot_active_file` is written only for previously saved selections and after a successful save, so unsaved/new routes no longer reload into a 404. Per D9 this is recorded as a requirement change, not an ADR.
7. **Startup/Retry Loading Guard (Review Follow-up):** Pending route loads now show a noninteractive loading screen when no trip is active and the chooser is closed. Deferred startup and retry tests prevent placeholder edits from cancelling the load and leaving an unsaveable trip; first-visit chooser and already-active-trip behavior remain unchanged.

---

## 6. Next Session Handoff

* **Where We Stopped:** Milestone 2 implementation, the in-code sample-route refactor (no storage special cases), startup/retry loading guard, independent review fixes, comprehensive regression tests, CDK assertions, browser geometry tests, and living documentation are complete and verified green locally (`./scripts/ci_check.sh` and `npm run test:browser`). The loading guard was also verified in Chromium with a deferred retry and a fresh-visit chooser.
* **Next Step:** Push branch `feat/m2-s3-itinerary-storage` to GitHub and open pull request targeting `main`. Cloud deployment will be performed upon user instruction or CI merge.
