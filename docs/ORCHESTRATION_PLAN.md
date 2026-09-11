# Roadtrip Co-Pilot: Agentic Orchestration & Verification Plan

This document serves as the **executable specification and master checklist** for an autonomous or semi-autonomous agentic orchestration loop building the Roadtrip Co-Pilot Route Builder.

> **Primary Technical Specification & Data Contract:**  
> All architectural schemas, mathematical cascade formulas, endpoints, and data models are defined in [route_builder_research_and_architecture.md](route_builder_research_and_architecture.md). Orchestrators and subagents **must** consult this document for technical context and domain rules.

---

## 1. The Orchestration Protocol

### Orchestrator vs. Worker Separation of Concerns
To prevent agents from getting lost in context bloat or "going off the rails":

1. **The Orchestrator Never Writes Bulk Code:**  
   The Orchestrator acts purely as technical project manager and release manager:
   - Tracks master phase progression in this document.
   - Dispatches worker subagents to implement a single granular phase.
   - Enforces the two-stage verification pipeline (Automated Gates + Independent Code Review).
   - Commits verified milestones and updates the master checklist.

2. **Component Boundaries Over Rigid File Lists (Worker Agency):**  
   Rather than a waterfall list of exact files (which turns the orchestrator into a micromanaging bottleneck), workers are given **clear component boundaries** (e.g., "You own the RouteRepository and storage layer under `com.roadtrip.copilot.model`"). Workers have full agency to create necessary helpers, data mappers, utilities, and tests within their domain, reporting all created and modified files upon completion.

3. **Two-Stage Verification Pipeline (Solving the "Self-Grading Student" Trap):**  
   Because workers write both the code and the tests, a passing test suite is necessary but not sufficient. To prevent trivial or self-serving tests from passing buggy code, every sub-phase must pass two gates:
   - **Stage 1: Machine-Executable Gate:** Automated build, compilation, and test execution must exit with code 0.
   - **Stage 2: Independent Code Review Subagent:** An isolated QA/Review subagent inspects the `git diff` against the phase requirements and checks:
     1. *Test Rigor & Adversarial Cases:* Did the worker test edge cases, error states, and corrupted inputs, or only the happy path?
     2. *Domain Compliance:* Does the code adhere to `AGENTS.md` (e.g. offline-first GNSS, coroutine dispatchers, no hardcoded cloud API keys)?
     3. *Architecture Alignment:* Does the implementation conform to the specifications in `route_builder_research_and_architecture.md`?

4. **Failure & Feedback Loop:**  
   If either the test gate fails or the review subagent requests changes, the Orchestrator feeds the exact failure log and review comments back to the worker subagent to resolve. Max retry attempts: 3 before escalating to human input.

---

## 2. Master Phase Checklist & Verification Gates

### Phase 1: Android App Dynamic Storage & Car UI

- [x] **Phase 1A: Storage & Repository Engine (`RouteRepository.kt`)**
  - **Component Boundary:** `app/src/main/java/com/roadtrip/copilot/model/` and `app/src/test/`
  - **Deliverables:** `RouteRepository.kt`, `RouteRepositoryTest.kt`
  - **Scope:**
    - Scans internal storage (`context.filesDir/itineraries/`) and external files for `.json` files.
    - Preserves bundled assets (`itinerary.json`, `test_itinerary.json`, `test_itinerary_return.json`) as permanent fallback defaults.
    - Exposes a reactive `StateFlow<List<RouteOption>>` for UI consumers.
  - **Required Invariant Test Scenarios (Must be tested):**
    1. *Asset Fallback:* When `filesDir` is empty, repository returns all 6 bundled asset route options.
    2. *Dynamic Ingestion:* Placing a valid custom itinerary in `filesDir` dynamically populates in the route list.
    3. *Corrupted File Resilience:* Corrupted or malformed JSON files in `filesDir` are logged and gracefully skipped without throwing exceptions or crashing the app.
    4. *Multi-Day vs. Single Route:* Correctly parses and resolves both multi-day itineraries (`days` array) and ad-hoc single-route itineraries (`checkpoints` array).
  - **Stage 1: Machine-Executable Gate:**
    ```bash
    ./gradlew testDebugUnitTest --tests com.roadtrip.copilot.RouteRepositoryTest
    ```
  - **Stage 2: Code Review Subagent:** Must verify test rigor covers scenarios 1–4 and no blocking I/O runs on the main thread.

- [x] **Phase 1B: Phone UI Import Flow (`MainActivity.kt`)**
  - **Component Boundary:** `app/src/main/res/layout/activity_main.xml`, `MainActivity.kt`, `CopilotService.kt`
  - **Deliverables:** Import button in UI, SAF `OpenDocument()` intent contract, dynamic spinner refresh.
  - **Scope:**
    - Wire "Import Itinerary" button to Storage Access Framework file picker (`application/json`).
    - Copy imported file into `context.filesDir/itineraries/`.
    - Automatically select and activate the newly imported route in the UI spinner.
  - **Required Invariant Test Scenarios:**
    1. UI data-binding compiles cleanly with new controls.
    2. Selected route updates `CopilotService.setSelectedRoute()` without forcing a premature start.
  - **Stage 1: Machine-Executable Gate:**
    ```bash
    ./gradlew assembleDebug
    ```
  - **Stage 2: Code Review Subagent:** Verifies layout adheres to existing dark automotive theme and handles file permission exceptions gracefully.

- [x] **Phase 1C: Android Auto Car In-Car UI (`RouteListScreen.kt`)**
  - **Component Boundary:** `app/src/main/java/com/roadtrip/copilot/car/`
  - **Deliverables:** Dynamic `RouteListScreen.kt`, Car App Library unit tests.
  - **Scope:**
    - Replace hardcoded `availableRoutes` list with dynamic entries queried from `RouteRepository`.
    - Selecting an imported custom route loads checkpoints into `CopilotService` and updates `CopilotDashboardScreen.kt`.
  - **Required Invariant Test Scenarios:**
    1. `onGetTemplate()` returns rows matching `RouteRepository.getAvailableRoutes()`.
    2. Selected route item is visually decorated with the `"✓ "` prefix.
  - **Stage 1: Machine-Executable Gate:**
    ```bash
    ./gradlew testDebugUnitTest && ./gradlew assembleDebug
    ```
  - **Stage 2: Code Review Subagent:** Confirms compliance with Android Auto Car App Library pagination limits and driving distraction constraints.

---

### Phase 2: Web Studio MVP (The Route Builder)

- [ ] **Phase 2A: Full-Stack Web Shell & Routing Proxy**
  - **Component Boundary:** `route-builder/` directory (React frontend + Node/Fastify backend)
  - **Deliverables:** Full-stack shell, OpenStreetMap Leaflet map canvas, OSRM/Nominatim proxies.
  - **Scope:**
    - Single `npm run dev` boots both React frontend and Node backend.
    - Backend endpoints:
      - `GET /api/routing/geocode`: Proxies Nominatim with compliant `User-Agent`.
      - `GET /api/routing/route`: Proxies OSRM driving directions and caches road polylines.
  - **Required Invariant Test Scenarios:**
    1. Nominatim proxy sets a valid `User-Agent` header and parses location coordinates.
    2. OSRM proxy returns HTTP 200 with valid GeoJSON road geometry and drive duration.
    3. Caching prevents duplicate OSRM network requests for identical coordinate pairs.
  - **Stage 1: Machine-Executable Gate:**
    ```bash
    cd route-builder && npm install && npm run build && npm run test:backend
    ```
  - **Stage 2: Code Review Subagent:** Verifies TypeScript strictness, zero `any` types, and proper proxy error handling.

- [ ] **Phase 2B: Timeline Cascade Engine & Google Maps Navigation Links**
  - **Component Boundary:** `route-builder/src/engine/` and `route-builder/tests/`
  - **Deliverables:** `cascade.ts`, `googleMapsUrl.ts`, unit tests, timeline sidebar UI.
  - **Scope:**
    - Deterministic timeline cascade: arrival = previous departure + drive duration; departure = arrival + dwell minutes.
    - Multi-stop Google Maps Navigation URL generator with route-forcing anchors.
    - Automatic partitioning of routes with >9 intermediate waypoints into morning/afternoon legs.
  - **Required Invariant Test Scenarios:**
    1. *Cascade Ripple:* Modifying dwell time on stop 2 accurately shifts arrival timestamps on stops 3 through N.
    2. *Timezone Shifts:* Crossing from AZ (MST, UTC-7) into NM (MDT, UTC-6) applies the +1 hour jump correctly.
    3. *Google Maps URL Length:* An 11-waypoint route is split into two valid Google Maps URLs with $\le 9$ intermediate stops each.
  - **Stage 1: Machine-Executable Gate:**
    ```bash
    cd route-builder && npm run test:engine
    ```
  - **Stage 2: Code Review Subagent:** Confirms math formulas match Section 4.2 of the architecture doc and URL encoding is standard.

- [ ] **Phase 2C: AI Co-Pilot Enrichment via `agy` CLI & Cloud Fallback**
  - **Component Boundary:** `route-builder/server/ai.ts`, `route-builder/src/components/AiAlertModal.tsx`
  - **Deliverables:** AI endpoint, preview modal, unit/mock tests.
  - **Scope:**
    - Primary engine: shells out to `agy -p "..." --output-format json` using active Antigravity session (Gemini 3.8). Zero API keys required.
    - Cloud engine fallback: direct Google AI Studio API (`gemini-3.8-flash`) if an API key is provided.
    - Enforces strict JSON schema: `title` $\le 30$ chars, `message` $\le 2$ lines, `speech` 15–25 words, `recommended_trigger_radius_miles` numeric.
    - Day-level batching support (generates all stops for a day in 1 single prompt).
  - **Required Invariant Test Scenarios:**
    1. Prompt generator correctly formats all contextual parameters (highway, heading, target time).
    2. Schema parser catches and truncates titles exceeding 30 characters.
    3. Day-level batch prompt returns an array of alerts in a single API invocation.
    4. Client-side queue prevents concurrent request bursts.
  - **Stage 1: Machine-Executable Gate:**
    ```bash
    cd route-builder && npm run test:ai
    ```
  - **Stage 2: Code Review Subagent:** Confirms prompt adheres to co-pilot voice rules and error handling falls back gracefully if `agy` is unavailable.

- [ ] **Phase 2D: Export, 1-Click ADB Push & Phone Handoff**
  - **Component Boundary:** `route-builder/src/engine/export.ts`, `route-builder/server/device.ts`
  - **Deliverables:** JSON exporter, `POST /api/device/push`, local Wi-Fi QR code endpoint.
  - **Scope:**
    - 1-Click ADB Push: backend executes `adb push` to connected phone.
    - Local Wi-Fi QR server: phone scans QR code to download `.json` directly over Wi-Fi.
  - **Required Invariant Test Scenarios:**
    1. *Cross-Platform Compatibility:* Exported JSON passes deserialization inside the Android app's test suite (`ItineraryTest.kt`).
    2. *Device Connection Handling:* ADB push returns a clean error if no phone is connected rather than hanging.
  - **Stage 1: Machine-Executable Gate:**
    ```bash
    cd route-builder && npm run test:schema && cd .. && ./gradlew testDebugUnitTest
    ```
  - **Stage 2: Code Review Subagent:** Validates exported JSON against the official Android schema and confirms QR code URL formatting.

---

## 3. Subagent Dispatch Prompt Templates

### Worker Subagent Prompt Template
```text
You are the implementation engineer for [PHASE_NAME].
Your objective: [EXPLICIT_GOAL]

Component Boundary: You own code under [DIRECTORY_OR_PACKAGE].
You have full agency to create helper files, utilities, and tests within this boundary.

Primary Technical Specification: Read docs/route_builder_research_and_architecture.md for data models, formulas, and domain rules.

Required Test Scenarios you must implement and pass:
[LIST_OF_INVARIANT_SCENARIOS]

When finished, verify your work with:
[STAGE_1_GATE_COMMAND]

Fix any errors until this command exits with code 0. Report back with the list of created/modified files and the test output.
```

### Code Reviewer Subagent Prompt Template
```text
You are the independent Code Reviewer and QA Lead for [PHASE_NAME].
Objective: Review the git diff against the deliverables and required test scenarios in docs/ORCHESTRATION_PLAN.md.

Check specifically for the 'Self-Grading Student' trap:
1. Did the worker write rigorous tests that actually test the required invariant scenarios (including error states and edge cases), or are the tests trivial assert-true mocks?
2. Does the code adhere to AGENTS.md (offline-first, proper coroutine dispatchers, no hardcoded API keys)?
3. Does the implementation align with docs/route_builder_research_and_architecture.md?

Output either:
- APPROVED: with a brief summary of why the code is sound.
- CHANGES_REQUESTED: with specific, actionable bullet points explaining what must be fixed.
```
