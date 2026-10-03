# Roadtrip Co-Pilot for Android Auto

A background audio guide and heads-up alert companion that runs alongside Google Maps in Android Auto during multi-stop road trips.

---

## The Road Trip Problem & In-Car Experience

When driving a multi-stop road trip with Android Auto:
* Google Maps handles turn-by-turn directions, but doesn't know your planned itinerary, scenic pull-offs, or scheduled stop times.
* Android Auto's dashboard only allows two active tiles (navigation on the left, media on the right). Running a dedicated third-party navigation app displaces your driving map or music. *(For a detailed breakdown of Android Auto's windowing model and slot constraints, see [docs/android_auto_multitasking_architecture.md](docs/android_auto_multitasking_architecture.md)).*

**Roadtrip Co-Pilot runs as an unobtrusive background service.** It monitors your GPS location against a pre-planned route and delivers timed audio and visual heads-up alerts without displacing Google Maps:

> **The In-Car Experience:**
> Imagine driving along a scenic mountain highway listening to music. Google Maps is handling navigation. Two miles before a scheduled scenic canyon overlook:
> 1. Your music smoothly dips in volume (audio ducking).
> 2. The car speakers announce: *"Approaching Canyon Vista Overlook in two miles. Parking is on the right; scheduled 20-minute photo stop."*
> 3. A brief heads-up notification card appears over Google Maps: `Canyon Vista Overlook — Stop 3 of 8 | On Schedule`.
> 4. Your music returns to full volume.

### Core In-Car Pillars
1. **Zero Screen Conflict:** Google Maps stays on your vehicle's touchscreen 100% of the time.
2. **Audio Ducking & Spoken Alerts:** Briefly lowers music to speak upcoming vista, itinerary, and waypoint details over car speakers.
3. **Android Auto Heads-Up Cards:** Posts high-priority notification cards over Google Maps for 5-7 seconds as you approach pull-offs.
4. **100% Offline Satellite Resilience:** Operates directly from your device's GNSS satellite receiver and a local JSON itinerary. No cellular signal is required in remote canyons, national parks, or mountain passes.
5. **Schedule & Pace Telemetry:** Dynamically calculates whether you are ahead of or behind your target schedule relative to planned stop arrival times.

---

## How It Works: The Two-Part Ecosystem

Roadtrip Co-Pilot consists of two coordinated tools:

```
+------------------------------------+          +------------------------------------+
|     Route Builder Web Studio       |          |        In-Car Android App          |
|            (Desktop)               |          |       (Phone / Android Auto)       |
|                                    |  Sync    |                                    |
| • Plot stops on interactive map    | -------> | • Runs in background behind Maps   |
| • Auto-calculate driving timelines | (ADB or  | • Ducks Spotify/podcasts for alerts|
| • Scout scenic spots with AI       |  QR Code)| • 100% offline GPS milestone alerts|
| • Generate concise TTS alert audio |          | • Live ahead/behind pace tracking  |
+------------------------------------+          +------------------------------------+
```

### Core Concepts & Terminology
* **Itinerary:** The complete road trip route file (`.json`) containing GPS coordinates, target arrival times, dwell durations, and audio announcement scripts.
* **Waypoints:** Scheduled milestones along your drive—scenic pull-offs, meals, fuel stops, lodging, or route-forcing anchors to keep you on scenic byways.
* **Trigger Radius:** The GPS geofence (between 0.3 and 6.0 miles) around a stop that fires the audio ducking and heads-up alert.
* **Pace Telemetry:** Real-time calculation comparing your current milestone progress against your planned arrival times.

---

## Android App: Setup & Quickstart

### Prerequisites

#### 1. Java Development Kit (JDK 17)
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
  *(Or download from [Adoptium](https://adoptium.net/)).*

Verify installation:
```bash
java -version
javac -version
```

#### 2. Android SDK
Configure your Android SDK path in `local.properties`:

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

#### 3. Android Debug Bridge (ADB)
ADB is used to install APKs and push itineraries to your device:

* **Linux:** `sudo apt install adb` (or via SDK platform-tools)
* **macOS:** `brew install android-platform-tools`
* **Windows:** Install Android SDK Platform-Tools or Android Studio; ensure `adb.exe` is added to your PATH.

Verify phone connectivity:
```bash
adb devices
```
*(Ensure "USB Debugging" is enabled under Developer Options on your phone).*

### Building & Installing

Build and install the debug APK directly to your connected device:

```bash
# Compile debug APK
./gradlew assembleDebug

# Install to connected phone
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### Desktop Head Unit (DHU) Emulation

Test the in-car Android Auto UI on your computer without being in a vehicle using Google's Desktop Head Unit emulator:

1. Connect your phone over ADB (`adb devices`) and start the Android Auto Head Unit Server (under Android Auto Developer Settings on your phone).
2. Run the launch helper:
   ```bash
   ./scripts/run_dhu.sh
   ```
3. A 1280x720 display will launch showing Android Auto. Open **Roadtrip Co-Pilot** from the automotive launcher to interact with the in-car UI.

### Required In-Car Device Settings

Android Auto blocks sideloaded apps by default. One-time setup:
1. In Android Auto settings on your phone, tap **Version** 10 times to unlock Developer Settings.
2. Open the three-dot menu -> **Developer Settings** -> check **"Unknown sources"**.
3. Under Android Auto **Notification Settings**: ensure **"Show message notifications"** and **"Show first line of conversations"** are toggled **ON**.

---

## Route Builder Web Studio

The repository includes a desktop-first web application in `route-builder/` for planning multi-stop road trips, computing real road driving times, cascading arrival/departure schedules, scouting hidden gems, generating AI co-pilot announcements, and syncing itineraries directly to your phone.

* **Interactive Map Canvas & Routing:** OpenStreetMap canvas powered by Leaflet and backend OSRM routing proxies with in-memory caching.
* **Timeline Cascade Engine:** Live schedule calculations with dwell time ripple, multi-state timezone boundary detection, and backward catch-up scheduling.
* **Route Scout AI Assistant:** Interactive sidebar co-pilot to audit drive segments, discover overlooks, and insert vetted waypoints with 1-click timeline integration.
* **AI Heads-Up Generation:** Instant generation of Android Auto heads-up cards and TTS scripts tailored to car audio constraints.
* **Multi-Leg Google Maps Export:** Generates route-shaping navigation links with automatic 9-stop leg chunking and QR codes to prevent unwanted highway rerouting.
* **1-Click Device Handoff:** Instant ADB push to phone storage, local Wi-Fi QR code download, or SAF file export.

### Quickstart

```bash
cd route-builder
npm install
npm run dev
```
* **Frontend:** `http://localhost:5173`
* **Backend:** `http://localhost:3001`

> [!NOTE]
> **AI Configuration Note:**
> Route planning, road routing, timeline calculations, and device sync work 100% offline out-of-the-box. AI features (heads-up alert copywriting and the interactive Route Scout conversational assistant) require an AI engine: either the local Antigravity CLI (`agy`) or a Google AI Studio API key.

For complete documentation on route authoring, AI model configuration, test suites, and phone handoff methods, see [route-builder/README.md](route-builder/README.md).

---

## Android App Features & In-Car Controls

* **Android Auto Dashboard:** Native car display dashboard built with Android for Cars App Library (`androidx.car.app`), featuring a live telemetry pane, chronological milestones view, dynamic route switcher, and audio settings.
* **Dynamic Route Loading:** Import any custom itinerary from phone storage without rebuilding the APK. Bundled sample routes in `assets/` serve as built-in examples and offline fallbacks.
* **In-Car Route Switcher (`RouteListScreen`):** Conforms to Android Auto distraction guidelines by capping items at 6 per page with "Prev" and "Next" paging. Active routes display a `"✓ "` indicator.
* **Audio Channel Routing:** Toggle between the vehicle's **Media Channel** (standard stereo volume knob) and **Navigation Channel** (dedicated car navigation guidance stream).
* **Pause vs. Duck:** Cleanly pauses music during announcements by default, with an option for subtle -14 dB background ducking.
* **Continuous Volume Calibration:** Loops a 12-second speech sample to easily balance car stereo volume levels before driving.
* **Schedule Pace Telemetry:** Real-time calculation of schedule pace (ahead/behind target arrival time) in the persistent notification and in-car dashboard.

---

## Project Documentation & Architecture

* **[AGENTS.md](AGENTS.md):** Complete developer handbook, foreground service lifecycle, audio focus routing, distraction rules, and up-to-date repository directory layout.
* **[route-builder/README.md](route-builder/README.md):** Web Studio guide, prerequisites, AI configuration, verification workflow, and test suites.
* **[docs/android_auto_multitasking_architecture.md](docs/android_auto_multitasking_architecture.md):** Android Auto Coolwalk multitasking model, screen slot mechanics, and background co-pilot design rationale.
* **[docs/IDEAS.md](docs/IDEAS.md):** Feature backlog and roadmap (multi-provider AI adapters, custom voice profiles, GPX import/export, weather radar).
* **[docs/route_builder_research_and_architecture.md](docs/route_builder_research_and_architecture.md):** Technical specification for timeline cascading, routing proxies, and schema contracts.
