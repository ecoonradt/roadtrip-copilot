# Android Auto Multitasking & Dashboard Architecture

> [!NOTE]
> **STATUS: LIVING REFERENCE ARCHITECTURE — Platform Constraints & Windowing Model**  
> This document is the authoritative engineering reference explaining Android Auto's windowing pipeline, the dual-slot Navigation vs. Media model, and why Roadtrip Co-Pilot is architected as an unobtrusive background service rather than a split-screen dashboard tile.

This document explains the technical windowing model of Android Auto (the "Coolwalk" split-screen dashboard), analyzes how first-party and third-party apps interact with screen slots, and details why Roadtrip Co-Pilot is architected as an unobtrusive background service rather than a split-screen dashboard tile.

---

## 1. The Architectural Dilemma

When designing Roadtrip Co-Pilot, an obvious design proposal was:
> *Google Maps occupies the large left pane for driving directions. Why not place Roadtrip Co-Pilot in the smaller right-hand pane to continuously display upcoming waypoints, target arrival times, and pace telemetry?*

Because third-party apps like Spotify, MLB, and Waze frequently appear in the smaller side pane, it is natural to assume that any third-party app can target that space. However, Android Auto's windowing pipeline is strictly role-governed and does not support arbitrary side-by-side app placement.

```
+--------------------------------------------------------------------------------+
|                             WHAT USERS ENVISION                                |
+--------------------------------------------------------------------------------+
|  [ PRIMARY PANE (~60-70%) ]             |  [ SECONDARY PANE (~30-40%) ]        |
|                                         |                                      |
|  Google Maps Navigation                 |  Roadtrip Co-Pilot Companion Tile    |
|  • Live turn-by-turn road map           |  • Next: Sedona Canyon Overlook      |
|  • Traffic & lane guidance              |  • Target: 11:45 AM (Ahead +4 min)   |
|  • Hazard rerouting                     |  • GPS Speed: 62 mph                 |
+--------------------------------------------------------------------------------+
           ❌ Structurally impossible under Android Auto's windowing rules
```

---

## 2. The Coolwalk Slot Model: Two Fixed Roles

Android Auto does not implement a freeform or multi-window manager like Android tablets, Samsung DeX, or desktop operating systems. The dashboard provides **exactly two functional application slots**:

1. **The Navigation Role:** Dedicated strictly to guided turn-by-turn routing.
2. **The Media Role:** Dedicated strictly to audio playback controls and metadata.

```
+--------------------------------------------------------------------------------+
|                     ANDROID AUTO DUAL-SLOT ARCHITECTURE                        |
+--------------------------------------------------------------------------------+
|  [ NAVIGATION ROLE SLOT ]               |  [ MEDIA ROLE SLOT ]                 |
|                                         |                                      |
|  Declared with:                         |  Declared with:                      |
|  androidx.car.app.category.NAVIGATION   |  androidx.media (MediaBrowserService)|
|                                         |                                      |
|  Examples:                              |  Examples:                           |
|  • Google Maps                          |  • Spotify                           |
|  • Waze                                 |  • YouTube Music                     |
|  • TomTom AmiGO                         |  • MLB (Live Game Audio)             |
+--------------------------------------------------------------------------------+
```

Android Auto dynamically pairs **one active Navigation app** with **one active Media app**. No two apps of the same category—and no apps outside these two categories—can be paired together.

---

## 3. Demystifying Real-World Dashboard Behaviors

Drivers frequently see third-party apps rendered in different positions on the car screen. Each configuration is governed by specific platform mechanics:

### A. Media Controls in the Right Pane (Standard Default View)
* **What you see:** Google Maps on the left; Spotify or MLB on the right.
* **How it works:** Google Maps occupies the Navigation slot. The right pane is **not** running a third-party app window; it is a **system widget** managed by Android Auto's host (`gearhead`). The widget binds via IPC to the active Android `MediaSessionCompat` (published by Spotify or MLB) and renders playback controls and album artwork.

### B. Navigation in the Right Pane (The "Media in Focus" Mode)
* **What you see:** Spotify running its full browsing/queue interface on the left; Waze or Google Maps rendering a live 3D map with vehicle chevron and speedometer on the right.
* **How it works:** When the driver taps Spotify in the dock to browse playlists or queues, Android Auto expands the Media app into the primary pane. The host then automatically scales the active Navigation app's OpenGL/Vulkan rendering surface (`SurfaceCallback`) into the secondary pane. Waze does not request this placement; Android Auto automatically routes the active Navigation provider's surface to whichever pane remains available.

### C. Flipped Layouts ("Media Closer to Driver" / Right-Hand Drive)
* **What you see:** Media on the left, Google Maps on the right.
* **How it works:** In Android Auto settings under *Change Layout*, drivers can flip the dashboard layout based on steering wheel position. This mirrors the slot positions on screen, but the roles remain unchanged: the Navigation app occupies the primary surface and the Media app occupies the secondary slot.

---

## 4. Why Roadtrip Co-Pilot Cannot Sit Beside Google Maps

To understand why Roadtrip Co-Pilot cannot be placed in the secondary pane alongside Google Maps, consider the three paths available under the Android for Cars App Library (`androidx.car.app`):

### Path 1: As a Point of Interest (`POI`) App (Current Architecture)
* Roadtrip Co-Pilot's in-car dashboard (`CopilotDashboardScreen.kt`) is registered under `androidx.car.app.category.POI`.
* **Platform Barrier:** Android Auto does not permit POI apps to participate in the split-screen dashboard pairing. Launching a POI app from the car launcher displaces the split dashboard entirely, taking over the primary viewport and pushing Google Maps off the screen.

### Path 2: As a Navigation (`NAVIGATION`) App
* If Roadtrip Co-Pilot were re-engineered as a full turn-by-turn navigation app (`androidx.car.app.category.NAVIGATION`) with a custom map rendering pipeline (`SurfaceCallback`):
* **Platform Barrier (The Single-Navigation Provider Rule):** Android Auto strictly enforces that **only one navigation provider may be active at any time**. If Roadtrip Co-Pilot registers as a navigation app and starts its session, Android Auto immediately terminates Google Maps. You cannot pair two navigation providers side-by-side.

### Path 3: As a Media (`MEDIA`) App
* If Roadtrip Co-Pilot registered a dummy `MediaBrowserService` to display waypoint information as "Song Titles" and timing deltas as "Artist Names":
* **Platform Barrier:** Android allows only **one active `MediaSession`** across the entire OS. Roadtrip Co-Pilot would steal audio session ownership from Spotify or MLB, silencing the driver's music. The moment the driver pressed play on their music, Spotify would reclaim the media widget and kick Co-Pilot off the screen. Masquerading as a media player also violates Google Play Developer Policies.

---

## 5. The Solution: The Unobtrusive Background Co-Pilot

Because Android Auto reserves its two visual slots for Navigation (Google Maps) and Media (Music/Podcasts), Roadtrip Co-Pilot solves the multi-stop road trip problem by running as a native Android **Foreground Service** that requires zero persistent screen real estate:

```
+--------------------------------------------------------------------------------+
|                        ROADTRIP CO-PILOT ARCHITECTURE                          |
+--------------------------------------------------------------------------------+
|  [ GOOGLE MAPS ON SCREEN ]              |  [ SPOTIFY / MEDIA ON SCREEN ]       |
|  Full-time turn-by-turn directions      |  Full-time music & podcast playback  |
|                                         |                                      |
|  ============================================================================  |
|  [ BACKGROUND FOREGROUND SERVICE (CopilotService.kt) ]                         |
|  • Monitors GNSS satellite coordinates against local JSON itinerary            |
|  • Calculates pace telemetry (ahead/behind schedule relative to planned stops) |
|                                                                                |
|  [ HIGH-PRIORITY HEADS-UP OVERLAYS (NotificationEngine.kt) ]                   |
|  • Proximity triggers drop a 5-7 second MessagingStyle notification card       |
|    directly over Google Maps with voice-reply "Acknowledge" & "Dismiss"        |
|                                                                                |
|  [ AUDIO PAUSE / DUCKING & TTS (AudioDuckEngine.kt) ]                         |
|  • Requests transient audio focus (AUDIOFOCUS_GAIN_TRANSIENT default)         |
|  • Cleanly pauses active media, speaks scenic/itinerary script, and resumes    |
|    music cleanly upon speech completion (or subtle ducking if toggled)        |
+--------------------------------------------------------------------------------+
```

### On-Demand In-Car Dashboard (`CopilotCarAppService.kt`)
For times when the vehicle is parked or stopped at an overlook, Roadtrip Co-Pilot still provides a full in-car interface via `androidx.car.app`:
* [`CopilotDashboardScreen.kt`](../../app/src/main/java/com/roadtrip/copilot/car/CopilotDashboardScreen.kt): Displays next waypoint, distance, target time, pace delta, and GPS speed.
* [`WaypointListScreen.kt`](../../app/src/main/java/com/roadtrip/copilot/car/WaypointListScreen.kt): Full chronological milestone list.
* [`RouteListScreen.kt`](../../app/src/main/java/com/roadtrip/copilot/car/RouteListScreen.kt): Distraction-compliant 6-item paginated route switcher.
* [`SettingsScreen.kt`](../../app/src/main/java/com/roadtrip/copilot/car/SettingsScreen.kt): Audio ducking and speech calibration controls.

When the driver resumes driving and returns to Google Maps, Roadtrip Co-Pilot cleanly returns to the background, ensuring the driver never has to choose between their driving map, their music, and their itinerary co-pilot.

---

## 6. Audio Architecture Decision: Why Media Pauses Instead of Ducks

Early iterations of Roadtrip Co-Pilot attempted to use Android's transient audio ducking (`AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`) to dip music volume during announcements. In real-world car testing, media volume was not noticeably attenuated. This was investigated and confirmed to be an OS and automotive projection limitation:

1. **AOSP Ducking Curve Limits:** In Android's audio system (`PlaybackActivityMonitor.java`), navigation ducking applies `DUCK_VSHAPE` ($-14\text{ dB}$, leaving $20\%$ signal amplitude). Due to logarithmic human hearing and automotive road noise, $-14\text{ dB}$ sounds like only a mild dip ($\approx 50\%$ perceived volume). The deeper $-35\text{ dB}$ strong duck is hardcoded in AOSP exclusively for `USAGE_ASSISTANT` (which cannot be used because it triggers in-car Siri/Google Assistant overlays, chimes, and mic capture).
2. **Dual-Channel Automotive Projection:** Android Auto transmits Media and Navigation as separate digital audio channels to the vehicle. The car's head unit DSP amplifier mixes them together without attenuating Media further unless configured in vehicle firmware.
3. **Background Audio Hardening:** Android 17+ (API 37+) introduces Background Audio Hardening, which silently rejects background ducking requests from services without active UI interaction.

**The Solution:** Roadtrip Co-Pilot defaults to `AUDIOFOCUS_GAIN_TRANSIENT` ("Pause music during alerts"). The system dispatches `AUDIOFOCUS_LOSS_TRANSIENT` to the active media player (Spotify, YouTube Music, podcasts), cleanly pausing playback for the duration of the alert and resuming playback instantly when TTS completes (`onDone`).
 
**Architectural Invariant:** Do not revert default focus gain to `MAY_DUCK` or attempt volume slider hacks (`setStreamVolume`) to bypass audio focus mechanics. Volume modification disrupts driver audio control and fails under background execution restrictions.

