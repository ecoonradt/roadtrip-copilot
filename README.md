# Roadtrip Co-Pilot for Android Auto

A lightweight, unkillable native Android background assistant designed to run alongside Google Maps in Android Auto.

---

## Trip Overview: Phoenix (PHX) to Albuquerque (ABQ)
* **Dates:** Friday, October 9 – Monday, October 12
* **Route:** Phoenix $\to$ Sedona $\to$ Oak Creek Canyon $\to$ Flagstaff $\to$ Shiprock / Navajo Nation $\to$ Chama $\to$ Brazos Mountain Pass $\to$ Taos $\to$ High Road $\to$ Santa Fe $\to$ Albuquerque Sunport (ABQ)

---

## Why a Native Background App?
Android Auto's split-screen dashboard is limited to two active app tiles (typically Google Maps navigation on the left, Media/Spotify on the right). A custom 3rd-party navigation app would compete with your music.

Roadtrip Co-Pilot solves this by running as an unkillable **Foreground Service** on your phone:
1. **Zero Screen Conflict:** Google Maps stays on your car's touchscreen 100% of the time.
2. **Audio Ducking:** When approaching a waypoint, your music/podcast ducks down cleanly, speaks the scenic or navigational announcement over your car speakers, and returns to full volume.
3. **Android Auto Heads-Up Banners:** Displays high-priority heads-up cards over Google Maps on the car screen for 5–7 seconds as you approach waypoints and scenic pull-offs.
4. **100% Offline:** Runs directly off your phone's GNSS satellite receiver and baked-in itinerary. No cell reception or internet connection needed in remote canyons or mountain passes.

---

## Prerequisites & Machine Setup

### 1. JDK 17
Ensure Java 17 is installed on your development machine:
```bash
sudo apt update && sudo apt install -y openjdk-17-jdk
```
Verify with:
```bash
java -version
javac -version
```

### 2. Android Debug Bridge (ADB)
ADB is installed at `/usr/bin/adb`. Verify phone connection:
```bash
adb devices
```
*(Ensure "USB Debugging" is enabled under Developer Options on your phone).*

### 3. Android SDK
If building headlessly via the command line, configure your Android SDK location in `local.properties`:
```properties
sdk.dir=/home/eric/Android/Sdk
```

### 4. Node.js & npm (For Route Builder Web Studio)
* **Node.js:** v18.0.0 or newer (tested on v24.14.0)
* **npm:** v9.0.0 or newer (tested on v11.9.0)

### 5. AI Co-Pilot Engine (Optional Configuration)
The Route Builder features an intelligent co-pilot copywriter for heads-up Android Auto notifications and natural spoken audio:
* **Zero Configuration (Recommended):** If the Antigravity CLI (`agy`) is installed in your PATH (e.g. at `~/.local/bin/agy`), the Route Builder automatically shells out to `agy -p "..." --output-format json` using your active Gemini 3.8 session. **Zero API keys required.**
* **Cloud Fallback:** If running outside an Antigravity environment, supply a Google AI Studio developer API key in the UI modal or via environment variable:
  ```bash
  export GEMINI_API_KEY="your-google-ai-studio-api-key"
  ```
* **Offline Deterministic Fallback:** If neither `agy` nor an API key is present, the app falls back to context-aware template alerts without failing or crashing.

---

## Route Builder Web Studio (`route-builder/`)

A desktop-first full-stack authoring studio to design custom itineraries, preview driving times, generate AI co-pilot announcements, and seamlessly sync to your phone.

```
route-builder/
├── server/               # Fastify backend (OSRM proxy, Nominatim proxy, agy CLI bridge, ADB push)
├── src/
│   ├── components/       # Leaflet Map canvas, Timeline sidebar, AI modal, Export modal
│   ├── engine/           # Deterministic timeline cascade, Google Maps URL chunking, V2 JSON exporter
│   └── services/         # Client API client and concurrency queue (AiQueue)
└── tests/                # 97 unit/integration tests across backend, engine, AI, and device sync
```

### 1. Running the Route Builder
```bash
cd route-builder
npm install
npm run dev
```
This boots both services concurrently:
* **Frontend Web App:** `http://localhost:5173` (Vite + React + Leaflet + Tailwind CSS)
* **Local Backend API:** `http://localhost:3001` (Fastify + TypeScript)

### 2. Core Capabilities
* **Interactive Road Graph Routing:** Click anywhere on the map or search addresses via Nominatim to drop waypoint pins. The backend queries OSRM to snap to real roads, draw driving polylines, and compute precise transit durations.
* **Deterministic Timeline Cascade:** Set your day's departure time (or destination arrival deadline in "Flight Catch-up" mode). Adjusting dwell time on any stop automatically ripples through all downstream arrival/departure timestamps without temporal drift.
* **Timezone Border Awareness:** Automatically detects state boundaries (e.g. Arizona UTC-7 MST $\to$ New Mexico UTC-6 MDT) and applies the $+1$ hour jump in local time while keeping underlying UTC epoch milestones strictly linear.
* **AI Co-Pilot Copywriting:** Click "AI Co-Pilot Alert" on any stop or "Batch Generate All Day Alerts" to generate Android Auto heads-up cards ($\le 30$ chars) and natural phonetic TTS audio scripts (15–25 words, spoken within 8–12 seconds). Preview spoken audio directly in your browser using the built-in speech synthesizer.
* **Google Maps Navigation Links & Route-Shaping Anchors:** Automatically constructs multi-stop Google Maps driving URLs with route-forcing waypoints to prevent Google Maps from rerouting away from scenic byways. Drives exceeding 9 intermediate stops are automatically partitioned into morning and afternoon legs with dedicated QR codes.

### 3. Syncing Routes to Your Phone (4 Ways)
Click **"Export & Sync to Phone"** in the Route Builder toolbar:
1. **1-Click ADB Push:** With your phone plugged in via USB (or wireless ADB), click **"Push to Phone via ADB"**. The backend validates device status and pushes the itinerary directly to `/sdcard/Android/data/com.roadtrip.copilot/files/itineraries/<filename>.json`.
2. **Local Wi-Fi QR Code:** Point your phone camera at the on-screen QR code to download the itinerary directly to your phone's `Downloads/` folder over your home Wi-Fi network.
3. **In-App File Import (SAF):** On your phone, open Roadtrip Co-Pilot $\to$ tap **"Import Itinerary (JSON)"** to select any downloaded `.json` file.
4. **Google Maps QR Codes:** Scan the dedicated leg QR codes to instantly launch Google Maps turn-by-turn navigation on your car screen.

### 4. Running Web Studio Tests & Production Build
```bash
cd route-builder
npm run test          # Runs all 97 Vitest unit & integration tests
npm run test:backend  # Tests Nominatim/OSRM proxies, caching, and device endpoints
npm run test:engine   # Tests timeline cascade math, dwell ripples, and Google Maps URL chunking
npm run test:ai       # Tests prompt contracts, schema truncation, batching, and client queue
npm run test:schema   # Tests V2 JSON export compatibility
npm run build         # Compiles TypeScript (0 any types) and produces production client & server bundles
```

---

## Key Features & In-App Controls
* **Android Auto In-Car UI:** Native car display dashboard built with Android for Cars App Library (`androidx.car.app`), featuring a live telemetry dashboard, chronological waypoints view, dynamic route switcher, and in-car settings toggles.
* **Dynamic Route Loading & SAF File Picker:** Import arbitrary itineraries from your phone's storage without rebuilding the APK. Bundled assets (`itinerary.json`, `test_itinerary.json`, `test_itinerary_return.json`) remain permanent fallbacks.
* **In-Car Route Switcher (`RouteListScreen`):** Conforms to Android Auto driving safety guidelines by capping items at 6 per page with interactive `< Prev` and `Next >` navigation. Active routes are visually decorated with a `"✓ "` prefix.
* **Audio Channel Routing:** Toggle between the car's **Media Channel** (stereo volume knob control) and **Navigation Channel** (car navigation voice channel).
* **Pause vs. Duck:** Choose between standard audio ducking or completely pausing music during waypoint announcements.
* **Continuous Volume Calibration:** Loops a 12-second speech sample to adjust and balance vehicle volume levels prior to driving.
* **Pace Telemetry:** Real-time calculation of schedule pace (ahead/behind target arrival time) in the persistent notification and dashboard.

---

## Desktop Head Unit (DHU) Emulation
You can test the in-car Android Auto UI on your computer using Google's Desktop Head Unit emulator:
1. Ensure your phone is connected over ADB (`adb devices`) with the Android Auto Head Unit Server started (under Android Auto Developer Settings).
2. Run the helper script:
   ```bash
   ./scripts/run_dhu.sh
   ```
3. A 1280x720 automotive display will appear showing Android Auto. Open **Roadtrip Co-Pilot** from the car app launcher to interact with the in-car UI.

---

## Architecture & Code Structure
* **`app/src/main/assets/itinerary.json`**: Complete 4-day waypoint schedule (PHX $\to$ ABQ), GPS coordinates, trigger radiuses, and announcements.
* **`app/src/main/assets/test_itinerary.json`**: 19-mile local outbound test route (Albany to Nassau, NY).
* **`app/src/main/assets/test_itinerary_return.json`**: 19-mile local return test route (Nassau to Albany, NY).
* **`app/src/main/java/com/roadtrip/copilot/model/RouteRepository.kt`**: Singleton repository scanning `/files/itineraries/` and merging with asset fallbacks, providing reactive `StateFlow<List<RouteOption>>`.
* **`app/src/main/java/com/roadtrip/copilot/model/RouteOption.kt`**: Route metadata model for UI spinners and Car App lists.
* **`app/src/main/java/com/roadtrip/copilot/model/ItineraryModels.kt`**: Data structures supporting V1 and V2 schemas (`dwell_minutes`, `type`), target epoch parsing, and schedule pace formatting.
* **`car/CopilotCarAppService.kt`**: Automotive app service granting host validation.
* **`car/CopilotCarSession.kt`**: Automotive session manager starting the dashboard screen.
* **`car/CopilotDashboardScreen.kt`**: Main `PaneTemplate` car dashboard with telemetry, pace, and action buttons.
* **`car/WaypointListScreen.kt`**: `ListTemplate` displaying chronological itinerary milestones with passed vs upcoming status.
* **`car/RouteListScreen.kt`**: Dynamic `ListTemplate` allowing in-car route switching with 6-item pagination and distraction constraint compliance.
* **`car/SettingsScreen.kt`**: `ListTemplate` offering in-car audio toggles, volume calibration, and test triggers.
* **`CopilotService.kt`**: Foreground service tracking GNSS location, milestone pacing, notification state, and centralized route selection.
* **`LocationTracker.kt`**: Event-driven GNSS listener, sequential waypoint progression, and schedule pace guards.
* **`AudioDuckEngine.kt`**: Audio focus management, stream switching, and offline Text-to-Speech synthesis.
* **`NotificationEngine.kt`**: Android Auto `MessagingStyle` heads-up notification cards with `CarExtender`.
* **`NotificationReceiver.kt`**: Broadcast receiver handling Android Auto voice replies and dismiss actions.
* **`MainActivity.kt`**: Phone dashboard to select route, import itineraries via SAF, calibrate volume, and start/stop the service.
* **`route-builder/`**: Complete Full-Stack Web Studio for roadtrip planning, timeline cascading, AI copywriting, and 1-click phone handoff.
* **`docs/route_builder_research_and_architecture.md`**: Master technical design and mathematical specification.
* **`docs/ORCHESTRATION_PLAN.md`**: Agentic orchestration master verification checklist (all phases verified and completed).
