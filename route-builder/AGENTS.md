# AGENTS.md — Route Builder Web Studio Handbook

## 1. Subproject Scope & Purpose
* **Scope:** This handbook governs the `route-builder/` web studio subproject.
* **Role:** A desktop-first React + Fastify itinerary authoring studio for **Roadtrip Co-Pilot**. It allows users to author multi-stop road trip itineraries, cascade schedules, generate AI waypoint alerts, preview TTS audio, and sync directly with mobile devices.

---

## 2. Architectural Pillars

### A. Strict TypeScript & Typing Discipline
* `tsconfig.json` and `tsconfig.server.json` enforce `strict: true` with **zero `any` types**.
* Error handling must use `catch (err: unknown)` narrowed with `err instanceof Error`.
* Fastify route contracts use typed generic schemas for params, queries, and bodies.

### B. Routing Protocol & OSRM Semicolon Rule
* Coordinate paths sent to the upstream OSRM routing engine must use literal `;` delimiters (e.g. `/${formattedCoords}?overview=...`).
* **Never URL-encode semicolons as `%3B` in OSRM path segments**, as the router rejects `%3B` with HTTP 400 `InvalidUrl`.
* In-memory LRU caching (`routeCache.ts`) deduplicates routing requests rounded to 5 decimal places.

### C. Human-Centered UI/UX Principles
* **Clean Visual Hierarchy:** Scannable cards in `TimelineSidebar.tsx` with progressive disclosure for deep edits.
* **Zero Technical Jargon:** Never render internal verification tags, debug counters, or raw mathematical formulas in primary UI.
* **Responsive Workspace:** Resizable sidebar (320px–680px) with `localStorage` persistence and double-click reset.

### D. Pluggable AI Harness Adapters
* AI generation adheres to the `AiHarnessAdapter` interface (`server/services/aiService.ts`):
  * `AgyHarnessAdapter`: Local Antigravity CLI dynamically resolving the latest Flash model.
  * `GeminiStudioHarnessAdapter`: Cloud API defaulting to `gemini-3.8-flash`.
  * `TemplateHarnessAdapter`: Deterministic offline fallback.
* Enforces constraints: titles $\le 30$ chars, spoken messages 15–25 words ($\le 2$ lines), trigger radii clamped to $[0.3, 6.0]$ miles. Client-side `AiQueue` limits concurrency.

### E. Route Scout Conversational Co-Pilot & Adapter Seam
* **Role & Scoping:** A dedicated conversational road-trip co-pilot (`RouteScoutDrawer.tsx`, `scoutService.ts`, `/api/ai/scout/*`) operating in two distinct scopes:
  * **Day Scope:** Evaluates overall driving pace, scenic corridors, overlook opportunities, and meal/fuel deserts.
  * **Waypoint Scope:** Audits road accessibility (paved vs. dirt), parking pull-offs, lighting/golden hour timing, and coordinate precision.
* **Pluggable Adapter Seam:** The core road-trip domain prompt (`buildScoutDomainPrompt`) is kept strictly pure and harness-agnostic. All harness-specific tool permissions and execution rules live behind the `AiHarnessAdapter` lifecycle hooks:
  * `decorateScoutPrompt?(domainPrompt)`: In `AgyHarnessAdapter`, grants research and calculation tools (`search_web`, `read_url_content`, and `run_command` for fast coordinate math/network checks); strictly forbids background tasks, subagents, interactive questions (`ask_question`), browser sessions, and modifications to workspace files.
  * `sanitizeResponse?(rawText)`: In `AgyHarnessAdapter`, strips internal harness preambles (e.g. background task yields) and trailing meta-commentary from driver-facing prose.
  * Cloud and future adapters (Claude Code, OpenAI, Codex) plug into this seam with their respective tool declarations and prompt decorations.
* **Interactive Suggestion Cards:** Emits actionable candidate blocks (`json:suggestions`) allowing 1-click **Add Waypoint** or **Update Waypoint** with dynamic map preview pins before driver approval.
* **SSE Streaming:** Streams tokens over `/api/ai/scout/chat-stream` with collapsible reasoning/tool thought capture.

---

## 3. Directory Layout

```
route-builder/
├── AGENTS.md                   # This handbook & subproject directory layout
├── README.md                   # User-facing web studio documentation & setup
├── index.html                  # HTML entrypoint
├── package.json                # Project dependencies and test scripts
├── tsconfig.json               # Frontend TypeScript configuration
├── tsconfig.server.json        # Backend TypeScript configuration
├── vite.config.ts              # Vite dev server and /api proxy configuration
├── tailwind.config.js          # Dark automotive theme color palette
├── server/
│   ├── app.ts                  # Fastify application factory
│   ├── index.ts                # Server entrypoint (:3001)
│   ├── routes/
│   │   ├── routing.ts          # /api/routing (Nominatim geocode & OSRM route proxies)
│   │   ├── ai.ts               # /api/copilot/generate (single & batch)
│   │   ├── device.ts           # /api/device (status, push, download, staging)
│   │   ├── itineraries.ts      # /api/itineraries (workspace discovery)
│   │   └── scout.ts            # /api/ai/scout (conversational assistant & quick prompts)
│   ├── services/
│   │   ├── geocodeService.ts   # Nominatim integration with compliant User-Agent
│   │   ├── routeService.ts     # OSRM road graph query engine (literal semicolon paths)
│   │   ├── routeCache.ts       # LRU coordinate cache with toFixed(5) precision
│   │   ├── promptBuilder.ts    # Prompt contract generator
│   │   ├── schemaParser.ts     # Title truncation (<=30 chars), radius clamping, TTS cleanup
│   │   ├── aiService.ts        # Pluggable AI adapters (Agy, Gemini API, template fallback)
│   │   ├── deviceService.ts    # ADB subprocess management and local IP Wi-Fi discovery
│   │   ├── itineraryStorageService.ts # Multi-day JSON parsing and disk storage
│   │   └── scoutService.ts     # Route Scout prompt builder, parser, and fallbacks
│   └── types/                  # Strict server TypeScript types (routing, ai, scout)
├── src/
│   ├── App.tsx                 # Main layout & interactive map state coordinator
│   ├── components/
│   │   ├── AppHeader.tsx       # Top bar with route title, metrics, search, and global actions
│   │   ├── DayTabBar.tsx       # Multi-day leg switcher tabs
│   │   ├── MapCanvas.tsx       # Leaflet map with custom waypoint markers & OSRM polyline
│   │   ├── SearchBar.tsx       # Debounced address search via Nominatim proxy
│   │   ├── TimelineSidebar.tsx # Timeline stops, streamlined quick editor, cascade telemetry, Google Maps links
│   │   ├── RouteSelectorModal.tsx # Workspace route discovery and selection modal
│   │   ├── EditWaypointModal.tsx # Full waypoint details, place entity precision & AI in-car alert modal
│   │   ├── AiAlertModal.tsx    # Backward-compatible re-export of EditWaypointModal
│   │   ├── ExportModal.tsx     # 1-click ADB push, Wi-Fi QR code, Google Maps leg QR codes
│   │   └── RouteScoutDrawer.tsx # Right-side conversational AI assistant & suggestion cards
│   ├── engine/
│   │   ├── cascade.ts          # Timeline cascade & timezone border calculation
│   │   ├── googleMapsUrl.ts    # Multi-stop URL generator with <=9 stop chunking
│   │   ├── export.ts           # Itinerary V2 JSON exporter
│   │   ├── itineraryParser.ts  # Multi-day and single-route JSON ingestion
│   │   └── types.ts            # Mathematical & engine data contracts
│   ├── services/
│   │   ├── api.ts              # Frontend API client
│   │   └── aiQueue.ts          # Client-side concurrency limiter
│   └── types/                  # Frontend data models (routing, ai, scout)
└── tests/                      # Comprehensive Vitest test suites (157 tests)
```

---

## 4. Development & Testing Commands

```bash
# Start both Frontend (:5173) and Backend (:3001)
npm run dev

# Run all Vitest suites
npm test

# Granular test suites
npm run test:backend  # Fastify routing proxies, Nominatim headers, OSRM cache
npm run test:engine   # Timeline cascade math, dwell ripples, Google Maps URL chunking
npm run test:ai       # Prompt formatting, schema sanitization, batching, adapters, client queue, scout
npm run test:schema   # Itinerary V2 JSON export and ADB device service

# Production compile (client Vite bundle + backend tsc)
npm run build
```

---

## 5. Rules for Contributing Developers & Agents
1. **Maintain Directory Layout in Section 3:** Whenever adding, removing, or relocating files within `route-builder/`, update the Directory Layout in Section 3 so developers and agents can navigate the module without scanning the entire tree.
2. **Strict TypeScript:** Never use `any`. Always supply strict types for new endpoints, hooks, and utilities.
3. **No URL-Encoding on OSRM Path Semicolons:** Always use literal `;` in coordinate path parameters.
4. **Preserve Backward Compatibility:** Any changes to exported itinerary JSON must conform to the V2 schema expected by the Android native co-pilot service.
5. **Preserve Route Scout Prompt Purity:** Keep `buildScoutDomainPrompt` strictly domain-focused without harness-specific tool bans or shell commands. All harness-specific tool permissions, guardrails, and response cleaning must be implemented through the `AiHarnessAdapter` seam (`decorateScoutPrompt` and `sanitizeResponse`).
