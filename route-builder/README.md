# Roadtrip Co-Pilot: Route Builder Web Studio

A full-stack, desktop-first itinerary planning and authoring studio for **Roadtrip Co-Pilot**. It allows you to design custom road trip itineraries on an interactive OpenStreetMap canvas, compute road routing and timeline cascades, scout scenic corridors with an AI assistant, and sync custom trips directly to your Android device.

---

## Key Features

* **Interactive Map Canvas & Routing:** OpenStreetMap canvas powered by Leaflet and backend OSRM routing proxies with in-memory caching.
* **Timeline Schedule Engine:** Computes arrival and departure times across all stops, automatically rippling dwell time changes downstream and shifting local times at state and timezone boundaries while keeping UTC milestones chronological. Includes a backward "Catch-up" deadline solver.
* **Route Scout Conversational Co-Pilot:** An interactive route intelligence advisor in a slide-out drawer that audits daily driving pace, discovers scenic vistas, local food, and fuel stops along your driving corridor, and inserts verified waypoints directly into your timeline.
* **AI Heads-Up Generation:** Instant generation of Android Auto heads-up cards (titles up to 30 characters, messages up to 2 lines) and natural spoken phonetic TTS scripts (15-25 words, spoken within 8-12 seconds) with trigger radii clamped between 0.3 and 6.0 miles.
* **Multi-Stop Google Maps Navigation Links:** Constructs Google Maps driving URLs with route-shaping waypoints to prevent Google Maps from rerouting onto standard highways. Routes exceeding 9 intermediate stops are automatically partitioned into continuous driving legs with dedicated QR codes.
* **1-Click Device Handoff:** Directly push itineraries to connected Android phones over ADB, download via local Wi-Fi QR codes, or export JSON files for Android Storage Access Framework (SAF) import.
* **Atomic Cloud & Local Persistence:** Multi-day itineraries are persisted either in Amazon S3 (`users/{email}/itineraries/*.json`) with conditional write safety (`If-Match` / `If-None-Match` & `ETag`) when `S3_STORAGE_BUCKET` is configured, or on local disk (`itineraries/*.json`) for isolated offline development.
* **Compact Account Controls:** The single-row header keeps planning actions in view. Click your avatar or initials in the top-right for your name, email, and Sign out; the popover also supports keyboard navigation.

---

## Getting Started

### Prerequisites

* **Node.js:** v18.0.0 or newer (v20+ LTS recommended)
* **npm:** v9.0.0 or newer
  * **Linux:** `sudo apt install -y nodejs npm` (or via NodeSource)
  * **macOS:** `brew install node`
  * **Windows:** `winget install OpenJS.NodeJS.LTS`
* **Android Debug Bridge (Optional, for 1-Click ADB Push):** `adb` available in system PATH.

### Installation

```bash
cd route-builder
npm install
```

### Running in Development Mode

```bash
npm run dev
```

This runs both servers concurrently:
1. **Fastify Backend:** `http://localhost:3001`
2. **Vite Frontend:** `http://localhost:5173`

Open `http://localhost:5173` in your browser.

In authentication-enabled deployments, slow session checks show connection feedback after a short delay. A check that exceeds 15 seconds displays a connection error with **Retry Connection**, rather than leaving the screen blank.

---

## AI Configuration (Route Scout & Alert Generation)

The core Route Builder (map planning, OSRM routing, timeline cascade calculations, and device sync) works 100% offline with zero configuration.

To use the **AI Heads-Up Alert Copywriter** or the **Route Scout Conversational Co-Pilot**, configure an AI engine using one of the following methods:

* **Amazon Bedrock (Cloud & AWS Credentials):** Uses Amazon Bedrock's unified Converse / ConverseStream API (`@aws-sdk/client-bedrock-runtime`) with configurable multi-vendor model selection in the Route Scout drawer and Edit Waypoint modal. Defaults to **Moonshot Kimi K3** (`us.moonshotai.kimi-k3`) for Route Scout and **Amazon Nova 2 Lite** (`us.amazon.nova-2-lite-v1:0`) for alert copywriting, with support for Amazon Nova Pro, OpenAI GPT-OSS 120B/20B, DeepSeek V3.2, Mistral Large 3, and Moonshot Kimi K2.5.
* **Local Zero-Config (`agy`):** If the Antigravity CLI (`agy`) is in your PATH (e.g. `~/.local/bin/agy`), the Route Builder automatically detects and invokes the active Gemini Flash model (e.g. `gemini-3.8-flash-high`) using your active session. **Zero API keys required.** Grounded web searches verify real-world coordinates and operating hours without headless lockups. (Optional model override: `export AGY_MODEL="model-name"`).
* **Google AI Studio Fallback:** Supply a Google AI Studio developer API key in the UI settings modal or via environment variable:
  ```bash
  export GEMINI_API_KEY="your-google-ai-studio-api-key"
  ```
  *(Defaults to `gemini-3.8-flash`; override via `export GEMINI_MODEL="model-name"`).*

---

## Best Practices: Human-in-the-Loop Route Verification

> [!TIP]
> **Route Scout is a Powerful Advisor, Not an Autopilot.**
> AI language models are exceptionally skilled at discovering scenic overlooks, recommending pacing strategies, finding hidden roadside diners, and identifying fuel deserts. However, real-world geography is intricate—divided highway medians, newly opened service stations, remote vista pull-offs without postal street addresses, and ambiguous multi-location commercial brands can easily mislead a zero-shot geocoder.
> 
> **The best practice for a flawless road trip is an interactive verification loop:** verify critical waypoints on Google Maps, and collaborate with Route Scout or the inline editor to lock them in.

### The Recommended 3-Step Verification Workflow

1. **Discover & Stage with Route Scout:**
   * Ask Route Scout for advice (e.g. *"Where should we refuel before heading into the mountains?"* or *"Audit my day 2 waypoints for Google Maps issues"*).
   * Review the candidate cards (`add_waypoint` or `update_waypoint`) with their on-map pin previews, and click **Apply** to integrate them into your timeline cascade.

2. **Verify on Google Maps ("Test on Google Maps"):**
   * Open the **Edit Waypoint** modal (pencil icon) on any physical stop (fuel, meals, lodging, viewpoints).
   * Click the **"Test on Google Maps"** link button next to the establishment name or Place ID.
   * Verify that Google Maps resolves the exact intended entrance or parking area without prompting with ambiguous *"Did you mean:"* disambiguation pickers.

3. **Refine Interactively or Manually:**
   * **Decoupled Names (`name` vs. `place_name`):** Keep your personalized, descriptive titles in **Name** (e.g. `"Maverik (West Main St)"` or `"Flagstaff / Little America Hotel"`). Store the clean, exact establishment title in **Place Name** (e.g. `"Maverik"` or `"Little America Hotel"`). The link engine automatically uses `place_name` for Google Maps queries to prevent search confusion.
   * **1-Click Google Place ID Paste:** If you locate a place directly on Google Maps in your browser, copy its URL and paste it directly into the **Google Place ID** field in the Edit Waypoint modal. The studio automatically extracts the verified 20-byte base64url Place ID (`ChIJ...`) from the URL.
   * **Collaborate in Chat:** You can also ask Route Scout to fix waypoints in natural language (e.g. *"Change the fuel stop to the Maverik on 2701 W Main St in Farmington"*), and it will emit an updated suggestion card with corrected coordinates and notification copy.

---

## Device Sync & Phone Handoff

Once your itinerary is ready, transfer it to your Android device using any of three methods:

* **1-Click ADB Push:** Directly pushes the itinerary `.json` to connected phones at `/sdcard/Android/data/com.roadtrip.copilot/files/itineraries/`.
* **Local Wi-Fi QR Code:** Serves the file locally (`GET /api/device/download/:filename`) with an on-screen QR code for instant camera scanning and download over your local network.
* **Google Maps Leg QR Codes:** Scannable on-screen QR codes to instantly launch Google Maps turn-by-turn navigation on your car display with route-shaping anchors intact.
* **In-App File Import (SAF):** Download the `.json` file in your browser and import it via the Android app's Storage Access Framework file picker.

---

## Environment Variables & Configuration

The application works with zero configuration by default in an AWS or Antigravity environment. You can customize behavior using the following environment variables:

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `3001` | Fastify backend listening port. |
| `AUTH_ENABLED` | `false` | Set to `true` in cloud production to enforce Google OIDC + `ALLOWED_EMAILS` gating (`false` in `npm run dev` for local bypass). |
| `ALLOWED_EMAILS` | *(None)* | Comma-separated allowlist of authorized Google account emails when `AUTH_ENABLED=true` (or resolved from SSM `/roadtrip-copilot/allowed-emails`). |
| `GOOGLE_CLIENT_ID` | *(None)* | Google OAuth 2.0 Web Client ID (or resolved from SSM `/roadtrip-copilot/google-client-id`). |
| `GOOGLE_CLIENT_SECRET` | *(None)* | Google OAuth 2.0 Web Client Secret (or resolved at runtime from SSM SecureString `/roadtrip-copilot/google-client-secret`). |
| `JWT_SECRET` | *(None)* | Server HMAC-SHA256 secret for signing session cookies and Bearer JWTs (or resolved at runtime from SSM SecureString `/roadtrip-copilot/jwt-secret`). |
| `BEDROCK_SCOUT_MODEL_ID` | `us.moonshotai.kimi-k3` | Default Amazon Bedrock model or inference profile ID for the Route Scout co-pilot. |
| `BEDROCK_COPYWRITER_MODEL_ID` | `us.amazon.nova-2-lite-v1:0` | Default Amazon Bedrock model or inference profile ID for waypoint alert & day-title copywriting. |
| `GEMINI_API_KEY` | *(None)* | Optional Google AI Studio developer API key. |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Explicit Gemini model ID for Google AI Studio cloud calls. |
| `AGY_MODEL` | *(Auto-detected)* | Override the model passed to `agy` (by default auto-resolves the newest Flash model from `agy models`). |
| `NODE_ENV` | `development` | Set to `production` for production builds. |

---

## Testing & Quality Gates

The codebase enforces strict TypeScript (`strict: true`, **zero `any` types**) and is covered by Vitest unit/integration tests and Playwright browser acceptance tests:

```bash
npm test              # Run all Vitest suites
npm run test:browser  # Browser geometry, account interactions, and session recovery
npm run test:backend  # Fastify auth, routing proxies, Nominatim headers, OSRM cache
npm run test:engine   # Timeline cascade math, dwell ripples, Google Maps URL chunking
npm run test:ai       # Prompt formatting, schema sanitization, batching, adapters, client queue, scout
npm run test:schema   # Itinerary V2 JSON export and ADB device service
npm run build         # Production compile (client Vite bundle + backend tsc)
```

Browser tests require Node.js 20+ and a one-time `npx playwright install chromium` (on Linux CI, use `npx playwright install --with-deps chromium`). They start their own frontend on `127.0.0.1:5174`, use local API fixtures, and need no running backend, AWS credentials, or Google sign-in. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use an existing compatible Chromium executable instead. These tests run separately from `npm test` and the unified CI script.

### Full-Stack CI Verification & Cloud Deployment
From the repository root, run the unified verification pipeline and cloud deployment scripts:
* **Full Verification Pipeline (`../scripts/ci_check.sh`):** Runs Route Builder tests and build, `infra/` AWS CDK unit assertions and CloudFormation synthesis, and Android unit tests.
* **AWS Serverless Deployment (`../scripts/deploy_cloud.sh`):** Deploys the application to AWS using AWS CDK (`infra/`), packaging the Fastify backend via `Dockerfile` with AWS Lambda Web Adapter (LWA) response streaming, hosting the static React frontend on S3 behind CloudFront, and executing a live `/api/health` smoke check.

---

## How It Works (Architecture Summary)

The Route Builder is architected as a decoupled client-server application:

* **Frontend (`src/`):** React 18, TypeScript, Tailwind CSS, and Leaflet map rendering. Implements the deterministic timeline cascade engine, schedule ripple math, Route Scout chat drawer, and Google Maps URL chunking.
* **Backend (`server/`):** Fastify REST server with zero-key LRU-cached routing proxies (OSRM, Nominatim), extensible AI harness adapters, Route Scout streaming SSE service, and ADB device synchronization.
* **Testing (`tests/`):** Vitest unit/integration tests validate routing proxies, timelines, AI adapters, exports, and authentication. Playwright tests verify header geometry and account/session interactions in a real browser.

For detailed developer specifications, directory layouts, and design contracts, see [AGENTS.md](AGENTS.md) and [docs/archive/route_builder_research_and_architecture.md](../docs/archive/route_builder_research_and_architecture.md).
