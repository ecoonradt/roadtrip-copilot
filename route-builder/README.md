# Roadtrip Co-Pilot: Route Builder Web Studio

A full-stack, desktop-first itinerary planning and authoring studio for **Roadtrip Co-Pilot**. It allows you to design custom road trip itineraries on an interactive OpenStreetMap canvas, compute road routing and timeline cascades, generate AI-enriched in-car alerts, and sync custom trips directly to your Android device.

---

## Architecture Overview

* **Frontend:** React 18 + Vite + TypeScript + Tailwind CSS + Leaflet (`react-leaflet`). Runs on `http://localhost:5173`.
* **Backend:** Fastify 5 + TypeScript running on `http://localhost:3001` (Vite reverse-proxies `/api/*` requests).
* **Road Routing & Geocoding:**
  * `GET /api/routing/geocode`: Proxies OpenStreetMap Nominatim with a compliant custom `User-Agent`.
  * `GET /api/routing/route`: Proxies the Open Source Routing Machine (OSRM) for real road driving geometry, distances, and durations, backed by an in-memory LRU cache.
* **Timeline Schedule Engine (`src/engine/cascade.ts`):** Computes arrival and departure times across all stops, automatically rippling dwell time changes downstream and shifting local times at state/timezone boundaries while keeping UTC milestones chronological. Supports a backward "Catch-up" deadline solver.
* **Pluggable AI Harness Adapters (`server/services/aiService.ts`):** 
  * **Primary (Local Zero-Config):** Shells out locally to the Antigravity CLI (`AgyHarnessAdapter`), dynamically detecting and invoking the latest available Gemini Flash model from `agy models` (e.g. `gemini-3.8-flash-high`). **Zero API keys required.**
  * **Cloud Fallback:** `GeminiStudioHarnessAdapter` connects directly to Google AI Studio REST API, defaulting to `gemini-3.8-flash`.
  * **Deterministic Fallback:** `TemplateHarnessAdapter` provides offline template alerts if no AI provider is configured.
  * **Copywriting Constraints:** Enforces titles $\le 30$ characters, notification messages $\le 2$ lines, natural spoken phonetic TTS scripts (15–25 words, spoken within 8–12 seconds), and trigger radii clamped to $0.3$–$6.0$ miles.
  * **Future Adapters:** Pluggable interface ready for Anthropic Claude, OpenAI, and local offline models (Ollama). See `IDEAS.md`.
* **Multi-Stop Google Maps Navigation Links (`src/engine/googleMapsUrl.ts`):** Constructs Google Maps driving URLs with route-shaping waypoints to prevent Google Maps from rerouting onto standard highways. Routes exceeding 9 intermediate stops are partitioned into continuous driving legs with dedicated QR codes.
* **Device Sync & Handoff (`server/services/deviceService.ts`, `src/components/ExportModal.tsx`):**
  * **1-Click ADB Push:** Directly pushes the itinerary `.json` to connected phones at `/sdcard/Android/data/com.roadtrip.copilot/files/itineraries/`.
  * **Local Wi-Fi QR Code:** Serves the file locally (`GET /api/device/download/:filename`) with an on-screen QR code for instant camera scanning and download over local Wi-Fi.
  * **Google Maps Leg QR Codes:** Scannable on-screen QR codes to instantly launch Google Maps turn-by-turn navigation on your car display with route-shaping anchors intact.
  * **In-App File Import (SAF):** Download the `.json` file in your browser and import it via the Android app's Storage Access Framework file picker.

---

## Getting Started

### Prerequisites & Cross-Platform Installation

* **Node.js:** v18.0.0 or newer (v20+ LTS recommended)
* **npm:** v9.0.0 or newer
  * **Linux:** `sudo apt install -y nodejs npm` (or via NodeSource)
  * **macOS:** `brew install node`
  * **Windows:** `winget install OpenJS.NodeJS.LTS`
* **Android Debug Bridge (Optional for 1-Click ADB Push):** `adb` available in system PATH.
* **Antigravity CLI (Optional for Zero-Config Local AI):** `agy` in your PATH (`~/.local/bin/agy`).

### Installation
```bash
cd route-builder
npm install
```

### Running in Development Mode
```bash
npm run dev
```
This runs `concurrently` to start both:
1. **Fastify Backend:** `http://localhost:3001`
2. **Vite Frontend:** `http://localhost:5173`

Open `http://localhost:5173` in your browser.

---

## Environment Variables & Configuration

The application works with zero configuration by default in an Antigravity environment. You can customize behavior using the following environment variables:

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `3001` | Fastify backend listening port. |
| `GEMINI_API_KEY` | *(None)* | Optional Google AI Studio developer API key. Used as cloud fallback if `agy` CLI is not present. |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Explicit Gemini model ID for Google AI Studio cloud calls. |
| `AGY_MODEL` | *(Auto-detected)* | Override the model passed to `agy` (by default auto-resolves the newest Flash model from `agy models`). |
| `NODE_ENV` | `development` | Set to `production` for production builds. |

---

## Testing & Quality Gates

The codebase enforces strict TypeScript (`strict: true`, **zero `any` types**) and is covered by 111 Vitest unit and integration tests:

```bash
npm test              # Run all 111 tests across all suites
npm run test:backend  # Fastify routing proxies, Nominatim headers, OSRM cache
npm run test:engine   # Timeline cascade math, dwell ripples, Google Maps URL chunking
npm run test:ai       # Prompt formatting, schema sanitization, batching, adapters, client queue
npm run test:schema   # Itinerary V2 JSON export and ADB device service
npm run build         # Production compile (client Vite bundle + backend tsc)
```

---

## Project Structure

```
route-builder/
├── index.html                  # HTML entrypoint
├── package.json                # Project dependencies and scripts
├── tsconfig.json               # Frontend TypeScript configuration
├── tsconfig.server.json        # Backend TypeScript configuration
├── vite.config.ts              # Vite dev server and /api proxy configuration
├── tailwind.config.js          # Dark automotive theme color palette
├── server/
│   ├── app.ts                  # Fastify application factory
│   ├── index.ts                # Server bootstrapper (:3001)
│   ├── routes/
│   │   ├── routing.ts          # /api/routing (geocode & OSRM route proxies)
│   │   ├── ai.ts               # /api/copilot/generate (single & batch)
│   │   ├── device.ts           # /api/device (status, push, download, staging)
│   │   └── itineraries.ts      # /api/itineraries (workspace discovery)
│   ├── services/
│   │   ├── geocodeService.ts   # Nominatim integration with compliant User-Agent
│   │   ├── routeService.ts     # OSRM road graph query engine (unencoded coords path)
│   │   ├── routeCache.ts       # LRU coordinate cache with toFixed(5) precision
│   │   ├── promptBuilder.ts    # Prompt contract generator
│   │   ├── schemaParser.ts     # Title truncation (<=30 chars), radius clamping, TTS cleanup
│   │   ├── aiService.ts        # Pluggable AI harness adapters (agy, Gemini API, template fallback)
│   │   ├── deviceService.ts    # ADB subprocess management and local IP Wi-Fi discovery
│   │   └── itineraryStorageService.ts # Multi-day JSON parsing and disk storage
│   └── types/                  # Strict server TypeScript types
├── src/
│   ├── App.tsx                 # Main layout & interactive map state coordinator
│   ├── components/
│   │   ├── AppHeader.tsx       # Top bar with route title, metrics, search, and global actions
│   │   ├── DayTabBar.tsx       # Multi-day leg switcher tabs
│   │   ├── MapCanvas.tsx       # Leaflet map with custom waypoint markers & OSRM polyline
│   │   ├── SearchBar.tsx       # Debounced address search via Nominatim proxy
│   │   ├── TimelineSidebar.tsx # Timeline stops, dwell editor, cascade telemetry, Google Maps links
│   │   ├── RouteSelectorModal.tsx # Workspace route discovery and selection modal
│   │   ├── AiAlertModal.tsx    # Live Android Auto card preview & browser TTS speech preview
│   │   └── ExportModal.tsx     # 1-click ADB push, Wi-Fi QR code, Google Maps leg QR codes
│   ├── engine/
│   │   ├── cascade.ts          # Timeline cascade & timezone border calculation
│   │   ├── googleMapsUrl.ts    # Multi-stop URL generator with <=9 stop chunking
│   │   ├── export.ts           # Itinerary V2 JSON exporter
│   │   ├── itineraryParser.ts  # Multi-day and single-route JSON ingestion
│   │   └── types.ts            # Mathematical & engine data contracts
│   ├── services/
│   │   ├── api.ts              # Frontend API client
│   │   └── aiQueue.ts          # Client-side concurrency limiter
│   └── types/                  # Frontend data models
└── tests/                      # Comprehensive Vitest test suites (111 tests)
```
