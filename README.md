# Road Trip Co-Pilot for Android Auto

A smart, context-aware road trip assistant designed to run alongside Google Maps in Android Auto.

## Trip Overview: Phoenix (PHX) to Albuquerque (ABQ)
- **Dates:** Friday, October 9 – Monday, October 12
- **Route:** Phoenix $\to$ Sedona $\to$ Oak Creek Canyon $\to$ Flagstaff $\to$ Shiprock $\to$ Chama $\to$ Brazos Pass $\to$ Taos $\to$ High Road $\to$ Santa Fe $\to$ Albuquerque

---

## Why Option 1: The "Heads-Up & Spoken Audio" Co-Pilot?
Android Auto has strict dashboard limits (navigation + media player occupy the main split-screen). By running as a background service on your phone that posts high-priority notifications and voice prompts:
1. **Zero Screen Conflict:** You keep full Google Maps turn-by-turn navigation on screen at all times.
2. **Heads-Up Alerts:** Android Auto displays notifications as top banners over Google Maps with custom notes (e.g., *"Approaching Shiprock Peak on your left in 3 miles"*).
3. **Voice Prompts:** The co-pilot can use Android Text-to-Speech (TTS) to duck your music and speak upcoming scenic highlights, photo pull-offs, and dining details.
4. **Pace & Timeline Tracking:** Compares current GPS time vs. target arrival times (e.g., *"You are 14 minutes ahead of schedule for Taos"*).

---

## Project Structure
```
~/code/roadtrip-copilot/
├── itinerary.json      # Complete parsed itinerary with lat/lng, schedule, & alerts
├── copilot_engine.py   # Core logic: Haversine distance, trigger radius, timeline delta
└── README.md           # Documentation and setup instructions
```

---

## Quick Start / Testing Locally

Test the engine right in your terminal:
```bash
python3 copilot_engine.py
```

This runs a simulated drive approaching Sedona, demonstrating how proximity triggers and schedule deltas are computed.

---

## Deployment Options to Android

### Option A: Termux + Termux:API (Easiest & Most Direct)
If you install [Termux](https://f-droid.org/en/packages/com.termux/) and Termux:API from F-Droid on your Android phone:
1. Copy `itinerary.json` and `copilot_engine.py` to your phone.
2. Termux provides CLI access to Android device capabilities:
   - `termux-location`: Gets current phone GPS coordinates.
   - `termux-notification`: Directly posts heads-up banners to Android Auto.
   - `termux-tts-speak`: Speaks announcements through car speakers over Bluetooth/USB.
3. A simple Python loop can poll every 30–60 seconds while driving.

### Option B: Tasker or MacroDroid
Import `itinerary.json` into Tasker:
- Set up location geofences corresponding to the waypoints.
- Tasker native actions:
  - **Notify:** Set Priority = Max (displays banner in Android Auto).
  - **Say:** Uses Android TTS over the Media / Car audio channel.

---

## Resuming This Conversation

To resume this AI assistant pair-programming session inside this directory:
```bash
cd ~/code/roadtrip-copilot
agy --conversation ed4c4f80-5235-4d91-bc71-12b47fe93f92 --add-dir .
```
*(Or simply `agy -c --add-dir .` if this was your most recent session).*
