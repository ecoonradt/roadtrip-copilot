# Roadtrip Co-Pilot: Route Builder Web Studio

A full-stack, desktop-first itinerary planning and authoring studio for **Roadtrip Co-Pilot**. It allows you to design custom road trip itineraries on an interactive OpenStreetMap canvas, automatically compute road routing and timeline cascades, generate AI-enriched in-car alerts, and sync custom trips directly to your Android device.

---

## Architecture Overview

* **Frontend:** React 18 + Vite + TypeScript + Tailwind CSS + Leaflet (`react-leaflet`). Runs on `http://localhost:5173`.
* **Backend:** Fastify 5 + TypeScript running on `http://localhost:3001` (Vite reverse-proxies `/api/*` requests).
* **Deterministic Routing & Geocoding:**
  * `GET /api/routing/geocode`: Proxies OpenStreetMap Nominatim with a compliant custom `User-Agent`.
  * `GET /api/routing/route`: Proxies the Open Source Routing Machine (OSRM) for real road driving geometry, distances, and durations, backed by an in-memory LRU cache with coordinate normalization.
* **Timeline Cascade Engine (`src/engine/cascade.ts`):** Deterministically computes arrival and departure times across all stops, automatically rippling dwell time changes downstream and shifting local times at state/timezone boundaries (e.g. Arizona UTC-7 MST $\to$ New Mexico UTC-6 MDT) while keeping UTC epoch milestones linear. Supports a backward "Flight Catch-up" deadline solver.
* **AI Co-Pilot Copywriter (`server/services/aiService.ts`):** 
  * Primary engine shells out locally to the Antigravity CLI (`agy -p "..." --output-format json`) using your active Gemini 3.8 session. **Zero API keys or configuration required.**
  * Optional cloud fallback via Google AI Studio API (`gemini-2.0-flash` or `gemini-1.5-flash`).
  * Enforces Android Auto copywriting constraints: titles $\le 30$ characters, notification messages $\le 2$ lines, natural spoken phonetic TTS scripts (15–25 words, spoken within 8–12 seconds), and trigger radii clamped to $0.3$–$6.0$ miles.
* **Multi-Stop Google Maps Navigation Links (`src/engine/googleMapsUrl.ts`):** Automatically constructs Google Maps driving URLs with route-shaping waypoints to prevent Google Maps from rerouting onto boring interstates. Routes exceeding 9 intermediate stops are partitioned into continuous driving legs with dedicated QR codes.
* **Device Sync & Handoff (`server/services/deviceService.ts`, `src/components/ExportModal.tsx`):**
  * **1-Click ADB Push:** Directly pushes the itinerary `.json` to connected phones at `/sdcard/Android/data/com.roadtrip.copilot/files/itineraries/`.
  * **Local Wi-Fi QR Code:** Serves the file locally (`GET /api/device/download/:filename`) with an on-screen QR code for instant camera scanning and download.
  * **Direct Download:** Standard browser JSON file download for manual import via the Android app's Storage Access Framework file picker.

---

## Getting Started

### Prerequisites
* **Node.js:** v18.0.0+ (tested on v24.14.0)
* **npm:** v9.0.0+ (tested on v11.9.0)
* **Android Debug Bridge (Optional for 1-Click Push):** `/usr/bin/adb`
* **Antigravity CLI (Optional for Zero-Config AI):** `agy` in your PATH (`~/.local/bin/agy`)

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

The application is completely zero-configuration by default when run in an Antigravity environment. You can customize behavior using the following environment variables:

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `3001` | Fastify backend listening port. |
| `GEMINI_API_KEY` | *(None)* | Optional Google AI Studio developer API key. Used as cloud fallback if `agy` CLI is not installed. |
| `NODE_ENV` | `development` | Set to `production` for production builds. |

---

## Testing & Quality Gates

The codebase enforces strict TypeScript (`strict: true`, **zero `any` types**) and is covered by 97 Vitest unit and integration tests:

```bash
npm test              # Run all 97 tests across all suites
npm run test:backend  # Fastify routing proxies, Nominatim headers, OSRM cache
npm run test:engine   # Timeline cascade math, dwell ripples, Google Maps URL chunking
npm run test:ai       # Prompt formatting, schema sanitization, batching, client queue
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
│   │   └── device.ts           # /api/device (status, push, download, staging)
│   ├── services/
│   │   ├── geocodeService.ts   # Nominatim integration with compliant User-Agent
│   │   ├── routeService.ts     # OSRM road graph query engine (unencoded coords path)
│   │   ├── routeCache.ts       # LRU coordinate cache with toFixed(5) precision
│   │   ├── promptBuilder.ts    # Section 4.4 prompt contract generator
│   │   ├── schemaParser.ts     # Title truncation (<=30 chars), radius clamping, TTS cleanup
│   │   ├── aiService.ts        # 3-tier AI engine (agy CLI -> AI Studio -> Template fallback)
│   │   └── deviceService.ts    # ADB subprocess management and local IP Wi-Fi discovery
│   └── types/                  # Strict server TypeScript types
├── src/
│   ├── App.tsx                 # Main layout & interactive map state coordinator
│   ├── components/
│   │   ├── MapCanvas.tsx       # Leaflet map with custom waypoint markers & OSRM polyline
│   │   ├── SearchBar.tsx       # Debounced address search via Nominatim proxy
│   │   ├── TimelineSidebar.tsx # Timeline stops, dwell editor, cascade telemetry, Google Maps links
│   │   ├── AiAlertModal.tsx    # Live Android Auto card preview & browser TTS speech preview
│   │   └── ExportModal.tsx     # 1-click ADB push, Wi-Fi QR code, Google Maps leg QR codes
│   ├── engine/
│   │   ├── cascade.ts          # Deterministic timeline cascade & timezone border calculation
│   │   ├── googleMapsUrl.ts    # Multi-stop URL generator with <=9 stop chunking
│   │   ├── export.ts           # Itinerary V2 JSON exporter
│   │   └── types.ts            # Mathematical & engine data contracts
│   ├── services/
│   │   ├── api.ts              # Frontend API client
│   │   └── aiQueue.ts          # Client-side concurrency limiter
│   └── types/                  # Frontend data models
└── tests/                      # Comprehensive Vitest test suites (97 tests)
```
