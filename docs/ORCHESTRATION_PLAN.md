# Roadtrip Co-Pilot: Engineering Roadmap & Verification Protocol

> [!NOTE]
> **Status: Fully Implemented & Verified**  
> All phases (Phase 1A, 1B, 1C, 2A, 2B, 2C, 2D) have been implemented, tested via automated test suites, and merged into the main codebase.  
> This file serves as the technical reference for phase deliverables and verification criteria.

> **Technical Specification:**  
> Core architectural schemas, timeline calculations, routing contracts, and data models are defined in [route_builder_research_and_architecture.md](route_builder_research_and_architecture.md).

---

## 1. Development & Verification Protocol

### Principles
To maintain code quality and test rigor across contributors and automated agents:

1. **Modular Component Boundaries:**  
   Engineers and agents work within clear architectural boundaries (e.g. `com.roadtrip.copilot.model`, `route-builder/server/services/`).

2. **Two-Stage Verification Pipeline:**  
   Every major feature or refactor must pass two verification gates:
   - **Stage 1: Automated Test Gate:** Builds, unit tests, and integration tests must pass cleanly with exit code 0 (`npm test`, `./gradlew testDebugUnitTest`).
   - **Stage 2: Code Review & Invariant Checks:** Code changes are verified against:
     1. *Test Coverage & Edge Cases:* Error handling, malformed payloads, boundary conditions.
     2. *Domain Compliance:* Adherence to [AGENTS.md](../AGENTS.md) (offline-first GNSS, coroutine threading discipline, Android Auto distraction rules).
     3. *Architecture Alignment:* Compliance with [route_builder_research_and_architecture.md](route_builder_research_and_architecture.md).

---

## 2. Phase Deliverables & Verification Checklist

### Phase 1: Android App Dynamic Storage & Car UI

- [x] **Phase 1A: Storage & Repository Engine (`RouteRepository.kt`)**
  - **Component Boundary:** `app/src/main/java/com/roadtrip/copilot/model/` and `app/src/test/`
  - **Deliverables:** `RouteRepository.kt`, `RouteRepositoryTest.kt`
  - **Scope:**
    - Scans internal storage (`context.filesDir/itineraries/`) for `.json` itineraries.
    - Preserves bundled assets (`itinerary.json`, `test_itinerary.json`, `test_itinerary_return.json`) as permanent fallbacks.
    - Exposes a reactive `StateFlow<List<RouteOption>>` for UI consumers.
  - **Verification Scenarios:**
    1. *Asset Fallback:* When internal storage is empty, returns all bundled asset routes.
    2. *Dynamic Ingestion:* Placing a valid custom itinerary in `filesDir` dynamically populates in the route list.
    3. *Corrupted File Resilience:* Malformed JSON files in `filesDir` are skipped gracefully without crashing.
    4. *Multi-Day vs. Single Route:* Correctly parses both multi-day itineraries (`days` array) and single routes (`checkpoints` array).
  - **Gate Command:** `./gradlew testDebugUnitTest --tests com.roadtrip.copilot.RouteRepositoryTest`

- [x] **Phase 1B: Phone UI Import Flow (`MainActivity.kt`)**
  - **Component Boundary:** `app/src/main/res/layout/activity_main.xml`, `MainActivity.kt`, `CopilotService.kt`
  - **Deliverables:** Import button, SAF `OpenDocument()` contract, dynamic spinner refresh.
  - **Scope:**
    - Connect "Import Itinerary" button to Storage Access Framework (`application/json`).
    - Copy imported itinerary into `context.filesDir/itineraries/`.
    - Automatically select and activate the imported route in the UI.
  - **Verification Scenarios:**
    1. UI data-binding compiles cleanly.
    2. Selected route updates `CopilotService.setSelectedRoute()`.
  - **Gate Command:** `./gradlew assembleDebug`

- [x] **Phase 1C: Android Auto In-Car UI (`RouteListScreen.kt`)**
  - **Component Boundary:** `app/src/main/java/com/roadtrip/copilot/car/`
  - **Deliverables:** Dynamic `RouteListScreen.kt`, Car App Library unit tests.
  - **Scope:**
    - Populate in-car route list dynamically from `RouteRepository`.
    - Selecting an imported custom route loads checkpoints into `CopilotService` and updates `CopilotDashboardScreen.kt`.
  - **Verification Scenarios:**
    1. `onGetTemplate()` returns rows matching `RouteRepository.getAvailableRoutes()`.
    2. Selected route item is visually marked with a `"✓ "` prefix.
    3. Complies with 6-item pagination and driving distraction limits.
  - **Gate Command:** `./gradlew testDebugUnitTest && ./gradlew assembleDebug`

---

### Phase 2: Web Studio MVP (The Route Builder)

- [x] **Phase 2A: Full-Stack Web Shell & Routing Proxy**
  - **Component Boundary:** `route-builder/` (React frontend + Fastify backend)
  - **Deliverables:** Full-stack dev setup, Leaflet map canvas, OSRM/Nominatim proxies.
  - **Scope:**
    - Concurrent boot (`npm run dev`) for frontend (:5173) and backend (:3001).
    - Backend endpoints:
      - `GET /api/routing/geocode`: Proxies Nominatim with compliant `User-Agent`.
      - `GET /api/routing/route`: Proxies OSRM driving directions and caches road polylines.
  - **Verification Scenarios:**
    1. Nominatim proxy sets valid `User-Agent` and parses coordinates.
    2. OSRM proxy returns HTTP 200 with valid GeoJSON road geometry and drive duration.
    3. Caching avoids duplicate requests for identical coordinate pairs.
  - **Gate Command:** `cd route-builder && npm run test:backend`

- [x] **Phase 2B: Timeline Cascade Engine & Google Maps Navigation Links**
  - **Component Boundary:** `route-builder/src/engine/` and `route-builder/tests/`
  - **Deliverables:** `cascade.ts`, `googleMapsUrl.ts`, unit tests, timeline sidebar UI.
  - **Scope:**
    - Timeline cascade: arrival = previous departure + drive duration; departure = arrival + dwell minutes.
    - Multi-stop Google Maps Navigation URL generator with route-forcing anchors.
    - Automatic partitioning of routes with >9 intermediate waypoints into consecutive legs.
  - **Verification Scenarios:**
    1. *Cascade Ripple:* Modifying dwell time on stop $k$ shifts arrival timestamps on stops $k+1 \dots n$.
    2. *Timezone Shifts:* Transitioning across timezone boundaries applies local hour offsets correctly.
    3. *Google Maps URL Length:* An 11-waypoint route is split into two valid Google Maps URLs with $\le 9$ intermediate stops each.
  - **Gate Command:** `cd route-builder && npm run test:engine`

- [x] **Phase 2C: AI Co-Pilot Enrichment via Pluggable Adapters**
  - **Component Boundary:** `route-builder/server/services/aiService.ts`, `route-builder/src/components/AiAlertModal.tsx`
  - **Deliverables:** `AiHarnessAdapter` interface, `AgyHarnessAdapter`, `GeminiStudioHarnessAdapter`, preview modal, test suites.
  - **Scope:**
    - Primary engine: shells out to `agy` CLI, automatically resolving the latest Flash model. Zero API keys required.
    - Cloud engine fallback: direct Google AI Studio API (`gemini-3.8-flash`) if an API key is supplied.
    - Enforces JSON schema: `title` $\le 30$ chars, `message` $\le 2$ lines, `speech` 15–25 words, `recommended_trigger_radius_miles` numeric.
    - Day-level batch generation.
  - **Verification Scenarios:**
    1. Prompt generator formats all contextual parameters (highway, heading, target time).
    2. Schema parser sanitizes and truncates titles exceeding 30 characters.
    3. Batch prompt generates all stops in a single invocation.
    4. Client-side queue prevents concurrent request bursts.
  - **Gate Command:** `cd route-builder && npm run test:ai`

- [x] **Phase 2D: Export, 1-Click ADB Push & Phone Handoff**
  - **Component Boundary:** `route-builder/src/engine/export.ts`, `route-builder/server/device.ts`
  - **Deliverables:** JSON exporter, `POST /api/device/push`, local Wi-Fi QR code endpoint.
  - **Scope:**
    - 1-Click ADB Push: backend executes `adb push` to connected phone.
    - Local Wi-Fi QR server: phone scans QR code to download `.json` directly over Wi-Fi.
  - **Verification Scenarios:**
    1. Exported JSON passes deserialization inside the Android app test suite (`ItineraryTest.kt`).
    2. ADB push returns a clean error if no phone is connected rather than hanging.
  - **Gate Command:** `cd route-builder && npm run test:schema && cd .. && ./gradlew testDebugUnitTest`

---

## 3. Contributor & Agent Task Templates

### Feature Implementation Prompt Template
```text
You are the implementation engineer for [FEATURE_OR_PHASE_NAME].
Objective: [CLEAR_GOAL]

Component Boundary: You own code under [DIRECTORY_OR_PACKAGE].
Specifications: Refer to docs/route_builder_research_and_architecture.md for data contracts and formulas.

Verification Checklist:
[REQUIRED_INVARIANT_SCENARIOS]

When finished, run:
[GATE_COMMAND]
```

### Reviewer Prompt Template
```text
Review the git diff against the deliverables and required scenarios for [FEATURE_OR_PHASE_NAME].

Review Criteria:
1. Are edge cases and error states tested?
2. Does the code conform to AGENTS.md (offline-first, proper coroutine dispatchers, no hardcoded secrets)?
3. Does the implementation align with the architecture spec?

Output:
- APPROVED with brief rationale, or
- CHANGES_REQUESTED with actionable feedback.
```
