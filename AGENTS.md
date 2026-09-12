# AGENTS.md — Roadtrip Co-Pilot Developer & Agent Handbook

## 1. Project Purpose & Road Trip Context
* **Mission:** A native Android background co-pilot designed to run alongside Google Maps in Android Auto during an upcoming 4-day road trip from **Phoenix, AZ to Albuquerque, NM** (October 9–12).
* **Route:** PHX Airport $\to$ Sedona / Oak Creek Canyon $\to$ Flagstaff $\to$ Shiprock / Navajo Nation $\to$ Chama $\to$ Brazos Mountain Pass $\to$ Taos $\to$ High Road to Santa Fe $\to$ Albuquerque Sunport (ABQ).
* **The Problem:** Android Auto's "Coolwalk" split-screen dashboard only permits two active tiles (typically Google Maps on the left, Media/Spotify on the right). A custom 3rd-party Car App screen would displace music or navigation.
* **The Solution:** A lightweight, unkillable native Android **Foreground Service** that runs in the background. It monitors GPS location against local waypoint coordinates, posts high-priority heads-up cards over Google Maps, and ducks car audio to speak upcoming scenic and itinerary details.

---

## 2. Core Architectural Pillars

### A. Background Survivability (Foreground Service)
* Modern Android (Android 14 through Android 17+) strictly enforces foreground service policies.
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
* A persistent low-priority ongoing notification keeps the service active (OOM score -1000) so Android OS never kills it while driving.

### B. Audio Ducking, Stream Routing & Calibration
* When approaching a waypoint, the app must duck or optionally pause whatever is playing (Spotify, podcasts) rather than talking over it.
* Uses Android's `AudioManager` with `AudioFocusRequest`:
  * Focus Gain: `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK` (default) or `AUDIOFOCUS_GAIN_TRANSIENT` (when "Pause music completely" is toggled).
  * Audio Usage: `AudioAttributes.USAGE_MEDIA` (default, pegged to the car stereo's volume knob) or `AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE` (car navigation guidance channel).
  * Content Type: `AudioAttributes.CONTENT_TYPE_SPEECH`.
* Provides a 12-second continuous calibration speech loop so the driver can adjust the car volume knob in real time.
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
* Supports both fixed ISO-dated itineraries (e.g. PHX $\to$ ABQ with AZ $\to$ NM timezone offset adjustments) and dynamic ad-hoc drive routes (calculated relative to trip start time).
* Locks in-transit pace telemetry to the last confirmed milestone to eliminate false ahead-of-schedule readings while parked before departure.

### E. 100% Offline Resilience (Zero Cellular Dependency)
* Much of the route (Oak Creek Canyon, Navajo Nation, Chama, Brazos Pass) has **zero cellular connectivity**.
* **GPS:** Hardware GNSS satellite radio receives lat/long directly from orbit. No network calls.
* **Proximity Math:** Local Haversine formula executed on-device.
* **Data Source:** Waypoints, triggers, and announcement scripts are baked into `app/src/main/assets/itinerary.json` or imported to `/sdcard/Android/data/com.roadtrip.copilot/files/itineraries/`.
* **TTS Engine:** Uses Android's built-in `TextToSpeech` engine configured with local/offline English voice packs.

### F. Route Authoring, Timeline Cascade & Device Handoff (The Route Builder Web Studio)
* Located in `route-builder/`, providing a full-stack authoring studio (Vite/React frontend on `:5173`, Fastify/TypeScript backend on `:3001`).
* **Hybrid "Engine + Scribe" Pattern:**
  * **Physics & Math Engine:** Backend proxies OSRM road graph directions and Nominatim geocoding (with compliant `User-Agent`). In-memory LRU caching deduplicates requests.
  * **Deterministic Timeline Cascade:** Recalculates arrival/departure times across waypoints; modifying dwell time on stop $k$ mathematically ripples through stops $k+1 \dots n$. Supports backward scheduling from destination deadlines ("Flight Catch-up").
  * **Timezone Border Shifts:** Longitude boundary `-109.0452` automatically detects AZ (MST, UTC-7) vs NM (MDT, UTC-6) crossings, applying the $+1$ hour jump in formatted local time while keeping epoch timestamps strictly linear.
  * **AI Co-Pilot Enrichment:** Primary engine shells out to local `agy -p "..." --output-format json` (Gemini 3.8) with zero API keys required. Truncates titles to $\le 30$ chars, normalizes messages to $\le 2$ lines, and clamps trigger radii to $[0.3, 6.0]$ miles. Client-side `AiQueue` limits concurrency to prevent bursts.
  * **OSRM Routing Protocol Rule:** Coordinate paths sent to the upstream OSRM routing engine must use literal `;` delimiters (e.g. `/${formattedCoords}?overview=...`). **Never URL-encode semicolons as `%3B` in OSRM path segments**, as the router rejects `%3B` with HTTP 400 `InvalidUrl`.
  * **Google Maps Navigation Links:** Generates multi-stop driving links with route-forcing anchors to preserve scenic byways over interstates. Drives exceeding 9 intermediate stops are automatically partitioned into morning and afternoon legs ($\le 9$ intermediate stops each) with dedicated QR codes.
  * **Device Handoff:** Supports 1-click ADB push (`/sdcard/Android/data/com.roadtrip.copilot/files/itineraries/`), local Wi-Fi QR download staging (`GET /api/device/download/:filename`), and Android SAF file picker import.
  * **Route Loading, Local Import & Multi-Day Navigation:** Discovers workspace itineraries via Fastify `/api/itineraries` (`itinerary.json`, test routes). Supports local JSON file drag-and-drop import via `itineraryParser.ts`. Displays a multi-day leg switcher bar (`DayTabBar.tsx`) to view, edit, and cascade any day in multi-day road trips while keeping in-memory edits intact.

### G. Human-Centered UI/UX Principles (Route Builder Studio)
* **Clarity & Intuitiveness Over Clutter:** The web interface must be immediately intuitive to a human road-tripper. More text is not the answer. Prioritize clean visual hierarchy, generous spacing, and self-explanatory controls over dense telemetry.
* **Zero Technical / Debug Filler:** Never display internal verification badges, engine math jargon, or architecture status in the user-facing UI (e.g. NEVER show "Deterministic timeline engine", "Phase 2C verified", "Ripples $k$ stops", or raw coordinate dumps in primary card views).
* **Dedicated Top Bar for Global Controls:** Place trip-level controls (search bar, trip date, departure time / flight catch-up, drive/dwell KPIs, Google Maps links, Export & Sync) in a horizontal top header (`AppHeader.tsx`), reserving 100% of vertical space in the left panel for the itinerary timeline.
* **Scannable Waypoints via Progressive Disclosure:** Waypoint cards in `TimelineSidebar.tsx` must be compact and easily scannable by default (stop number badge with category color, stop name, arrival/departure time, dwell duration, and alert indicator). Detailed controls (renaming, changing category, fine-tuning dwell duration, setting alert trigger distance, and authoring speech scripts) belong in an inline expandable edit drawer.
* **Explicit & Discoverable Actions:** Primary actions must be unmistakable: provide an obvious `+ Add Stop` button, clear inline edit buttons, reorder arrows, and delete icons. Never rely on hidden keyboard shortcuts or unexplained map clicks.
* **Resizable Workspace:** The waypoint sidebar must be draggable/resizable (320px–680px) with `localStorage` persistence and double-click reset to allow comfortable workflow on varying screen resolutions.

---

## 3. Directory Layout
```
roadtrip-copilot/
├── AGENTS.md                  # This handbook
├── README.md                  # Human-facing setup & usage guide
├── itinerary.json             # Core 4-day itinerary (PHX -> ABQ)
├── test_itinerary.json        # Upstate NY 19-mile outbound test route
├── test_itinerary_return.json # Upstate NY return test route (Nassau -> Albany)
├── docs/
│   ├── ORCHESTRATION_PLAN.md  # Master agentic verification checklist (ALL PHASES COMPLETED)
│   └── route_builder_research_and_architecture.md # Master architectural & mathematical spec
├── legacy/                    # Archived prototypes (copilot_engine.py)
├── scripts/                   # Environment setup & run scripts (run_dhu.sh)
├── gradlew, gradlew.bat       # Gradle wrapper executable
├── settings.gradle.kts        # Multi-project gradle settings
├── build.gradle.kts           # Root build configuration
├── route-builder/             # Full-Stack Web Studio (MVP)
│   ├── package.json           # Node scripts (dev, build, test, test:backend, test:engine, test:ai, test:schema)
│   ├── vite.config.ts         # Vite configuration with /api reverse proxy to port 3001
│   ├── server/                # Fastify TypeScript backend
│   │   ├── app.ts             # Fastify app factory with CORS and routes
│   │   ├── index.ts           # Server entrypoint (listening on 0.0.0.0:3001)
│   │   ├── routes/            # Fastify plugins (routing.ts, ai.ts, device.ts, itineraries.ts)
│   │   ├── services/          # Business logic (routeService, geocodeService, routeCache, aiService, deviceService, itineraryStorageService)
│   │   └── types/             # Strict TypeScript interfaces (0 any types)
│   ├── src/                   # React frontend
│   │   ├── App.tsx            # Main application layout & state coordinator
│   │   ├── components/        # AppHeader, DayTabBar, RouteSelectorModal, MapCanvas, TimelineSidebar, SearchBar, AiAlertModal, ExportModal
│   │   ├── engine/            # cascade.ts (math cascade), googleMapsUrl.ts (chunking), export.ts (V2 JSON), itineraryParser.ts (multi-day import)
│   │   ├── services/          # api.ts (HTTP client), aiQueue.ts (concurrency queue)
│   │   └── types/             # Frontend data models
│   └── tests/                 # Vitest test suites (108 tests: backend, engine, ai, schema, device, itineraries)
└── app/
    ├── build.gradle.kts       # App module dependencies & SDK config
    └── src/
        ├── test/              # JUnit & Robolectric unit tests (RouteRepositoryTest, RouteListScreenTest, ItineraryTest)
        └── main/
            ├── AndroidManifest.xml
            ├── assets/
            │   ├── itinerary.json
            │   ├── test_itinerary.json
            │   └── test_itinerary_return.json
            ├── res/
            │   ├── layout/    # Dashboard (activity_main.xml with SAF import button) and custom spinner layouts
            │   ├── drawable/  # Vector assets (ic_import_file.xml)
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
* **Android SDK:** Installed at `$HOME/Android/Sdk` (API 34/35 platform and build-tools).
* **ADB:** Available at `/usr/bin/adb`.
* **Node.js & npm:** Node v18+ (tested on v24.14.0) and npm v9+ (tested on v11.9.0).
* **Antigravity CLI (`agy`):** Available at `~/.local/bin/agy` (used for zero-config Gemini 3.8 AI copywriting).

### Android Native Commands
* **Build Debug APK:**
  ```bash
  ./gradlew assembleDebug
  ```
* **Run Android Unit & Robolectric Tests:**
  ```bash
  ./gradlew testDebugUnitTest
  ```
* **Install to Connected Phone (Pixel 7 Pro):**
  ```bash
  adb install -r app/build/outputs/apk/debug/app-debug.apk
  ```
* **Stream Live Logs from Phone:**
  ```bash
  adb logcat -s CopilotService:V AudioDuckEngine:V LocationTracker:V NotificationEngine:V RouteRepository:V
  ```
* **Simulate Location Mock via ADB (for testing without driving):**
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
* **Run All 97 Vitest Tests:**
  ```bash
  cd route-builder && npm test
  ```
* **Run Granular Test Suites:**
  ```bash
  cd route-builder && npm run test:backend  # OSRM, Nominatim, LRU cache
  cd route-builder && npm run test:engine   # Timeline cascade & Google Maps chunking
  cd route-builder && npm run test:ai       # agy CLI prompt & schema validation
  cd route-builder && npm run test:schema   # V2 export & device sync
  ```

---

## 5. Rules for Contributing Agents
1. **Never add cloud API dependencies to the Android in-car drive loop:** Do not introduce Retrofit, Firebase, Google Maps API keys, or web geocoding into `app/`. The Android foreground service must operate 100% offline.
2. **Strict Battery & Threading Discipline:** In Android, use Kotlin Coroutines (`Dispatchers.IO` for disk/storage/assets, `Dispatchers.Default` for math/JSON parsing, `Dispatchers.Main` for UI/notifications). In Node/Fastify, keep network I/O asynchronous and use LRU caching for routing calls.
3. **Preserve Backward Compatibility in Itineraries:** The Android app must seamlessly parse both V1 schemas (bundled static assets) and V2 schemas (`dwell_minutes`, `type`, `metadata`). Never remove fields from `ItineraryModels.kt`.
4. **Strict TypeScript in `route-builder/`:** Enforce `strict: true` with **zero `any` types**. Catch blocks must use `err: unknown` with `err instanceof Error` narrowing.
5. **Preserve Literal Semicolon in OSRM Coordinate Paths:** The OSRM routing engine strictly requires unencoded `;` delimiters in its URL path segment. Never call `encodeURIComponent` on coordinate strings passed in URL paths.
6. **Preserve Android Auto Distraction Constraints:** List templates displayed while driving must never exceed 6 items per page. Always use pagination or truncation in `androidx.car.app` screens.
7. **Idiomatic Code:** Write concise, null-safe Kotlin and modular, typed TypeScript with single-responsibility components.
8. **Maintain Clean, Human-Friendly UI:** Never re-introduce technical debug text, verification claims, or cramped static panels into `route-builder/`. All UI updates must adhere to Section 2G Human-Centered UI/UX Principles.
