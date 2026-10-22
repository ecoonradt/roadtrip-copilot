# ADR-0008: In-Process Keyed Mutex for Local Storage Concurrency

* **Date:** 2026-10-21
* **Status:** Accepted
* **Deciders:** Eric, Antigravity
* **Related Work Package:** WP-02-s3-itinerary-storage

---

## 1. Context & Problem Statement
During Milestone 2 implementation, `LocalFileSystemStorageService` introduced `CrossProcessFileLock` utilizing an OS-level filesystem lockfile protocol (`.lock` files, PID liveness checks, `.recovery` sidecars, stale lock recovery, and release retries) to serialize concurrent reads and writes to local itinerary files.

Comprehensive code review proved that custom filesystem lockfile protocols cannot be made ownership-safe without OS-level kernel-enforced distributed primitives or external consensus:
* Process pauses (GC, OS scheduling) allow lock recovery timers to expire while the owner is still running.
* PID reuse across OS restarts or container recycling leads to false liveness assertions.
* Stale recovery sidecar files suffer from their own multi-process race conditions.
* Lock file deletion at release cannot verify uninterrupted ownership; unlinking can delete a successor lock acquired by another process.
* Plain POSIX filesystem files do not support fencing tokens or distributed leases.

Because local filesystem storage exists exclusively as a single-process developer fallback (`npm run dev`) and test fixture (production uses Amazon S3 with conditional writes per ADR-0003 and ADR-0004), maintaining an inherently fragile cross-process lockfile protocol introduces severe complexity without genuine safety.

## 2. Decision Drivers
* **Architectural Simplicity & Correctness:** Eliminate unprovable, race-prone lockfile recovery and release logic.
* **Deterministic Single-Process Concurrency:** Guarantee strict mutual exclusion and FIFO queueing for concurrent HTTP requests within the local Fastify process.
* **Bounded Resource Utilization:** Ensure queued lock acquisitions have deterministic timeouts with clean queue pruning and no orphaned memory or disk artifacts.
* **Production S3 Alignment:** Preserve Amazon S3 conditional HTTP writes (`If-Match` / `If-None-Match` with ETags) as the authoritative, cross-process concurrency guarantee for deployed environments.

## 3. Considered Options
* **Option A: Retain & Patch CrossProcessFileLock:** Continue adding generation counters, heartbeat threads, and retry loops to the `.lock` file protocol. Rejected: plain files lack atomic fencing, and the protocol remains fundamentally flawed under process pauses or PID reuse.
* **Option B: Heavyweight External Lock Coordinator (Redis, ZooKeeper, DynamoDB):** Provides true distributed leasing. Rejected: introduces unnecessary infrastructure dependencies and setup friction for local development and unit tests.
* **Option C: In-Process Keyed Mutex (`KeyedMutex`):** Delete the `.lock` file protocol entirely. Use an in-process, static FIFO keyed mutex (`path.resolve(key)`) with bounded acquisition timeouts (`timeoutMs`), strict queue removal on timeout or completion, and immediate map cleanup when idle. Retain atomic temp-file write + rename (`fs.rename`) for on-disk durability.

## 4. Decision Outcome
Chosen Option: **Option C (In-Process Keyed Mutex)**.

The entire `CrossProcessFileLock` class and lockfile protocol are removed. `LocalFileSystemStorageService.saveItinerary` and `deleteItinerary` now serialize operations via `KeyedMutex.runExclusive(targetPath, ...)`.

### Positive Consequences
* Zero `.lock` or `.recovery` sidecar files created or left orphaned on developer disks.
* Deterministic, in-memory FIFO ordering and queue timeouts without filesystem polling or PID inspections.
* Codebase footprint reduced and simplified; zero external dependencies added.
* Memory-leak-free: static key states are deleted immediately when queues become empty and unlocked.
* Preserves atomic filesystem persistence via temp-file + rename (`.tmp.<timestamp>.<rand>` renamed over destination).

### Negative Consequences / Trade-offs
* **Single-Process Constraint:** Running multiple independent Node.js server processes concurrently pointed at the same local `itineraries/` directory is explicitly unsupported. If two processes execute concurrent conditional writes in that unsupported topology, one could overwrite another in the check-then-write window. This is fully acceptable for local development and test environments.
* If multi-process local filesystem sharing ever becomes a requirement, it must be addressed via a vetted, platform-native locking library rather than custom ad-hoc lockfile scripts.

## 5. Implementation Notes & Code Touchpoints
* `route-builder/server/services/itineraryStorageService.ts`: Replaced `CrossProcessFileLock` with `KeyedMutex`, `KeyedMutexOptions`, and `LockTimeoutError`.
* `route-builder/server/routes/itineraries.ts`: Instantiates `ItineraryStorageService` lazily at plugin registration time so environment variables loaded at startup (`S3_STORAGE_BUCKET`) are respected.
* `route-builder/server/loadEnv.ts`: Side-effect module evaluated first in `server/index.ts` to ensure `.env` is loaded before application modules.
* `route-builder/tests/backend/itineraries.test.ts`: Replaced file-lock tests with comprehensive unit tests for `KeyedMutex` (mutual exclusion, FIFO ordering, distinct key independence, error release, bounded timeout, and queue resilience).
