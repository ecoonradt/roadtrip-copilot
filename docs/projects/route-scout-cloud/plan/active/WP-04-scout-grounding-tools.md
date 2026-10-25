# WP-04: Discovery + Deterministic Domain Grounding Tool Library

* **Milestone:** Milestone 4 (M4) — Discovery + Deterministic Domain Grounding Tool Library
* **Status:** Code Complete (Deploy Pending AWS Support)
* **Branch:** `feat/m4-scout-grounding-tools`
* **Governing Documents:**
  * Architecture Blueprint: [`route_scout_cloud_architecture.md`](../../route_scout_cloud_architecture.md)
  * Phase Roadmap: [`plan/ROADMAP.md`](../ROADMAP.md)
  * Working Model: [`WORKING_MODEL.md`](../../WORKING_MODEL.md)
  * Architecture Decisions: [`DECISIONS.md`](../../DECISIONS.md), [`ADR-0001`](../../decisions/0001-amazon-bedrock-single-bill-ai.md), [`ADR-0004`](../../decisions/0004-hybrid-local-dev-mode.md), [`ADR-0005`](../../decisions/0005-cdk-iac-and-github-actions-cicd.md), [`ADR-0007`](../../decisions/0007-ssm-secure-runtime-config-and-cloudfront-forwarded-host.md), [`ADR-0010`](../../decisions/0010-bedrock-inference-profiles-and-model-catalog.md), [`ADR-0011`](../../decisions/0011-bedrock-discovery-with-exclusions-and-lifecycle-integrity.md)

---

## 1. Objective & Explicit Non-Goals

### Objective
Implement the 7 backend Fastify tools (2 web discovery + 5 deterministic road-trip domain grounding tools) in `route-builder/server/services/scoutTools.ts`, wire them into `ScoutService` and `AwsBedrockHarnessAdapter` for concurrent execution (`Promise.all`) with live SSE `activity` streaming, implement deterministic server-side suggestion hydration from cached `resolve_and_standardize_place` results, add full `"delete_waypoint"` suggestion support across backend parsing and the React Web Studio (`RouteScoutDrawer.tsx` & `App.tsx`), and configure Google Places API and Brave Search API secret parameters in AWS CDK (`infra/`).

### Explicit Non-Goals
* **No Amazon Location Service Fallback:** Per Rule 12 (No Silent Fallbacks) and explicit owner confirmation, `snap_to_highway_corridor`, `calculate_detour_impact`, and `audit_corridor_waypoints` use OSRM strictly (`/nearest/v1/driving` and `/route/v1/driving`) and fail loudly on upstream errors without falling back to Amazon Location Service or mock data.
* **No Live Cloud Deployment in This Session:** Because the owner's AWS account is currently inaccessible pending AWS Support recovery, M4 will be delivered as a fully verified green PR (`./scripts/ci_check.sh` + `npm run test:browser` + multi-model adversarial review gates) without executing `scripts/deploy_cloud.sh`.
* **No Stripe Billing or User Wallet Ledgers:** Deferred to Phase 2 (M5).

---

## 2. Gate 1 Contract-First Specifications & Invariants

### A. Shared Types (`server/types/scout.ts` & `src/types/scout.ts`)
1. Update `ScoutSuggestion.action` in both `route-builder/server/types/scout.ts` and `route-builder/src/types/scout.ts`:
   ```ts
   export interface ScoutSuggestion {
     id: string;
     action: 'add_waypoint' | 'update_waypoint' | 'delete_waypoint';
     name: string;
     place_name?: string;
     type: string;
     lat: number;
     lng: number;
     dwell_minutes?: number;
     trigger_radius_miles?: number;
     reason: string;
     insertAfterWaypointId?: string;
     targetWaypointId?: string;
     newId?: string;
     address?: string;
     google_place_id?: string;
     is_route_anchor?: boolean;
     notification?: {
       title: string;
       message: string;
       speech: string;
     };
   }
   ```

### B. Discovery & Domain Grounding Tool Library (`route-builder/server/services/scoutTools.ts`)
1. **7 Canonical Tool Declarations (`SCOUT_TOOL_DECLARATIONS: ToolDeclaration[]`):**
   * `search_web`:
     - Input Schema: `{ type: 'object', properties: { query: { type: 'string', description: '...' }, count: { type: 'number', description: 'Optional max results (1-10, default 5)' } }, required: ['query'] }`
   * `read_url_content`:
     - Input Schema: `{ type: 'object', properties: { url: { type: 'string', description: 'HTTP/HTTPS URL to fetch and extract readable text from' } }, required: ['url'] }`
   * `resolve_and_standardize_place`:
     - Input Schema: `{ type: 'object', properties: { query: { type: 'string', description: 'Establishment name and city/highway context' }, lat: { type: 'number' }, lng: { type: 'number' }, radius_miles: { type: 'number' } }, required: ['query'] }`
   * `snap_to_highway_corridor`:
     - Input Schema: `{ type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' }, road_name: { type: 'string', description: 'Optional highway designation (e.g. US-89, AZ-179, I-40)' } }, required: ['lat', 'lng'] }`
   * `calculate_detour_impact`:
     - Input Schema: `{ type: 'object', properties: { candidate_lat: { type: 'number' }, candidate_lng: { type: 'number' }, after_waypoint_id: { type: 'string' } }, required: ['candidate_lat', 'candidate_lng', 'after_waypoint_id'] }`
   * `simulate_schedule_cascade`:
     - Input Schema: `{ type: 'object', properties: { action: { type: 'string', enum: ['add', 'update', 'delete'] }, target_waypoint_id: { type: 'string' }, dwell_minutes: { type: 'number' }, candidate_lat: { type: 'number' }, candidate_lng: { type: 'number' }, candidate_name: { type: 'string' }, candidate_type: { type: 'string' } }, required: ['action', 'target_waypoint_id'] }`
   * `audit_corridor_waypoints`:
     - Input Schema: `{ type: 'object', properties: { day_number: { type: 'number' } } }`

2. **Per-Turn Grounding Context & Concurrency Isolation (`TurnGroundingCache` & `ScoutToolExecutionContext`):**
   * Never store turn-scoped resolved places or trip context on mutable shared instance properties of `ScoutToolLibrary` or `ScoutService`.
   * Every `chat()` and `chatStream()` call creates an isolated `TurnGroundingCache`:
     ```ts
     export interface ResolvedPlaceRecord {
       query: string;
       place_name: string;
       display_name: string;
       address: string;
       lat: number;
       lng: number;
       google_place_id?: string;
       types?: string[];
       weekday_descriptions?: string[];
     }

     export interface TurnGroundingCache {
       resolvedPlaces: ResolvedPlaceRecord[];
       knownPlaceIds: Set<string>;
     }

     export interface ScoutToolExecutionContext {
       tripContext: ScoutTripContext;
       scope?: ScoutScope;
       abortSignal?: AbortSignal;
       groundingCache?: TurnGroundingCache;
     }
     ```

3. **Runtime SSM Secret Resolution & Region Invariant (`ScoutToolLibraryOptions`):**
   * `ScoutToolLibrary` resolves `googlePlacesApiKey` (`GOOGLE_PLACES_API_KEY` or SSM `GOOGLE_PLACES_API_KEY_SSM_PARAM` defaulting to `'/roadtrip-copilot/google-places-api-key'` when env var is set) and `braveSearchApiKey` (`BRAVE_SEARCH_API_KEY` or SSM `BRAVE_SEARCH_API_KEY_SSM_PARAM` defaulting to `'/roadtrip-copilot/brave-search-api-key'` when env var is set).
   * **Never hardcode `'us-east-1'`**: `const region = this.options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION; const client = new SSMClient(region ? { region } : {});`.
   * **Lazy per-tool secret resolution**: Only resolve the Brave API key when `search_web` is invoked; only resolve the Google Places API key when `resolve_and_standardize_place` is invoked. Tools that do not use API keys (`read_url_content`, `snap_to_highway_corridor`, `calculate_detour_impact`, `simulate_schedule_cascade`, `audit_corridor_waypoints`) must never make SSM calls or fail when keys are unconfigured.
   * **Caching & Cooldown**: Cache resolved SSM secrets for `CONFIG_CACHE_TTL_MS = 15 * 60 * 1000` (15 minutes) with deduplicated in-flight `loadPromise` and `LOAD_RETRY_COOLDOWN_MS = 30 * 1000` (30 seconds) retry cooldown on failure or missing parameter.
   * **Zero Silent Fallbacks (Rule 12)**: If a required API key is missing or an upstream API returns non-2xx, throw a descriptive `Error` immediately—never return mock search results or fake Places records.

4. **SSRF, Redirect, Size & Timeout Hardening in `read_url_content`:**
   * Accept `{ url }` (or legacy `{ Url }` alias). Validate with `assertSafeExternalUrl(url)`:
     - Must parse via `new URL(url)` with protocol strictly `'http:'` or `'https:'`.
     - Reject any URL containing credentials (`parsed.username || parsed.password`).
     - Reject hostnames matching `localhost`, `*.localhost`, `*.local`, `*.internal`, `metadata.google.internal`, `metadata`, or IP literals in private/loopback/link-local/cloud-metadata ranges:
       * IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (CGNAT), `127.0.0.0/8`, `169.254.0.0/16` (AWS IMDS `169.254.169.254`), `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4`.
       * IPv6: `::`, `::1`, `fc00::/7` (`fc00::`–`fdff::`, including AWS IMDSv2 IPv6 `fd00:ec2::254`), `fe80::/10`, and IPv4-mapped IPv6 `::ffff:a.b.c.d` / `::ffff:xxxx:xxxx` where the embedded IPv4 address is private/reserved.
      - Follow HTTP `301`/`302`/`303`/`307`/`308` redirects manually (`redirect: 'manual'`, max `3` hops), validating every resolved `Location` target against `assertSafeExternalUrl` and bounded DNS resolution before fetching so an external site can never redirect to `http://169.254.169.254` or `http://127.0.0.1`!
      - Bind DNS validation to the actual socket connection on every hop: resolve DNS once per hop (bounded by request timeout and `abortSignal`), validate all returned A/AAAA records via `assertSafeIpAddress`, and connect exclusively to the validated IP(s) via a pinned HTTP/HTTPS transport (`lookup` callback returning only the validated addresses, `agent: false`, preserving the original `Host` header and HTTPS TLS `servername` SNI/certificate verification). Never perform an unchecked second DNS lookup at connection time.
      - Enforce per-request timeout (`timeoutMs = 10_000`) and abort propagation (`abortSignal`) across DNS resolution, socket connection, and full response body consumption; reject binary content types (`image/*`, `audio/*`, `video/*`, `application/pdf`, `application/octet-stream`, `application/zip`); cap raw body read at `512 * 1024` bytes; cap extracted Markdown/text at `maxChars = 12_000`; and use strictly linear $\mathcal{O}(n)$ tag scanning/tokenization (`htmlToReadableText`) without backtracking regexes on malformed or unclosed generic tags.

5. **Google Places API (New) Contract in `resolve_and_standardize_place`:**
   * Endpoint: `POST https://places.googleapis.com/v1/places:searchText`
   * Headers:
     - `Content-Type: application/json`
     - `X-Goog-Api-Key: <resolvedKey>`
     - `X-Goog-FieldMask: places.id,places.displayName,places.formattedAddress,places.location,places.types,places.regularOpeningHours`
   * Body:
     - `textQuery`: trimmed `query`
     - `locationBias` (included only when both `lat` and `lng` are finite numbers within `[-90, 90]` and `[-180, 180]`):
       `{ circle: { center: { latitude: lat, longitude: lng }, radius: clampedRadiusMeters } }`
       where `clampedRadiusMeters = Math.min(50_000, Math.max(100, Math.round((radius_miles ?? 15) * 1609.344)))` (strictly respecting Google Places API New's `50,000m` hard limit).
   * Standardization:
     - Extract clean establishment name via `cleanPlaceName(place.displayName?.text)` (stripping parenthetical suffixes `(...)` and slash prefixes `City / Venue` -> `Venue`).
     - Validate `place.id` using `isValidGooglePlaceId(place.id)`. Only emit `google_place_id` when valid.
     - Push `ResolvedPlaceRecord` into `context.groundingCache.resolvedPlaces` and add valid `google_place_id` to `context.groundingCache.knownPlaceIds`.

6. **OSRM Nearest & Detour Math in `snap_to_highway_corridor`, `calculate_detour_impact`, `simulate_schedule_cascade`, `audit_corridor_waypoints`:**
   * Preserve literal `,` and `;` in OSRM URL paths (Rule 5: never `encodeURIComponent` coordinate path segments).
   * Maintain request deadline and `AbortSignal` cancellation through full JSON body consumption (`res.json()`) across all upstream API calls (`search_web`, `resolve_and_standardize_place`, `snap_to_highway_corridor`, `audit_corridor_waypoints`).
   * `snap_to_highway_corridor`:
     - Calls `${osrmNearestBaseUrl}/${lng},${lat}?number=5` (default `https://router.project-osrm.org/nearest/v1/driving`).
     - If `road_name` is provided, compares complete highway designators (`I-40` vs `I-405`, `US-89` vs `US-89A`, Interstate vs US vs State Route) before allowing non-numbered textual matches, or falls back to `waypoints[0]` with `road_name_matched: false`.
   * `calculate_detour_impact`:
     - Validates `candidate_lat`, `candidate_lng`, and `after_waypoint_id`.
     - Finds `after_waypoint_id` in `context.tripContext.waypoints`. If not found, throws descriptive `Error` listing valid waypoint IDs.
     - Uses `RouteService` (`getRoute`) in parallel (`Promise.all`) to compare baseline leg vs detour leg and returns exact `added_distance_miles` and `added_duration_minutes`.
   * `simulate_schedule_cascade`:
     - Supports `action: 'add' | 'update' | 'delete'` on `context.tripContext.waypoints` using `RouteService` (`getRoute`) for changed legs while retaining valid unchanged-leg durations/distances, propagating aborts and upstream routing errors without straight-line 50 mph fallback estimates, and returning shifted stop arrival/departure times, `timezones_crossed`, and `sunset_warnings` (stops arriving at or after `18:30` local time).
   * `audit_corridor_waypoints`:
     - Concurrently inspects all waypoints in `context.tripContext.waypoints` with bounded concurrency (`MAX_AUDIT_CONCURRENCY = 4`, `MAX_AUDIT_WAYPOINTS = 50`) (OSRM `/nearest` distance check, leg speed `< 30 mph` over `>= 2 mi` check, `isValidGooglePlaceId` check, physical stop address/place_name check, `is_route_anchor` on physical stop check, and notification/ID category & anticipatory future-tense speech check).

### C. Server-Side Suggestion Hydration & `delete_waypoint` (`server/services/scoutService.ts` & `server/services/bedrockService.ts`)
1. **Per-Turn Tool Wiring in `ScoutService`:**
   * Default `this.tools` to `SCOUT_TOOL_DECLARATIONS` when `options.tools` is not explicitly provided.
   * For each `chat()` and `chatStream()` turn, instantiate a fresh `TurnGroundingCache` (seeded with `knownPlaceIds` from `request.tripContext.waypoints`).
   * Dispatch tool calls through `this.toolLibrary.executeTool(name, args, turnContext)` (or if a custom `options.toolDispatcher` was injected, invoke it and also record any valid `resolve_and_standardize_place` result into `groundingCache`).
2. **Deterministic Suggestion Hydration (`hydrateSuggestionFromResolvedPlaces` in `parseScoutResponse`):**
   * Share disambiguated place-matching logic (`matchResolvedPlaceForSuggestion`) between coordinate backfill and suggestion hydration:
     1. Exact `google_place_id` match (never cross-pollinating one branch's ID with another branch's metadata).
     2. Disambiguated normalized `place_name` / `display_name` match: require unambiguous geographic proximity or unambiguous address/qualifier evidence when multiple same-name branches exist or when a single candidate is in a distant city; otherwise leave unhydrated rather than guessing.
     3. Unambiguous close coordinate proximity (`<= 0.15` miles) for commercial `add_waypoint` physical stops (`meal`, `fuel`, `lodging`).
   * For physical stops (`!isInTransitOrAnchorSuggestion`), replace model `place_name` and `address` with available non-empty authoritative fields from the matched record, attach `matched.google_place_id` (if valid), and (for commercial stops or exact ID matches) apply verified `matched.lat` and `matched.lng`.
   * Keep in-transit scenic drive-bys and route anchors (`type === 'scenic_drive_by'`, `is_route_anchor === true`, or `dwell_minutes === 0` non-lodging/origin/destination) strictly coordinate-only: never attach or retain `google_place_id` on scenic anchors in hydration, frontend suggestion application (`RouteScoutDrawer.tsx` / `App.tsx`), or `googleMapsUrl.ts` (`waypoint_place_ids`).
3. **`delete_waypoint` Parsing in `parseScoutResponse`:**
   * Accept `item.action === 'delete_waypoint'` when `targetWaypointId` (or `target_waypoint_id`) is a non-empty string.
   * Backfill `name`, `type`, `lat`, and `lng` from `options.tripWaypoints` matching `targetWaypointId` when omitted by the model.
4. **Abort Propagation During Parallel Tool Dispatch (`bedrockService.ts`):**
   * In `AwsBedrockHarnessAdapter.generateStreamWithTools`, if `options?.abortSignal?.aborted` is true when a `dispatcher` call rejects or finishes, immediately rethrow `new Error('Request aborted')` without emitting `state: 'error'` activity events or starting a subsequent Bedrock turn.
   * Update `formatBedrockToolLabel` with human-friendly active/done labels for all 7 M4 tools while preserving the generic `Running <name>...` / `Completed <name>` fallback.

### D. Frontend `delete_waypoint` UI Support (`src/components/RouteScoutDrawer.tsx` & `src/App.tsx`)
1. In `RouteScoutDrawerProps`: add optional `onDeleteWaypoint?: (waypointId: string) => void;`.
2. In `App.tsx`: pass `onDeleteWaypoint={handleDeleteWaypoint}` to `<RouteScoutDrawer />`, and clear `scoutPreviewPin` when a deleted waypoint matches the previewed coordinate.
3. In `RouteScoutDrawer.tsx`:
   * Track `deletedSuggestionIds: Set<string>` (reset on itinerary change alongside `addedSuggestionIds` and `updatedSuggestionIds`).
   * Add `handleDeleteSuggestion(suggestion: ScoutSuggestion)` calling `onDeleteWaypoint?.(targetId)` and recording `suggestion.id` in `deletedSuggestionIds`.
   * Render `'Remove Stop'` badge and 1-click `'Remove Stop'` / `'Removed ✓'` button (`Trash2` icon) for `sug.action === 'delete_waypoint'`.

### E. AWS CDK Infrastructure (`infra/lib/roadtrip-cloud-stack.ts`, `infra/bin/infra.ts`, `infra/test/roadtrip-cloud-stack.test.ts`)
1. Add `googlePlacesApiKey`, `googlePlacesApiKeySsmParam`, `braveSearchApiKey`, `braveSearchApiKeySsmParam` to `RoadtripCopilotCloudStackProps`.
2. Validate `googlePlacesApiKeySsmParam` and `braveSearchApiKeySsmParam` against the `/roadtrip-copilot/` prefix boundary.
3. Configure Lambda environment variables:
   * `GOOGLE_PLACES_API_KEY: props?.googlePlacesApiKey ?? ''`
   * `GOOGLE_PLACES_API_KEY_SSM_PARAM: props?.googlePlacesApiKeySsmParam ?? '/roadtrip-copilot/google-places-api-key'`
   * `BRAVE_SEARCH_API_KEY: props?.braveSearchApiKey ?? ''`
   * `BRAVE_SEARCH_API_KEY_SSM_PARAM: props?.braveSearchApiKeySsmParam ?? '/roadtrip-copilot/brave-search-api-key'`
4. Update `route-builder/.env.example` with `GOOGLE_PLACES_API_KEY` and `BRAVE_SEARCH_API_KEY` documentation.

---

## 3. Step-by-Step Tactical Steps

- [x] **Step 1: Implement `scoutTools.ts` & Wire `ScoutService` / `bedrockService.ts` (Backend Worker)**
  - Update `route-builder/server/types/scout.ts` and `route-builder/src/types/scout.ts` with `'delete_waypoint'`.
  - Update `route-builder/server/services/routeService.ts` to accept optional `abortSignal` in `getRoute`.
  - Create `route-builder/server/services/scoutTools.ts` implementing the 7 tools (`search_web`, `read_url_content`, `resolve_and_standardize_place`, `snap_to_highway_corridor`, `calculate_detour_impact`, `simulate_schedule_cascade`, `audit_corridor_waypoints`), `SCOUT_TOOL_DECLARATIONS`, SSRF guards (`assertSafeExternalUrl`), and lazy SSM secret resolution.
  - Update `route-builder/server/services/scoutService.ts` (`ScoutService` default tools & per-turn grounding cache, `parseScoutResponse` Place ID/address/coordinate hydration and `delete_waypoint` parsing, `buildScoutDomainPrompt` `delete_waypoint` documentation).
  - Update `route-builder/server/services/bedrockService.ts` (`formatBedrockToolLabel` for the 5 domain tools + abort check inside tool loop).
- [x] **Step 2: Implement Frontend `delete_waypoint` Support & CDK Updates (Frontend & Infra Worker)**
  - Update `route-builder/src/components/RouteScoutDrawer.tsx` and `route-builder/src/App.tsx` to render and apply `delete_waypoint` suggestion cards.
  - Update `infra/lib/roadtrip-cloud-stack.ts`, `infra/bin/infra.ts`, `infra/test/roadtrip-cloud-stack.test.ts`, and `route-builder/.env.example`.
- [x] **Step 3: Author Comprehensive Unit, Integration & Adversarial Tests (Test Worker)**
  - Create `route-builder/tests/ai/scoutTools.test.tsx` testing all 7 tools, SSRF/redirect blocking, Google Places `X-Goog-FieldMask` & 50km radius clamping, SSM caching/cooldown & region resolution without `'us-east-1'`, parallel `Promise.all` execution, per-turn cache isolation across concurrent requests, deterministic server-side suggestion hydration, and `delete_waypoint` parsing + UI interaction.
- [x] **Step 4: Gate 2A — Primary Orchestrator Adversarial Review & Fixes**
  - Audit full `git diff` against the 8-point Adversarial Review Checklist in `WORKING_MODEL.md`.
  - Fix any discovered issues directly and run `./scripts/ci_check.sh` and `cd route-builder && npm run test:browser`.
- [x] **Step 5: Gate 2B — Independent Claude Sonnet 5.5 Adversarial Review (`agy --model claude-sonnet-5-5-high`) & Fixes**
  - Spawn Claude Sonnet 5.5 via `agy` CLI to perform an independent adversarial code review of the M4 diff, writing findings incrementally to `tmp/m4-sonnet-adversarial-review.md`.
  - Resolve any findings identified by Sonnet 5.5 and remove temporary review scratch files before final commit.
- [x] **Step 6: Final Verification, Living Documentation Sync & Green PR**
  - Sync living docs (`AGENTS.md`, `README.md`, `route-builder/AGENTS.md`, `route-builder/README.md`, `docs/reference/directory-layout.md`, `docs/README.md`).
  - Run `./scripts/ci_check.sh` and `cd route-builder && npm run test:browser`.
  - Push `feat/m4-scout-grounding-tools` and open green PR on GitHub.
- [x] **Step 7: M4 Consolidated Review Fixes & Unhappy-Path Regression Suite**
  - Add regression tests and apply focused fixes for all 8 reproduced findings:
    1. Bind URL validation to the actual socket connection on every hop (`read_url_content`), preserving `Host` and HTTPS SNI/certificate verification with bounded DNS resolution and cancellation.
    2. Replace residual tag regexes in `htmlToReadableText` with linear-time tag tokenization/scanning (`O(n)` on malformed generic tags and repeated `<`).
    3. Disambiguate same-name establishments across coordinate backfill and suggestion hydration (`matchResolvedPlaceForSuggestion`).
    4. Keep scenic navigation anchors coordinate-only across hydration, suggestion apply, and `googleMapsUrl.ts` (`waypoint_place_ids`).
    5. Route changed schedule legs via `RouteService` in `simulate_schedule_cascade` instead of straight-line 50 mph estimation.
    6. Keep request deadlines and `AbortSignal` cancellation active through full JSON/text body consumption (`fetchJsonWithTimeout` and `read_url_content`).
    7. Match complete highway designators (`I-40` vs `I-405`, `US-89` vs `US-89A`, Interstate vs US vs State Route) before textual matching.
    8. Make matched place metadata (`place_name`, `address`) authoritative during hydration without overwriting with empty fields.
  - Update review governance rules (`AGENTS.md` and `WORKING_MODEL.md`) separating Contract-First implementation prompts from neutral, unprimed Gate 2B independent-review prompts.
- [x] **Step 8: Behavior-Preserving Decomposition of `scoutTools.ts` & Living Docs Sync**
  - Extract cohesive modules under `route-builder/server/services/scoutTools/` (`types.ts`, `urlSafety.ts`, `geo.ts`, `scheduleSimulator.ts`, `corridorTools.ts`) while keeping `scoutTools.ts` as the compatible coordinator/facade.
  - Update `docs/reference/directory-layout.md` and `route-builder/AGENTS.md` for the final layout and verify with `./scripts/ci_check.sh` and `cd route-builder && npm run test:browser`.

---

## 4. Verification Plan

* **Route Scout & Grounding Tool Tests:**
  ```bash
  cd route-builder && npm run test:ai
  ```
* **Full Route Builder Vitest Suite & Production Build:**
  ```bash
  cd route-builder && npm test && npm run build
  ```
* **Playwright Browser Geometry & Fixture Suite:**
  ```bash
  cd route-builder && npm run test:browser
  ```
* **CDK Infrastructure Tests & CloudFormation Synthesis:**
  ```bash
  cd infra && npm test && npx cdk synth
  ```
* **Unified CI Pipeline:**
  ```bash
  ./scripts/ci_check.sh
  ```

---

## 5. Discoveries & Deviations Log

1. **Leaf Place ID Module (`server/services/placeId.ts`):** Extracted `isValidGooglePlaceId` and `validateScoutPlaceId` into a dedicated leaf module (`server/services/placeId.ts`) imported by both `scoutService.ts` and `scoutTools.ts` (and re-exported by `scoutService.ts`), eliminating circular module dependencies.
2. **Gate 2A (Primary Orchestrator Review) Fixes:**
   * Preserved explicit `dwell_minutes: 0` in `simulate_schedule_cascade` for `action === 'update'` (`input.dwell_minutes !== undefined` rather than truthy check).
   * Enforced HTTP `Content-Length` pre-check in `read_url_content` before streaming response bodies (`512 KB` max).
   * Added explicit `typeof lat === 'number'` and `typeof lng === 'number'` runtime guards in `snap_to_highway_corridor` and `calculate_detour_impact` for direct LLM JSON inputs.
   * Preserved existing `addedSuggestionIds`, `updatedSuggestionIds`, and `deletedSuggestionIds` sets across same-trip waypoint edits in `RouteScoutDrawer.tsx` by tracking `lastItineraryIdentityRef` via `getItinerarySessionIdentity(currentItinerary)`.
3. **Gate 2B (Claude Sonnet 5.5 Independent Adversarial Review) Fixes:**
   * **SSRF & DNS Rebinding Hardening (`assertSafeExternalUrl` & `assertSafeExternalUrlWithDns`):** Added trailing-dot FQDN normalization (`localhost.`), port allowlist (`80`, `443`), wildcard DNS-rebinding suffixes (`.nip.io`, `.sslip.io`, `.xip.io`, `.localtest.me`, `.lvh.me`), IPv6 NAT64 (`64:ff9b::/96`), Teredo (`2001:0000::/32`), 6to4 (`2002::/16`), SIIT (`::ffff:0:a.b.c.d`), hex-encoded IPv4-mapped IPv6 (`::ffff:7f00:1`), and DNS `lookup(..., { all: true })` verification before fetching.
   * **Linear $O(n)$ HTML Stripping & Single-Pass Entity Decoding:** Replaced regex tag block stripping with linear index scanning (`stripTagBlocksLinear` and `extractTitleLinear`) and decoded `&amp;` last so double-encoded entities (`&amp;lt;script&amp;gt;`) are never unescaped into raw tags.
   * **Shared SSM `loadPromise` Isolation & Per-Fetch Timeouts:** Isolated shared SSM `loadPromise` from individual caller `AbortSignal` cancellation via `raceWithAbort` so one aborted request cannot poison concurrent callers, and wrapped Brave Search, Google Places, and OSRM `/nearest` requests in `fetchWithTimeout` (`10_000ms`).
   * **Highway Designator Disambiguation & Bounded Audit Concurrency:** Required highway prefix compatibility (`US-89` vs `I-89` vs `AZ-89`) when matching `road_name` in `snap_to_highway_corridor`; bounded `audit_corridor_waypoints` concurrency (`MAX_AUDIT_CONCURRENCY = 4`, `MAX_AUDIT_WAYPOINTS = 50`) and enforced word-boundary regexes so `"Las Vegas"` never triggers fuel-brand warnings for `"gas"`.
   * **Defensive Suggestion Hydration & `delete_waypoint` Integrity:** Cloned suggestion objects in `hydrateSuggestionFromResolvedPlaces`, skipped cross-pollination when `suggestion.google_place_id` is already populated, restricted proximity matching (`<= 0.15` mi) strictly to `add_waypoint` on commercial stops (`meal`, `fuel`, `lodging`) with a single unambiguous candidate, protected `scenic_pull_off` and `scenic_drive_by` coordinates from commercial coordinate overwrites, and enforced authoritative `matchedWp` validation on `delete_waypoint` cards.
   * **Bedrock Tool Loop & CDK Guardrails:** Parsed `toolUse.inputJson` once per tool call with plain-object validation, capped parallel tool calls per iteration at `MAX_TOOLS_PER_ITERATION = 8`, redacted AWS ARNs and SSM parameter paths from model-facing tool error payloads, wired `AbortController` on non-streaming `/api/ai/scout/chat` disconnect, used functional state updates in `App.tsx` (`handleDeleteWaypoint` / `handleAddWaypointFromScout`), and removed ambient `process.env` secret baking from `infra/bin/infra.ts`.
4. **M4 Consolidated Review Fixes & Module Decomposition (`server/services/scoutTools/`):**
   * **Pinned External URL Transport (`urlSafety.ts`):** Bound `resolveValidatedUrlWithDns` to `requestPinnedUrl` (`node:http`/`node:https` with `agent: false`, custom `lookup` callback returning only already-validated IPs, socket `remoteAddress` check, and explicit `Host` + HTTPS `servername` SNI preservation across redirect hops) and replaced residual tag regexes in `htmlToReadableText` with linear-time scanning (`stripAndFormatHtmlTagsLinear`).
   * **Multi-Branch Disambiguation, Authoritative Metadata & Scenic Anchor Protection (`geo.ts`, `scoutService.ts`, `googleMapsUrl.ts`, `RouteScoutDrawer.tsx`, `App.tsx`):** Shared `matchResolvedPlaceForSuggestion` and `isInTransitOrAnchorSuggestion` across coordinate backfill and hydration; enforced authoritative non-empty `place_name`/`address` replacement on matched physical stops; kept scenic drive-bys and route anchors strictly coordinate-only end-to-end through `waypoint_place_ids`.
   * **Real OSRM Leg Routing in `simulate_schedule_cascade`, Full-Body Deadlines & Complete Highway Designators (`scheduleSimulator.ts`, `corridorTools.ts`, `scoutTools.ts`):** Routed changed schedule legs via `RouteService` while preserving unchanged legs; kept `fetchJsonWithTimeout` deadlines and `AbortSignal` active through full stream consumption with reader cancellation; parsed complete highway designators (`parseHighwayDesignators` / `matchesHighwayRoadName`) before textual matching; and decomposed `scoutTools.ts` into `server/services/scoutTools/{types,urlSafety,geo,scheduleSimulator,corridorTools}.ts`.

---

## 6. Next Session Handoff

* **Where We Stopped:** M4 consolidated review fixes (Findings 1–8), regression tests (500 Vitest tests), review governance updates, and behavior-preserving `scoutTools/` module decomposition are complete on `feat/m4-scout-grounding-tools` and verified against `./scripts/ci_check.sh` and `npm run test:browser`. Live AWS deployment and live CloudFront verification remain blocked externally pending AWS Support account recovery.
* **Next Step:** Once AWS Support restores account access, add `/roadtrip-copilot/google-places-api-key` and `/roadtrip-copilot/brave-search-api-key` `SecureString` parameters in AWS SSM Parameter Store (`us-east-2`), run `./scripts/deploy_cloud.sh` to deploy M3 + M4 to AWS, and complete the live CloudFront manual verification check.
