# Roadtrip Co-Pilot for Android Auto

A lightweight, background audio guide and heads-up alert companion designed to run alongside Google Maps in Android Auto during multi-stop road trips.

---

## Why a Background Co-Pilot?

Android Auto's split-screen dashboard is limited to two active app tiles (typically Google Maps navigation on the left and Media/Spotify on the right). Running a dedicated third-party navigation app displaces your driving map or music.

Roadtrip Co-Pilot solves this by running as a native Android **Foreground Service** strictly in the background:
1. **Zero Screen Conflict:** Google Maps stays on your vehicle's touchscreen 100% of the time.
2. **Audio Ducking:** When approaching a scenic stop, vista, or waypoint, your background audio (Spotify, podcasts) smoothly ducks down, speaks the co-pilot announcement over car speakers, and returns to full volume.
3. **Android Auto Heads-Up Alerts:** Posts high-priority heads-up cards over Google Maps for 5–7 seconds as you approach waypoints and pull-offs.
4. **100% Offline Resilience:** Operates directly from your device's GNSS satellite receiver and a local JSON itinerary. No cellular signal is required in remote canyons, national parks, or mountain passes.
5. **Schedule & Pace Telemetry:** Dynamically calculates whether you are ahead of or behind your target schedule relative to planned stop arrival times.

---

## Prerequisites & Cross-Platform Machine Setup

### 1. Java Development Kit (JDK 17)
Ensure Java 17 is installed:

* **Linux (Ubuntu/Debian):**
  ```bash
  sudo apt update && sudo apt install -y openjdk-17-jdk
  ```
* **macOS (Homebrew):**
  ```bash
  brew install openjdk@17
  ```
* **Windows:**
  ```powershell
  winget install EclipseAdoptium.Temurin.17.JDK
  ```
  *(Or download the installer from [Adoptium](https://adoptium.net/)).*

Verify installation:
```bash
java -version
javac -version
```

### 2. Android Debug Bridge (ADB)
ADB is used to install APKs and push itineraries to your device:

* **Linux:** `sudo apt install adb` (or via SDK platform-tools)
* **macOS:** `brew install android-platform-tools`
* **Windows:** Install Android SDK Platform-Tools or Android Studio; ensure `adb.exe` is added to your PATH.

Verify phone connectivity:
```bash
adb devices
```
*(Ensure "USB Debugging" is enabled under Developer Options on your phone).*

### 3. Android SDK
If building from the command line, configure your Android SDK path in `local.properties`:

* **Linux:**
  ```properties
  sdk.dir=/home/<your-username>/Android/Sdk
  ```
* **macOS:**
  ```properties
  sdk.dir=/Users/<your-username>/Library/Android/sdk
  ```
* **Windows:**
  ```properties
  sdk.dir=C:\\Users\\<your-username>\\AppData\\Local\\Android\\Sdk
  ```

### 4. Node.js & npm (For Route Builder Web Studio)
* **Node.js:** v18.0.0 or newer (v20+ LTS recommended)
* **npm:** v9.0.0 or newer

* **Linux:** `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs`
* **macOS:** `brew install node`
* **Windows:** `winget install OpenJS.NodeJS.LTS`

### 5. AI Co-Pilot Narration (Optional Configuration)
The Route Builder features an AI copywriting engine to generate glanceable heads-up alert cards and natural spoken audio scripts. It is built on an extensible adapter pattern:

* **Local Zero-Config (Recommended):** If the Antigravity CLI (`agy`) is in your PATH (e.g. `~/.local/bin/agy`), the Route Builder automatically resolves and invokes the active/latest Gemini Flash model (e.g. `gemini-3.8-flash-high`) using your active session. **Zero API keys required.** (Optional override: `export AGY_MODEL="model-name"`).
* **Cloud API Fallback:** Supply a Google AI Studio developer API key in the UI modal or via environment variable:
  ```bash
  export GEMINI_API_KEY="your-google-ai-studio-api-key"
  ```
  *(Defaults to `gemini-3.8-flash`; override via `export GEMINI_MODEL="model-name"`).*
* **Offline Deterministic Fallback:** If neither `agy` nor an API key is present, context-aware template alerts are generated automatically without failing.
* **Future Providers:** Pluggable adapters for Anthropic Claude, OpenAI, and local offline models (Ollama) are planned. See [IDEAS.md](IDEAS.md).

---

## Route Builder Web Studio (`route-builder/`)

A desktop-first web application to plan multi-stop road trips, compute driving durations, adjust dwell schedules, generate co-pilot announcements, and sync itineraries directly to your phone.

```
route-builder/
├── server/               # Fastify backend (OSRM proxy, Nominatim proxy, AI harness adapters, ADB push)
├── src/
│   ├── components/       # Leaflet Map canvas, Timeline sidebar, AI alert modal, Export modal
│   ├── engine/           # Timeline schedule cascade, Google Maps URL chunking, V2 JSON exporter
│   └── services/         # API client and concurrency queue (AiQueue)
└── tests/                # 111 unit/integration tests across backend, engine, AI, and device sync
```

### 1. Running the Route Builder
```bash
cd route-builder
npm install
npm run dev
```
This starts both services concurrently:
* **Frontend Web App:** `http://localhost:5173` (Vite + React + Leaflet + Tailwind CSS)
* **Local Backend API:** `http://localhost:3001` (Fastify + TypeScript)

### 2. Core Capabilities
* **Interactive Map Routing:** Click on the map or search addresses to place waypoints. The backend queries OSRM to snap to roads, draw driving geometry, and calculate drive durations.
* **Timeline Schedule Cascade:** Set your departure time (or arrival deadline in "Catch-up" mode). Adjusting dwell time at any stop automatically updates all downstream arrival and departure times.
* **Timezone Awareness:** Automatically recognizes timezone transitions across state boundaries and formats local times correctly while preserving UTC chronological order.
* **AI Alert Copywriting:** Generate Android Auto heads-up cards ($\le 30$ chars) and natural phonetic TTS audio scripts (15–25 words, spoken within 8–12 seconds). Preview spoken audio directly in your browser using the speech synthesizer.
* **Google Maps Multi-Stop Navigation Links:** Constructs Google Maps driving URLs with route-shaping waypoints to prevent Google Maps from rerouting away from scenic byways. Routes with more than 9 intermediate stops are automatically partitioned into consecutive driving legs with dedicated QR codes.

### 3. Syncing Itineraries to Your Phone (4 Methods)
Click **"Export & Sync to Phone"** in the Route Builder toolbar:
1. **1-Click ADB Push:** Plug your phone in via USB (or wireless ADB) and click **"Push to Phone via ADB"**. The itinerary is saved to `/sdcard/Android/data/com.roadtrip.copilot/files/itineraries/<filename>.json`.
2. **Local Wi-Fi QR Code:** Scan the on-screen QR code with your phone camera to download the JSON itinerary over your local Wi-Fi network.
3. **In-App File Import (SAF):** On your phone, open Roadtrip Co-Pilot and tap **"Import Itinerary (JSON)"** to select any downloaded `.json` file via the Android Storage Access Framework.
4. **Google Maps QR Codes:** Scan the dedicated leg QR codes to launch Google Maps turn-by-turn navigation directly on your phone and car screen.

### 4. Running Web Studio Tests & Production Build
```bash
cd route-builder
npm test              # Run all 111 Vitest unit & integration tests
npm run test:backend  # Test routing proxies, caching, and device endpoints
npm run test:engine   # Test timeline cascade math, dwell ripples, and URL chunking
npm run test:ai       # Test AI prompt contracts, schema parsing, and adapters
npm run test:schema   # Test V2 JSON export compatibility
npm run build         # Production compile (client Vite bundle + backend tsc)
```

---

## Android App Features & In-Car Controls

* **Android Auto Dashboard:** Native car display dashboard built with Android for Cars App Library (`androidx.car.app`), featuring a live telemetry pane, chronological milestones view, dynamic route switcher, and audio settings.
* **Dynamic Route Loading:** Import any custom itinerary from phone storage without rebuilding the APK. Bundled sample routes in `assets/` serve as built-in examples and offline fallbacks.
* **In-Car Route Switcher (`RouteListScreen`):** Conforms to Android Auto distraction guidelines by capping items at 6 per page with `< Prev` and `Next >` paging. Active routes display a `"✓ "` indicator.
* **Audio Channel Routing:** Toggle between the vehicle's **Media Channel** (standard stereo volume knob) and **Navigation Channel** (dedicated car navigation guidance stream).
* **Pause vs. Duck:** Choose between ducking background audio or temporarily pausing music during waypoint announcements.
* **Continuous Volume Calibration:** Loops a 12-second speech sample to easily balance car stereo volume levels before driving.
* **Schedule Pace Telemetry:** Real-time calculation of schedule pace (ahead/behind target arrival time) in the persistent notification and in-car dashboard.

---

## Desktop Head Unit (DHU) Emulation

Test the in-car Android Auto UI on your computer without being in a vehicle using Google's Desktop Head Unit emulator:

1. Connect your phone over ADB (`adb devices`) and start the Android Auto Head Unit Server (under Android Auto Developer Settings on your phone).
2. Run the launch helper:
   ```bash
   ./scripts/run_dhu.sh
   ```
3. A 1280x720 display will launch showing Android Auto. Open **Roadtrip Co-Pilot** from the automotive launcher to interact with the in-car UI.

---

## Architecture & Code Structure

* **`app/src/main/assets/`**: Bundled sample itineraries (`itinerary.json`, `test_itinerary.json`, `test_itinerary_return.json`) used for testing and offline fallback defaults.
* **`app/src/main/java/com/roadtrip/copilot/model/RouteRepository.kt`**: Repository scanning internal storage (`/files/itineraries/`) and merging with asset fallbacks, exposing reactive `StateFlow<List<RouteOption>>`.
* **`app/src/main/java/com/roadtrip/copilot/model/RouteOption.kt`**: Route metadata model for UI selection spinners and Car App lists.
* **`app/src/main/java/com/roadtrip/copilot/model/ItineraryModels.kt`**: Itinerary data classes supporting V1 and V2 schemas (`dwell_minutes`, `type`, `metadata`), target epoch parsing, and schedule pace formatting.
* **`car/CopilotCarAppService.kt`**: Automotive app service granting host validation.
* **`car/CopilotCarSession.kt`**: Automotive session manager starting the dashboard screen.
* **`car/CopilotDashboardScreen.kt`**: Main `PaneTemplate` car dashboard with telemetry, pace, and action buttons.
* **`car/WaypointListScreen.kt`**: `ListTemplate` displaying chronological itinerary milestones with passed vs. upcoming status.
* **`car/RouteListScreen.kt`**: Dynamic `ListTemplate` allowing in-car route switching with 6-item pagination and distraction constraint compliance.
* **`car/SettingsScreen.kt`**: `ListTemplate` offering in-car audio toggles, volume calibration, and test triggers.
* **`CopilotService.kt`**: Foreground service tracking GNSS location, milestone pacing, notification state, and centralized route selection.
* **`LocationTracker.kt`**: Event-driven GNSS listener, sequential waypoint progression, and schedule pace guards.
* **`AudioDuckEngine.kt`**: Audio focus management, stream switching, and offline Text-to-Speech synthesis.
* **`NotificationEngine.kt`**: Android Auto `MessagingStyle` heads-up notification cards with `CarExtender`.
* **`NotificationReceiver.kt`**: Broadcast receiver handling Android Auto voice replies and dismiss actions.
* **`MainActivity.kt`**: Phone dashboard to select routes, import itineraries via SAF, calibrate volume, and start/stop the service.
* **`route-builder/`**: Full-Stack Web Studio for road trip planning, timeline cascading, AI copywriting, and 1-click device sync.
* **`IDEAS.md`**: Feature backlog and roadmap proposals (multi-provider AI harnesses, GPX export, weather overlays).
* **`AGENTS.md`**: Developer and agent handbook containing architectural pillars and guidelines.
