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

---

## Phone & Android Auto Preparation

### 1. Enable Android Auto "Unknown Sources" (Required for Sideloaded APK)
Android Auto blocks notifications from apps not installed via the Play Store by default. Unlock developer settings on your phone:
1. Open phone **Settings $\to$ Connected devices $\to$ Connection preferences $\to$ Android Auto**.
2. Scroll to the bottom and tap **Version** 10 times until prompted to allow developer settings.
3. Tap the **three-dot menu ($\vdots$)** in the upper-right corner $\to$ **Developer settings**.
4. Check **Unknown sources**.

### 2. Configure Android Auto Notifications
In phone **Settings $\to$ Android Auto**:
* Toggle **Show message notifications** $\to$ **ON**.
* Toggle **Show first line of conversations** $\to$ **ON** (allows waypoint details to render in the card).
* Toggle **Show conversation chime** $\to$ **ON**.

### 3. Download Offline English TTS Voice Pack (Crucial for Remote Areas)
In remote canyons and mountain passes of Arizona and New Mexico, cellular data will drop:
1. Open phone **Settings $\to$ Accessibility** (or **System**) $\to$ **Text-to-speech output**.
2. Tap the **gear icon** next to **Preferred engine** (Speech Services by Google).
3. Tap **Install voice data $\to$ English (United States)** and download a local offline voice pack.

---

## Building and Installing

### Build Debug APK
```bash
./gradlew assembleDebug
```

### Install Directly to Connected Phone
```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### Stream Live Logs
```bash
adb logcat -s CopilotService:V AudioDuckEngine:V LocationTracker:V NotificationEngine:V NotificationReceiver:V
```

---

## Key Features & In-App Controls
* **Android Auto In-Car UI:** Native car display dashboard built with Android for Cars App Library (`androidx.car.app`), featuring a live telemetry dashboard, chronological waypoints view, route switcher, and in-car settings toggles.
* **Route Selector:** Dynamically parses Day 1–4 roadtrip routes plus local test drive routes (`Albany -> Nassau` and `Nassau -> Albany`).
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
* **`car/CopilotCarAppService.kt`**: Automotive app service granting host validation.
* **`car/CopilotCarSession.kt`**: Automotive session manager starting the dashboard screen.
* **`car/CopilotDashboardScreen.kt`**: Main `PaneTemplate` car dashboard with telemetry, pace, and action buttons.
* **`car/WaypointListScreen.kt`**: `ListTemplate` displaying chronological itinerary milestones with passed vs upcoming status.
* **`car/RouteListScreen.kt`**: `ListTemplate` allowing in-car route switching without unwanted auto-start.
* **`car/SettingsScreen.kt`**: `ListTemplate` offering in-car audio toggles, volume calibration, and test triggers.
* **`CopilotService.kt`**: Foreground service tracking GNSS location, milestone pacing, notification state, and centralized route selection.
* **`LocationTracker.kt`**: Event-driven GNSS listener, sequential waypoint progression, and schedule pace guards.
* **`AudioDuckEngine.kt`**: Audio focus management, stream switching, and offline Text-to-Speech synthesis.
* **`NotificationEngine.kt`**: Android Auto `MessagingStyle` heads-up notification cards with `CarExtender`.
* **`NotificationReceiver.kt`**: Broadcast receiver handling Android Auto voice replies and dismiss actions.
* **`MainActivity.kt`**: Phone dashboard to select route, calibrate volume, and start/stop the service.
* **`model/ItineraryModels.kt`**: Data structures, target epoch parsing, and schedule pace formatting.
