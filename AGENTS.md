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

### B. Audio Ducking & In-Car Routing
* When approaching a waypoint, the app must **duck** whatever is playing (Spotify, podcasts) rather than talking over it or silencing it permanently.
* Uses Android's `AudioManager` with `AudioFocusRequest`:
  * Focus Gain: `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`
  * Audio Usage: `AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE`
  * Content Type: `AudioAttributes.CONTENT_TYPE_SPEECH`
* Routing speech through `USAGE_ASSISTANCE_NAVIGATION_GUIDANCE` ensures Android Auto routes voice through the car's navigation audio channel, controllable by the steering wheel's navigation volume.
* Focus must be abandoned immediately upon speech completion (`TextToSpeech.OnUtteranceProgressListener.onDone`) so music smoothly returns to 100% volume.

### C. Android Auto Heads-Up Notifications
* Approaching waypoints triggers an immediate high-priority notification.
* Uses `NotificationCompat.Builder` with:
  * Channel: `IMPORTANCE_HIGH`
  * Category: `NotificationCompat.CATEGORY_NAVIGATION`
  * Extender: `NotificationCompat.CarExtender()`
* This ensures the banner drops down over Google Maps on the car's screen for 5–7 seconds, then tucks away into Android Auto's notification center.

### D. 100% Offline Resilience (Zero Cellular Dependency)
* Much of the route (Oak Creek Canyon, Navajo Nation, Chama, Brazos Pass) has **zero cellular connectivity**.
* **GPS:** Hardware GNSS satellite radio receives lat/long directly from orbit. No network calls.
* **Proximity Math:** Local Haversine formula executed on-device.
* **Data Source:** Waypoints, triggers, and announcement scripts are baked into `app/src/main/assets/itinerary.json`.
* **TTS Engine:** Uses Android's built-in `TextToSpeech` engine configured with local/offline English voice packs.

---

## 3. Directory Layout
```
roadtrip-copilot/
├── AGENTS.md                  # This file
├── README.md                  # Human-facing setup & usage guide
├── itinerary.json             # Core 4-day itinerary (PHX -> ABQ)
├── test_itinerary.json        # Upstate NY 19-mile local test drive route
├── legacy/                    # Archived prototypes (copilot_engine.py)
├── gradlew, gradlew.bat       # Gradle wrapper executable
├── settings.gradle.kts        # Multi-project gradle settings
├── build.gradle.kts           # Root build configuration
└── app/
    ├── build.gradle.kts       # App module dependencies & SDK config
    └── src/
        └── main/
            ├── AndroidManifest.xml
            ├── assets/
            │   ├── itinerary.json
            │   └── test_itinerary.json
            ├── res/
            └── java/com/roadtrip/copilot/
                ├── MainActivity.kt        # Minimal start/stop dashboard & route picker
                ├── CopilotService.kt      # Foreground service lifecycle
                ├── LocationTracker.kt     # Event-driven GPS & Haversine proximity
                ├── AudioDuckEngine.kt     # Audio focus & Text-to-Speech manager
                ├── NotificationEngine.kt  # Android Auto heads-up cards
                └── model/
                    ├── Itinerary.kt
                    └── Waypoint.kt
```

---

## 4. Environment & Build Commands

### Prerequisites
* **Java:** OpenJDK 17 (`java -version`, `javac -version`).
* **Android SDK:** Installed at `$HOME/Android/Sdk` (API 34/35 platform and build-tools).
* **ADB:** Available at `/usr/bin/adb`.

### Common Commands
* **Build Debug APK:**
  ```bash
  ./gradlew assembleDebug
  ```
* **Install to Connected Phone (Pixel 7 Pro):**
  ```bash
  adb install -r app/build/outputs/apk/debug/app-debug.apk
  ```
* **Stream Live Logs from Phone:**
  ```bash
  adb logcat -s CopilotService:V AudioDuckEngine:V LocationTracker:V NotificationEngine:V
  ```
* **Simulate Location Mock via ADB (for testing without driving):**
  ```bash
  adb emu geo fix -73.75620 42.65260
  ```

---

## 5. Rules for Contributing Agents
1. **Never add cloud API dependencies:** Do not introduce Retrofit, Firebase, Google Maps API keys, or web-based geocoding into the runtime drive loop. Everything must run offline.
2. **Strict Battery & Threading Discipline:** Use Kotlin Coroutines (`Dispatchers.Default` for math/JSON parsing, `Dispatchers.Main` for UI/notifications). Never poll in blocking while-loops; rely on `LocationListener` push callbacks.
3. **Preserve Waypoint Data:** The coordinate values, time offsets, and trigger radiuses in `itinerary.json` are carefully vetted for the actual driving route. Do not alter them without explicit instruction.
4. **Idiomatic Kotlin:** Use concise, null-safe Kotlin with data classes and single-responsibility components.
