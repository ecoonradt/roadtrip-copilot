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
* **Single-Row Header:** Keep the trip title shrinkable and compact secondary controls at narrower widths. Account details and Sign out live in a click-to-open avatar/initials popover with keyboard support; never hide overflowing actions with clipping.

### D. Pluggable AI Harness Adapters
* AI generation adheres to the `AiHarnessAdapter` interface (`server/services/aiService.ts`):
  * `AwsBedrockHarnessAdapter` (`server/services/bedrockService.ts`): Primary cloud adapter using Amazon Bedrock's unified `ConverseCommand` and `ConverseStreamCommand` (`@aws-sdk/client-bedrock-runtime`). Defaults to `us.moonshotai.kimi-k3` for Route Scout and `us.amazon.nova-2-lite-v1:0` for alert copywriting (`ADR-0010`), normalizes bare foundation model IDs to system-defined `us.` inference profiles where required, and exposes an allowlisted multi-vendor model catalog (`GET /api/ai/status`) for runtime UI selection.
  * `AgyHarnessAdapter`: Local Antigravity CLI dynamically resolving the latest Flash model.
  * `GeminiStudioHarnessAdapter`: Cloud API defaulting to `gemini-3.8-flash`.
  * Graceful UI Disabling: AI features (alert copywriting and Route Scout) require an active AI engine or API key; when unavailable, the studio gracefully disables all AI buttons with informative tooltips.
* Enforces constraints: titles $\le 30$ chars, spoken messages 15–25 words ($\le 2$ lines), trigger radii clamped to $[0.3, 6.0]$ miles. Client-side `AiQueue` limits concurrency.

### E. Route Scout Conversational Co-Pilot & Adapter Seam
* **Role & Scoping:** A dedicated conversational road-trip co-pilot (`RouteScoutDrawer.tsx`, `scoutService.ts`, `/api/ai/scout/*`) operating in two distinct scopes:
  * **Day Scope:** Evaluates overall driving pace, scenic corridors, overlook opportunities, and meal/fuel deserts.
  * **Waypoint Scope:** Audits road accessibility (paved vs. dirt), parking pull-offs, lighting/golden hour timing, and coordinate precision.
* **Pluggable Adapter Seam:** The core road-trip domain prompt (`buildScoutDomainPrompt`) is kept strictly pure and harness-agnostic. All harness-specific tool permissions and execution rules live behind the `AiHarnessAdapter` lifecycle hooks:
  * `AwsBedrockHarnessAdapter.generateStreamWithTools`: Executes multi-turn `ConverseStreamCommand` tool loops (`MAX_TOOL_ITERATIONS = 5`, parallel `Promise.all` tool dispatch) with `activity`, `thought`, and `delta` SSE streaming and `<thinking>`/`<think>` reasoning tag hygiene.
  * `decorateScoutPrompt?(domainPrompt)`: In `AgyHarnessAdapter`, grants research and calculation tools (`search_web`, `read_url_content`, and `run_command` for fast coordinate math/network checks); strictly forbids background tasks, subagents, interactive questions (`ask_question`), browser sessions, and modifications to workspace files.
  * `sanitizeResponse?(rawText)`: Strips internal harness preambles, `<thinking>`/`<think>` XML blocks, and trailing meta-commentary from driver-facing prose.
* **Interactive Suggestion Cards & Human-in-the-Loop Verification:** Emits actionable candidate blocks (`json:suggestions`) allowing 1-click **Add Waypoint** or **Update Waypoint** with dynamic map preview pins before driver approval. Operates under the principle that AI assistants are valuable discovery advisors but require human verification for real-world geometry. The UI supports an in-app "Test on Google Maps" query link, `place_name` vs `name` decoupling, and automatic Place ID extraction from pasted Maps URLs to lock in verified locations.
* **SSE Streaming & Keep-Alive Heartbeats:** Streams tokens over `/api/ai/scout/chat/stream` with immediate `: ping\n\n` and periodic `: keep-alive\n\n` SSE comments to keep CloudFront and Lambda Function URL streams alive during multi-turn tool calls.

### F. Timeline Cascade, Navigation Links & Device Handoff
* **Timeline Schedule Cascade:** Recalculates arrival/departure times across waypoints; modifying dwell time on stop $k$ ripples through stops $k+1 \dots n$. Supports backward scheduling from destination deadlines ("Catch-up" mode) and timezone border offset jumps.
* **Google Maps Links & Place Decoupling:** Generates multi-stop driving links with route-forcing anchors. Drives exceeding 9 intermediate stops are automatically partitioned into consecutive legs ($\le 9$ intermediate stops each) with dedicated QR codes. Decouples human-friendly display titles (`name`) from clean Google Maps queries (`place_name`), supports positional intermediate `waypoint_place_ids` (`|ChIJ...||`), and auto-extracts base64url Place IDs directly from pasted Maps URLs in the edit drawer.
* **Device Handoff & Discovery:** Supports instant 1-scan QR code phone handoff via Google Code Scanner, local/cloud download staging (`GET /api/device/download/:filename`), and Android SAF file picker import. Discovers workspace itineraries via Fastify `/api/itineraries` and supports multi-day navigation tabs (`DayTabBar.tsx`).

### G. Dual-Mode Google OIDC Authentication & Allowlist Gating
* **Zero-Trust Cloud Gate (`AUTH_ENABLED === 'true'`):** Protects `/api/*` endpoints via `authGuard.ts` (`preHandler` hook) supporting both browser sessions (`HTTP-Only`, `SameSite=Lax`, `Secure` cookie `copilot_session`) and native Android clients (`Authorization: Bearer <jwt>`), verified against `ALLOWED_EMAILS` (`401 Unauthorized` when unauthenticated, `403 Forbidden` when not allowlisted).
* **Hybrid Local Dev Bypass (`AUTH_ENABLED !== 'true'`):** Automatically bypasses OIDC enforcement and injects a deterministic local developer user (`local-dev@localhost`) during `npm run dev` and automated tests.
* **Session Recovery:** Startup and retry checks remain fail-closed, with delayed connection feedback, a 15-second deadline, and a connection-error Retry action. Superseded requests must not replace the current session state.
* **Runtime SSM Secret Resolution:** Resolves `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `JWT_SECRET`, and `ALLOWED_EMAILS` from direct environment variables first, falling back to cached AWS SSM Parameter Store `SecureString` lookups (`/roadtrip-copilot/*`) on Lambda cold start.

### H. Amazon S3 Atomic Itinerary Persistence & ETag Concurrency Safety
* **Dual-Mode Persistence (`S3_STORAGE_BUCKET`):** When `S3_STORAGE_BUCKET` is configured, `ItineraryStorageService` delegates to `S3ItineraryStorageService` (`s3://<bucket>/users/{email}/itineraries/{slug}.json`), scoping itineraries to the authenticated user's email prefix. No bundled sample file is read, listed, protected, or deleted: the sample route is generated in code by `src/engine/sampleTrip.ts` and is only surfaced when starting a new route.
* **Single Storage Source of Truth:** The service treats every stored file generically (the only protection rule is "writes outside the primary write directory are read-only"). `listItineraries` returns exactly the user's objects; a missing active route is a plain `404` that opens the route chooser rather than loading a fallback route.
* **Hybrid Local Dev Isolation:** When `S3_STORAGE_BUCKET` is unset (default in `npm run dev` and automated tests), `ItineraryStorageService` delegates to `LocalFileSystemStorageService` (`itineraries/*.json`), ensuring local development never touches or corrupts production S3 data.
* **Atomic Conditional Writes (`ETag` / `If-Match` / `If-None-Match`):** Both storage backends and `/api/itineraries/*` endpoints enforce HTTP `ETag` headers and conditional writes (`If-Match` and `If-None-Match: *`). Stale writes and race conditions are safely rejected with `HTTP 412 Precondition Failed`.

---

## 3. Directory Layout

```
route-builder/
├── Dockerfile                  # Multi-stage Docker build with AWS Lambda Web Adapter streaming
├── .dockerignore               # Docker build exclusions
├── AGENTS.md                   # This handbook & subproject directory layout
├── README.md                   # User-facing web studio documentation & setup
├── index.html                  # HTML entrypoint
├── package.json                # Project dependencies and test scripts
├── tsconfig.json               # Frontend TypeScript configuration
├── tsconfig.server.json        # Backend TypeScript configuration
├── vite.config.ts              # Vite dev server and /api proxy configuration
├── playwright.config.ts        # Chromium header/account acceptance tests against a fixture-backed frontend
├── tailwind.config.js          # Dark automotive theme color palette
├── server/
│   ├── app.ts                  # Fastify application factory
│   ├── index.ts                # Server entrypoint (:3001)
│   ├── loadEnv.ts              # Node 20.12+ .env loader side-effect module
│   ├── hooks/
│   │   └── authGuard.ts        # Dual-mode OIDC cookie/Bearer JWT & allowlist preHandler hook
│   ├── routes/
│   │   ├── auth.ts             # /api/auth (status, Google OAuth2 PKCE redirect/callback, mobile token, logout)
│   │   ├── routing.ts          # /api/routing (Nominatim geocode & OSRM route proxies)
│   │   ├── ai.ts               # /api/copilot/generate, /api/copilot/day-title & /api/ai/status
│   │   ├── device.ts           # /api/device (network-info, staging, download)
│   │   ├── itineraries.ts      # /api/itineraries (workspace discovery)
│   │   └── scout.ts            # /api/ai/scout (conversational assistant, SSE stream & quick prompts)
│   ├── services/
│   │   ├── authService.ts      # Google OIDC token verification, PKCE, HS256 JWT signing & SSM secret loader
│   │   ├── geocodeService.ts   # Nominatim integration with compliant User-Agent
│   │   ├── routeService.ts     # OSRM road graph query engine (literal semicolon paths)
│   │   ├── routeCache.ts       # LRU coordinate cache with toFixed(5) precision
│   │   ├── promptBuilder.ts    # Prompt contract generator
│   │   ├── schemaParser.ts     # Title truncation (<=30 chars), radius clamping, TTS cleanup
│   │   ├── bedrockService.ts   # Amazon Bedrock Converse / ConverseStream adapter & model catalog
│   │   ├── aiService.ts        # Pluggable AI adapters (Bedrock, Agy, Gemini API) & availability status
│   │   ├── deviceService.ts    # Local IP network discovery and in-memory itinerary staging
│   │   ├── itineraryStorageService.ts # Multi-day JSON parsing and disk/S3 storage
│   │   └── scoutService.ts     # Route Scout prompt builder, parser, and streaming service
│   └── types/                  # Strict server TypeScript types (auth, routing, ai, scout)
├── src/
│   ├── App.tsx                 # Main layout, auth gate & interactive map state coordinator
│   ├── components/
│   │   ├── AppHeader.tsx       # Single-row responsive top bar with route title, metrics, and global actions
│   │   ├── AccountMenu.tsx     # Avatar/initials trigger and keyboard-accessible account details/sign-out popover
│   │   ├── AuthGateScreen.tsx  # Google OIDC sign-in & 403 private preview restriction screen
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
│   │   ├── sampleTrip.ts       # In-code relative (ad-hoc) sample route factory
│   │   └── types.ts            # Mathematical & engine data contracts
│   ├── services/
│   │   ├── api.ts              # Frontend API client
│   │   └── aiQueue.ts          # Client-side concurrency limiter
│   └── types/                  # Frontend data models (auth, routing, ai, scout)
└── tests/                      # Vitest regression suites
    ├── ai/                     # Harness adapters, alert/schema generation, Scout
    ├── backend/                # Auth, routing, storage, device handoff, geocoding
    ├── engine/                 # Cascade, schema, timezone and navigation-link math
    ├── ui/                     # Portable React scheduling, account, and auth recovery tests & harness
    └── browser/                # Playwright geometry and account interaction regressions (*.browser.ts)
```

> **Local dev workspace:** user-authored routes are written to the repo-root `itineraries/` directory
> (git-ignored, `.gitkeep` only). `LocalFileSystemStorageService` resolves it as `../itineraries`
> from `route-builder/`; no sample file is bundled there.

---

## 4. Development & Testing Commands

```bash
# Start both Frontend (:5173) and Backend (:3001)
npm run dev

# Run all Vitest suites
npm test

# Browser acceptance tests (one-time setup: npx playwright install chromium)
npm run test:browser

# Granular test suites
npm run test:backend  # Fastify routing proxies, Nominatim headers, OSRM cache
npm run test:engine   # Timeline cascade math, dwell ripples, Google Maps URL chunking
npm run test:ai       # Prompt formatting, schema sanitization, batching, adapters, client queue, scout
npm run test:schema   # Itinerary V2 JSON export and ADB device service

# Production compile (client Vite bundle + backend tsc)
npm run build

# Full verification pipeline across route-builder, infra CDK, and Android (invoked from repo root)
./scripts/ci_check.sh

# On-demand AWS CDK serverless deployment (invoked from repo root)
./scripts/deploy_cloud.sh
```

---

## 5. Rules for Contributing Developers & Agents
1. **Maintain Directory Layout in Section 3:** Whenever adding, removing, or relocating files within `route-builder/`, update the Directory Layout in Section 3 so developers and agents can navigate the module without scanning the entire tree.
2. **Strict TypeScript:** Never use `any`. Always supply strict types for new endpoints, hooks, and utilities.
3. **No URL-Encoding on OSRM Path Semicolons:** Always use literal `;` in coordinate path parameters.
4. **Preserve Backward Compatibility:** Any changes to exported itinerary JSON must conform to the V2 schema expected by the Android native co-pilot service.
5. **Preserve Route Scout Prompt Purity:** Keep `buildScoutDomainPrompt` strictly domain-focused without harness-specific tool bans or shell commands. All harness-specific tool permissions, guardrails, and response cleaning must be implemented through the `AiHarnessAdapter` seam (`decorateScoutPrompt` and `sanitizeResponse`).
6. **No Silent Fallbacks or Mock Degradation:** Never implement silent fallbacks (such as catching a failure in Bedrock, S3, OSRM, or Google OIDC and falling back to mock templates, client-side mocks, or local CLI tools like `agy`). Silent fallbacks mask real system failures and fail completely in cloud environments (where local tools like `agy` do not exist). External API failures must fail loudly, immediately, and transparently with proper HTTP status codes (`502 Bad Gateway`, `503 Service Unavailable`, `400 Bad Request`). Silent fallbacks are almost always wrong; check with the user and obtain explicit approval before building any fallback mechanism.
