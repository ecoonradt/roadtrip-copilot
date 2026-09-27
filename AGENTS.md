# AGENTS.md — Roadtrip Co-Pilot Developer & Agent Handbook

## 1. Project Purpose & Architecture Context
* **Mission:** An open-source native Android background co-pilot designed to run alongside Google Maps in Android Auto during multi-stop road trips.
* **The Problem:** Android Auto's split-screen dashboard only permits two active tiles (typically Google Maps on the left, Media/Spotify on the right). A custom third-party Car App screen would displace music or navigation.
* **The Solution:** A lightweight native Android **Foreground Service** that runs in the background. It monitors GPS location against local waypoint coordinates, posts high-priority heads-up cards over Google Maps, and ducks car audio to speak upcoming scenic and itinerary details.

---

## 2. Core Architectural Pillars

### A. Background Service Lifecycle (Foreground Service)
* Modern Android (API 34 through API 36+) strictly enforces foreground service policies.
* The service is declared in `AndroidManifest.xml` with:
  ```xml
  android:foregroundServiceType="location"
  ```
* Required permissions:
  * `android.permission.FOREGROUND_SERVICE`
  * `android.permission.FOREGROUND_SERVICE_LOCATION`
  * `android.permission.ACCESS_FINE_LOCATION`
  * `android.permission.ACCESS_COARSE_LOCATION`
  * `android.permission.POST_NOTIFICATIONS`
* A persistent low-priority ongoing notification keeps the service active so the Android OS does not kill it while driving.

### B. Audio Ducking, Stream Routing & Calibration
* When approaching a waypoint, the app ducks or optionally pauses whatever audio is playing (Spotify, podcasts) rather than talking over it.
* Uses Android's `AudioManager` with `AudioFocusRequest`:
  * Focus Gain: `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK` (default) or `AUDIOFOCUS_GAIN_TRANSIENT` (when "Pause music completely" is toggled).
  * Audio Usage: `AudioAttributes.USAGE_MEDIA` (default, pegged to the car stereo's volume knob) or `AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE` (car navigation guidance channel).
  * Content Type: `AudioAttributes.CONTENT_TYPE_SPEECH`.
* Provides a 12-second continuous calibration speech loop so the driver can adjust the car volume knob in real time before driving.
* Focus must be abandoned immediately upon speech completion (`TextToSpeech.OnUtteranceProgressListener.onDone`) so music smoothly returns to 100% volume.

### C. Android Auto Heads-Up Notifications & Requirements
* Approaching waypoints triggers an immediate high-priority heads-up notification projected onto the car screen over Google Maps.
* Uses `NotificationCompat.Builder` with:
  * Style: `NotificationCompat.MessagingStyle` with `setGroupConversation(false)` and `Person` sender formatted as `"Co-Pilot: <Waypoint Title>"`. (Setting 1-to-1 conversation prevents Android Auto from filtering alerts through its "Show group message notifications" mute filter).
  * Actions: Actionable voice `RemoteInput` reply ("Acknowledge") and mark-as-read ("Dismiss") wired to `NotificationReceiver`.
  * Automotive Descriptor: Declared in `res/xml/automotive_app_desc.xml` (`<uses name="notification" />`) and registered via `<meta-data>` in `AndroidManifest.xml`.
  * Channel: `IMPORTANCE_HIGH`, Category: `CATEGORY_MESSAGE`, Extender: `NotificationCompat.CarExtender()`.
* **Required In-Car Device Settings (One-time setup for sideloaded / ADB builds):**
  * Android Auto blocks sideloaded apps by default. In Android Auto settings, unlock Developer Settings (tap Version 10 times) $\to$ open Developer Settings $\to$ check **"Unknown sources"**.
  * Under Android Auto Notification settings: ensure **"Show message notifications"** and **"Show first line of conversations"** are toggled **ON**.

### D. Pace & Schedule Telemetry Engine
* Dynamically calculates ahead/behind schedule deltas relative to planned waypoint target times.
* Supports both fixed ISO-dated itineraries (with cross-state timezone offset adjustments) and dynamic ad-hoc drive routes (calculated relative to trip start time).
* Locks in-transit pace telemetry to the last confirmed milestone to eliminate false ahead-of-schedule readings while parked before departure.

### E. 100% Offline Resilience (Zero Cellular Dependency)
* Many scenic road trip segments, national parks, and mountain passes have zero cellular connectivity.
* **GPS:** Hardware GNSS satellite radio receives lat/long directly from orbit. No network calls.
* **Proximity Math:** Local Haversine formula executed on-device.
* **Data Source:** Waypoints, triggers, and announcement scripts are loaded from bundled assets or imported to `/sdcard/Android/data/com.roadtrip.copilot/files/itineraries/`.
* **TTS Engine:** Uses Android's built-in `TextToSpeech` engine configured with local/offline English voice packs.

### F. Route Authoring, Timeline Cascade & Device Handoff (The Route Builder Web Studio)
* Located in `route-builder/`, providing a full-stack authoring studio (Vite/React frontend on `:5173`, Fastify/TypeScript backend on `:3001`).
* **Architecture:**
  * **Routing & Geocoding:** Backend proxies OSRM road graph directions and Nominatim geocoding (with compliant `User-Agent`). In-memory LRU caching deduplicates requests.
  * **Timeline Schedule Cascade:** Recalculates arrival/departure times across waypoints; modifying dwell time on stop $k$ ripples through stops $k+1 \dots n$. Supports backward scheduling from destination deadlines ("Catch-up" mode).
  * **Timezone Transitions:** Detects timezone boundary crossings, applying offset jumps in formatted local time while keeping epoch timestamps strictly linear.
  * **AI Harness Adapter Architecture:** Built around `AiHarnessAdapter` (`server/services/aiService.ts`):
    * Primary: `AgyHarnessAdapter` dynamically resolves and uses the newest Flash model from `agy models` (e.g. `gemini-3.8-flash-high`) via `agy -p "..." --output-format json`. Zero API keys required.
    * Cloud Fallback: `GeminiStudioHarnessAdapter` connects to Google AI Studio, defaulting to `gemini-3.8-flash`.
    * Graceful UI Disabling: AI features (alert copywriting and Route Scout) require an active AI engine or API key; when unavailable, the studio gracefully disables all AI buttons with informative tooltips.
    * Enforces constraints: titles $\le 30$ chars, messages $\le 2$ lines, trigger radii clamped to $[0.3, 6.0]$ miles. Client-side `AiQueue` limits concurrency.
    * Roadmap: Support for Anthropic Claude, OpenAI, and Ollama/local models is tracked in [IDEAS.md](docs/IDEAS.md).
  * **Route Scout Conversational Co-Pilot & Adapter Seam:** Interactive conversational assistant (`RouteScoutDrawer.tsx`, `scoutService.ts`, `/api/ai/scout/*`) operating across Day Scope and Waypoint Scope. Built on a clean architectural seam separating the pure road-trip domain prompt (`buildScoutDomainPrompt`) from harness-specific operational directives via `AiHarnessAdapter` lifecycle hooks (`decorateScoutPrompt` and `sanitizeResponse`). In `AgyHarnessAdapter`, grants Green-tier search tools (`search_web`, `read_url_content`) and fast synchronous checks for real-world coordinate & exit accuracy, while strictly forbidding background tasks, subagents, and file writes. Generates actionable candidate cards (`json:suggestions`) with 1-click timeline integration and live map preview pins. Operates under the **Human-in-the-Loop Verification** principle: Route Scout is an advisory discovery companion rather than an infallible autopilot; planners verify real-world waypoints via the on-map pin preview and the in-app "Test on Google Maps" link.
  * **OSRM Routing Protocol Rule:** Coordinate paths sent to the upstream OSRM routing engine must use literal `;` delimiters (e.g. `/${formattedCoords}?overview=...`). **Never URL-encode semicolons as `%3B` in OSRM path segments**, as the router rejects `%3B` with HTTP 400 `InvalidUrl`.
  * **Google Maps Navigation Links & Place Decoupling:** Generates multi-stop driving links with route-forcing anchors to preserve scenic byways over interstates. Drives exceeding 9 intermediate stops are automatically partitioned into consecutive legs ($\le 9$ intermediate stops each) with dedicated QR codes. Decouples human-friendly display titles (`name`) from clean Google Maps queries (`place_name`), supports positional intermediate `waypoint_place_ids` (`|ChIJ...||`), and auto-extracts base64url Place IDs directly from pasted Maps URLs in the edit drawer.
  * **Device Handoff:** Supports 1-click ADB push (`/sdcard/Android/data/com.roadtrip.copilot/files/itineraries/`), local Wi-Fi QR download staging (`GET /api/device/download/:filename`), and Android SAF file picker import.
  * **Route Loading, Local Import & Multi-Day Navigation:** Discovers workspace itineraries via Fastify `/api/itineraries`. Supports local JSON file drag-and-drop import via `itineraryParser.ts`. Displays a multi-day leg switcher bar (`DayTabBar.tsx`) to view, edit, and cascade any day in multi-day road trips while keeping in-memory edits intact.

### G. Human-Centered UI/UX Principles (Route Builder Studio)
* **Clarity & Intuitiveness Over Clutter:** The web interface must be immediately intuitive to a road-tripper. Prioritize clean visual hierarchy, generous spacing, and self-explanatory controls.
* **Zero Technical Jargon in Primary UI:** Do not display internal verification badges or raw math jargon in user-facing views. Keep cards clean and readable.
* **Dedicated Top Bar for Global Controls:** Place trip-level controls (search bar, trip date, departure time / catch-up, drive/dwell metrics, Google Maps links, Export & Sync) in a horizontal top header (`AppHeader.tsx`), reserving vertical space in the left panel for the itinerary timeline.
* **Scannable Waypoints via Progressive Disclosure:** Waypoint cards in `TimelineSidebar.tsx` must be compact and easily scannable by default (stop number badge with category color, stop name, arrival/departure time, dwell duration, and alert indicator). Detailed controls (renaming, category, dwell, trigger distance, speech scripts) belong in an inline expandable edit drawer.
* **Explicit & Discoverable Actions:** Primary actions must be unmistakable: provide an obvious `+ Add Stop` button, clear inline edit buttons, reorder arrows, and delete icons.
* **Resizable Workspace:** The waypoint sidebar must be draggable/resizable (320px–680px) with `localStorage` persistence and double-click reset.

---

## 3. Directory Layout
```
roadtrip-copilot/
├── AGENTS.md                  # This handbook
├── README.md                  # Project overview and setup guide
├── itineraries/               # Workspace itineraries directory (git-ignored custom routes)
│   ├── .gitignore             # Ignores *.json while tracking sample_itinerary.json
│   └── sample_itinerary.json  # Bundled sample route (Phoenix → Sedona → Flagstaff)
├── docs/
│   ├── IDEAS.md               # Feature backlog and roadmap proposals
│   ├── android_auto_multitasking_architecture.md # Coolwalk multitasking model, slot mechanics & design rationale
│   ├── route_builder_research_and_architecture.md # Technical specification & domain architecture
│   └── route_scout_cloud_architecture.md # Production cloud model API architecture & function calling blueprint
├── scripts/                   # Environment setup & run scripts (run_dhu.sh, setup_env.sh)
├── gradlew, gradlew.bat       # Gradle wrapper executable
├── settings.gradle.kts        # Multi-project gradle settings
├── build.gradle.kts           # Root build configuration
├── route-builder/             # Full-Stack Web Studio
│   ├── AGENTS.md              # Route Builder subproject agent handbook & directory structure
│   ├── README.md              # User-facing web studio documentation & setup
│   ├── package.json           # Node scripts (dev, build, test, test:backend, test:engine, test:ai, test:schema)
│   ├── vite.config.ts         # Vite configuration with /api reverse proxy to port 3001
│   ├── server/                # Fastify TypeScript backend
│   │   ├── app.ts             # Fastify app factory with CORS and routes
│   │   ├── index.ts           # Server entrypoint (listening on 0.0.0.0:3001)
│   │   ├── routes/            # Fastify plugins (routing.ts, ai.ts, device.ts, itineraries.ts, scout.ts)
│   │   ├── services/          # Business logic (routeService, geocodeService, routeCache, aiService, deviceService, itineraryStorageService, scoutService)
│   │   └── types/             # Strict TypeScript interfaces (0 any types)
│   ├── src/                   # React frontend
│   │   ├── App.tsx            # Main application layout & state coordinator
│   │   ├── components/        # AppHeader, DayTabBar, RouteSelectorModal, MapCanvas, TimelineSidebar, SearchBar, EditWaypointModal, ExportModal, RouteScoutDrawer
│   │   ├── engine/            # cascade.ts (math cascade), googleMapsUrl.ts (chunking), export.ts (V2 JSON), itineraryParser.ts (multi-day import)
│   │   ├── services/          # api.ts (HTTP client), aiQueue.ts (concurrency queue)
│   │   └── types/             # Frontend data models (routing, ai, scout)
│   └── tests/                 # Vitest test suites (168 tests: backend, engine, ai, schema, device, itineraries, scout)
└── app/
    ├── build.gradle.kts       # App module dependencies & SDK config
    └── src/
        ├── test/              # JUnit & Robolectric unit tests (RouteRepositoryTest, RouteListScreenTest, ItineraryTest)
        └── main/
            ├── AndroidManifest.xml
            ├── assets/
            │   └── sample_itinerary.json # Bundled fallback route for offline navigation
            ├── res/
            │   ├── layout/    # Dashboard (activity_main.xml with SAF import button) and custom spinner layouts
            │   ├── drawable/  # Vector assets
            │   └── xml/
            │       └── automotive_app_desc.xml
            └── java/com/roadtrip/copilot/
                ├── MainActivity.kt        # Phone dashboard, SAF import contract, route spinner & volume calibration
                ├── CopilotService.kt      # Foreground service lifecycle, dynamic route loading & pace telemetry
                ├── LocationTracker.kt     # Event-driven GPS, sequential progression & pace resolution
                ├── AudioDuckEngine.kt     # Audio focus, stream routing & TTS manager
                ├── NotificationEngine.kt  # Android Auto MessagingStyle heads-up cards
                ├── NotificationReceiver.kt# Broadcast receiver for AA voice reply & dismiss
                ├── car/                   # Android Auto In-Car UI (Android for Cars App Library)
                │   ├── CopilotCarAppService.kt   # Automotive app service & host validator
                │   ├── CopilotCarSession.kt      # Automotive session manager
                │   ├── CopilotDashboardScreen.kt # PaneTemplate car dashboard with live telemetry
                │   ├── WaypointListScreen.kt     # ListTemplate for chronological milestones
                │   ├── RouteListScreen.kt        # Dynamic ListTemplate with 6-item pagination & distraction compliance
                │   └── SettingsScreen.kt         # ListTemplate for audio ducking toggles & calibration
                └── model/
                    ├── RouteRepository.kt # Singleton scanning storage & asset fallbacks, StateFlow<List<RouteOption>>
                    ├── RouteOption.kt     # Unified route metadata class
                    ├── AssetProvider.kt   # Interface abstraction for pure JVM unit testing
                    └── ItineraryModels.kt # Itinerary data classes (V1 & V2 schemas), pace resolution
```

---

## 4. Environment & Build Commands

### Prerequisites
* **Java:** OpenJDK 17 (`java -version`, `javac -version`).
* **Android SDK:** Installed at `$ANDROID_HOME` or OS default (Linux: `$HOME/Android/Sdk`, macOS: `~/Library/Android/sdk`, Windows: `%LOCALAPPDATA%\Android\Sdk`).
* **ADB:** Available in system PATH (`adb devices`).
* **Node.js & npm:** Node v18+ (Node 20+ LTS recommended) and npm v9+.
* **Antigravity CLI (`agy`):** Optional for zero-config local AI copywriting (`~/.local/bin/agy`).

### Android Native Commands
* **Build Debug APK:**
  ```bash
  ./gradlew assembleDebug
  ```
* **Run Android Unit & Robolectric Tests:**
  ```bash
  ./gradlew testDebugUnitTest
  ```
* **Install to Connected Android Phone:**
  ```bash
  adb install -r app/build/outputs/apk/debug/app-debug.apk
  ```
* **Stream Live Logs from Connected Phone:**
  ```bash
  adb logcat -s CopilotService:V AudioDuckEngine:V LocationTracker:V NotificationEngine:V RouteRepository:V
  ```
* **Simulate Location Mock via ADB:**
  ```bash
  adb emu geo fix -73.75620 42.65260
  ```

### Route Builder Web Studio Commands
* **Install Dependencies:**
  ```bash
  cd route-builder && npm install
  ```
* **Start Dev Server (Both Frontend :5173 and Backend :3001):**
  ```bash
  cd route-builder && npm run dev
  ```
* **Compile TypeScript & Production Build:**
  ```bash
  cd route-builder && npm run build
  ```
* **Run All 168 Vitest Tests:**
  ```bash
  cd route-builder && npm test
  ```
* **Run Granular Test Suites:**
  ```bash
  cd route-builder && npm run test:backend  # OSRM, Nominatim, LRU cache
  cd route-builder && npm run test:engine   # Timeline cascade & Google Maps chunking
  cd route-builder && npm run test:ai       # AI harness adapters, schema validation, scout
  cd route-builder && npm run test:schema   # V2 export & device sync
  ```

---

## 5. Rules for Contributing Developers & Agents
1. **Never add cloud API dependencies to the Android in-car drive loop:** Do not introduce Retrofit, Firebase, Google Maps API keys, or web geocoding into `app/`. The Android foreground service must operate 100% offline.
2. **Strict Battery & Threading Discipline:** In Android, use Kotlin Coroutines (`Dispatchers.IO` for disk/storage/assets, `Dispatchers.Default` for math/JSON parsing, `Dispatchers.Main` for UI/notifications). In Node/Fastify, keep network I/O asynchronous and use LRU caching for routing calls.
3. **Preserve Backward Compatibility in Itineraries:** The Android app must seamlessly parse both V1 schemas (bundled static assets) and V2 schemas (`dwell_minutes`, `type`, `metadata`). Never remove fields from `ItineraryModels.kt`.
4. **Strict TypeScript in `route-builder/`:** Enforce `strict: true` with **zero `any` types**. Catch blocks must use `err: unknown` with `err instanceof Error` narrowing.
5. **Preserve Literal Semicolon in OSRM Coordinate Paths:** The OSRM routing engine strictly requires unencoded `;` delimiters in its URL path segment. Never call `encodeURIComponent` on coordinate strings passed in URL paths.
6. **Preserve Android Auto Distraction Constraints:** List templates displayed while driving must never exceed 6 items per page. Always use pagination or truncation in `androidx.car.app` screens.
7. **Idiomatic Code:** Write concise, null-safe Kotlin and modular, typed TypeScript with single-responsibility components.
8. **Maintain Clean, Human-Friendly UI:** Never introduce internal debug text or verification claims into `route-builder/`. All UI updates must adhere to Section 2G Human-Centered UI/UX Principles.
9. **Maintain Directory Layout in Section 3:** Whenever adding, removing, or relocating core classes, services, or architecture files, update the Directory Layout in Section 3 so that developers and agents can quickly navigate the codebase without scanning the entire tree.
10. **Preserve Route Scout Prompt Purity:** Keep `buildScoutDomainPrompt` strictly domain-focused. Never leak harness-specific tool bans, terminal commands, or background task mechanics into the domain prompt. Implement all harness capabilities, tool allowlists, and response cleaning via the `AiHarnessAdapter` seam (`decorateScoutPrompt` and `sanitizeResponse`).
