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

## Phone Preparation (Crucial for Offline Use)
In remote parts of Arizona and New Mexico, cellular service will drop. Complete this one-time step on your phone:

### Download Offline English TTS Voice Pack
1. Open phone **Settings $\to$ Accessibility** (or **System**) $\to$ **Text-to-speech output**.
2. Tap the **gear icon** next to **Preferred engine** (Speech Services by Google).
3. Tap **Install voice data $\to$ English (United States)**.
4. Download a voice pack so your phone can speak without internet.

---

## Building and Installing

### Build Debug APK
```bash
./gradlew assembleDebug
```

### Install Directly to Your Phone
```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### Stream Live Logs
```bash
adb logcat -s CopilotService:V AudioDuckEngine:V LocationTracker:V NotificationEngine:V
```

---

## Architecture & Code Structure
* **`app/src/main/assets/itinerary.json`**: Complete waypoint schedule, GPS coordinates, trigger radiuses, and speech announcements.
* **`app/src/main/assets/test_itinerary.json`**: 19-mile local test drive route (Empire State Plaza to Nassau, NY).
* **`CopilotService.kt`**: Unkillable `ForegroundService` with `location` foreground service type.
* **`LocationTracker.kt`**: Event-driven GNSS listener and Haversine distance calculator.
* **`AudioDuckEngine.kt`**: Transient audio focus management (`AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`) and offline Text-to-Speech.
* **`NotificationEngine.kt`**: High-priority notifications with `NotificationCompat.CarExtender` for Android Auto.
* **`MainActivity.kt`**: Simple single-tap dashboard to select route and toggle the Co-Pilot service.
