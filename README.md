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

### 5. AI Co-Pilot Narration & Route Scout (Optional Configuration)
The Route Builder features an AI copywriting engine and an interactive Route Scout conversational assistant:

* **Heads-Up Alerts & Speech Scripts:** Generates glanceable in-car heads-up notification cards (titles $\le 30$ chars, messages $\le 2$ lines) and natural spoken audio scripts with clamped trigger radii ($0.3$–$6.0$ miles).
* **Route Scout Conversational Co-Pilot:** An interactive route intelligence advisor in the Route Builder that audits daily driving pace, discovers scenic vistas, local food, fuel stops, and historical points of interest along the driving corridor, and inserts verified waypoints directly into your itinerary with 1-click timeline cascading.
* **Pluggable Harness Architecture:** Built on an extensible adapter pattern:
  * **Local Zero-Config (Recommended):** If the Antigravity CLI (`agy`) is in your PATH (e.g. `~/.local/bin/agy`), the Route Builder automatically resolves and invokes the active/latest Gemini Flash model (e.g. `gemini-3.8-flash-high`) using your active session. **Zero API keys required.** Grounded web searches verify real-world coordinates and operating hours without headless lockups. (Optional override: `export AGY_MODEL="model-name"`).
  * **Cloud API Fallback:** Supply a Google AI Studio developer API key in the UI modal or via environment variable:
    ```bash
    export GEMINI_API_KEY="your-google-ai-studio-api-key"
    ```
    *(Defaults to `gemini-3.8-flash`; override via `export GEMINI_MODEL="model-name"`).*
  * **Offline Deterministic Fallback:** If neither `agy` nor an API key is present, context-aware template alerts are generated automatically without failing.
  * **Future Providers:** Pluggable adapters for Anthropic Claude, OpenAI, and local offline models (Ollama) are planned. See [IDEAS.md](docs/IDEAS.md).

---

## Route Builder Web Studio

The repository includes a desktop-first web application in `route-builder/` for planning multi-stop road trips, computing real road driving times, cascading arrival/departure schedules, scouting hidden gems, generating AI co-pilot announcements, and syncing itineraries directly to your phone.

* **Interactive Map Canvas & Routing:** OpenStreetMap canvas powered by Leaflet and backend OSRM routing proxies with in-memory caching.
* **Timeline Cascade Engine:** Live schedule calculations with dwell time ripple, multi-state timezone boundary detection, and backward catch-up scheduling.
* **Route Scout AI Assistant:** Interactive sidebar co-pilot to audit drive segments, discover overlooks, and insert vetted waypoints with 1-click timeline integration.
* **AI Heads-Up Generation:** Instant batch generation of Android Auto heads-up cards and TTS scripts matching car audio constraints.
* **Multi-Leg Google Maps Export:** Generates route-shaping navigation links with automatic 9-stop leg chunking and QR codes to prevent unwanted highway rerouting.
* **1-Click Device Handoff:** Instant ADB push to `/sdcard/Android/data/com.roadtrip.copilot/files/itineraries/` or local Wi-Fi QR code download.

### Quickstart
```bash
cd route-builder
npm install
npm run dev
```
* **Frontend:** `http://localhost:5173` (Vite + React + Leaflet map canvas)
* **Backend:** `http://localhost:3001` (Fastify routing proxies, AI adapters, and ADB push)

For complete documentation on route authoring, timeline scheduling, AI model configuration, test suites, and phone handoff methods, see [route-builder/README.md](route-builder/README.md).

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

## Project Documentation & Architecture

* **[AGENTS.md](AGENTS.md):** Complete developer handbook, foreground service lifecycle, audio focus routing, distraction rules, and up-to-date repository directory layout.
* **[docs/IDEAS.md](docs/IDEAS.md):** Feature backlog and roadmap (multi-provider AI adapters, custom voice profiles, GPX import/export, weather radar).
* **[route-builder/README.md](route-builder/README.md):** Web Studio architecture, API endpoints, environment variables, and testing guide.
* **[docs/route_builder_research_and_architecture.md](docs/route_builder_research_and_architecture.md):** Technical specification for timeline cascading, routing proxies, and schema contracts.
