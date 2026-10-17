# ADR-0001: Two-Tier Architecture — 100% Offline Core Route Editor vs. Metered Cloud Co-Pilot

* **Date:** 2026-10-17
* **Status:** Accepted
* **Deciders:** Eric, Antigravity
* **Related Work Package:** N/A (Foundational Blueprint)

---

## 1. Context & Problem Statement
Historically, the Android app operated strictly as a read-only itinerary playback engine. However, real-world road trips demand on-the-fly itinerary changes (skipping a stop when late, extending dwell time at an overlook, or asking Route Scout for dining alternatives). Many scenic corridors and national parks have zero cellular reception.

We need an on-the-fly route editing model that allows full route manipulation in cellular dead zones without violating **Rule 1: Never add cloud API dependencies to the Android in-car drive loop**, while still enabling cloud-assisted conversational Route Scout discovery when online.

## 2. Decision Drivers
* Strict preservation of Rule 1: The core in-car drive loop must run 100% offline and free forever.
* Seamless on-device route modification: Deleting/skipping stops, adjusting dwell times, and regenerating Google Maps URLs must work with zero network connectivity.
* Clear distinction between free local operations and metered cloud AI operations.

## 3. Considered Options
* **Option A: Pure Cloud Editing:** Require all itinerary modifications and route queries to go through the Fastify cloud backend. (Fails completely in dead zones).
* **Option B: Pure Offline Editing Only:** Only allow local stop deletions; no mobile Route Scout chat or cloud itinerary synchronization. (Misses conversational assistant potential).
* **Option C: Explicit Two-Tier Architecture (Offline-First Core, Cloud-Enhanced Editing):**
  * **Tier 1 (100% Offline & Free):** Port pure-Kotlin versions of `cascade.ts` (`OfflineCascadeEngine.kt`) and `googleMapsUrl.ts` (`GoogleMapsUrlGenerator.kt`). Allow skipping/deleting stops, dwell changes, local schedule cascades, and Google Maps URL regeneration entirely on-device from the local V2 JSON.
  * **Tier 2 (Online Only & Authenticated/Metered):** When cellular/Wi-Fi is available and the user is signed in with Google, provide 2-way S3 cloud sync (`GET / PUT /api/itineraries`) and conversational Route Scout chat (`POST /api/ai/scout/chat/stream`) with 1-tap suggestion application.

## 4. Decision Outcome
Chosen Option: **Option C (Two-Tier Architecture)**.

The phone holds the full V2 itinerary JSON on disk via `RouteRepository.kt` (`File(context.filesDir, "itineraries")` and `context.getExternalFilesDir("itineraries")`). Tier 1 executes all schedule cascade and URL generation locally. Tier 2 connects to Fastify only when online.

### Positive Consequences
* The drive loop, foreground service, and route editing never fail in dead zones.
* Zero cloud costs incurred for standard route modifications (skipping/deleting stops or dwell adjustments).
* Cloud features provide rich discovery when online without compromising drive reliability.

### Negative Consequences / Trade-offs
* Kotlin implementations of cascade math and Google Maps URL chunking must maintain algorithmic parity with their TypeScript equivalents in `route-builder/src/engine/`.

## 5. Implementation Notes & Code Touchpoints
* Blueprint: [android_route_editing_and_cloud_client.md](../android_route_editing_and_cloud_client.md#1-real-world-motivation--architectural-philosophy)
* Kotlin engines to build: `OfflineCascadeEngine.kt`, `GoogleMapsUrlGenerator.kt`
* Files to update: `RouteRepository.kt`, `CopilotService.kt`, `LocationTracker.kt`, `MainActivity.kt`
