# Feature Ideas & Roadmap Backlog

This document captures architectural concepts, feature proposals, and community ideas for **Roadtrip Co-Pilot**.

---

## 1. Multi-Provider AI Harnesses (Pluggable Adapters)

### Context & Goal
Currently, the Route Builder AI engine uses Google Gemini:
* **Primary (Local Zero-Config):** Antigravity CLI (`agy`), automatically resolving and invoking the active/latest Gemini Flash model (`gemini-3.8-flash-high`) via `AgyHarnessAdapter`.
* **Cloud Fallback:** Google AI Studio REST API (`gemini-3.8-flash`) via `GeminiStudioHarnessAdapter`.
* **Offline Fallback:** Deterministic template generator via `TemplateHarnessAdapter`.

The server architecture is built around the `AiHarnessAdapter` interface (`route-builder/server/services/aiService.ts`), allowing new providers to be registered cleanly. We want to support additional LLM harnesses so users can generate co-pilot announcements using whatever AI tools or keys they prefer.

### Proposed Harness Adapters
* **Anthropic Claude Adapter (`AnthropicHarnessAdapter`):**
  * Support for Claude Sonnet (e.g. Claude 3.7 / Claude 4.6) via `@anthropic-ai/sdk` or raw HTTP.
  * Configurable via `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`.
* **OpenAI Adapter (`OpenAiHarnessAdapter`):**
  * Support for OpenAI GPT models (GPT-4o, GPT-4o-mini) using official OpenAI endpoints.
  * Configurable via `OPENAI_API_KEY` and `OPENAI_MODEL`.
* **Local Offline LLMs (`OllamaHarnessAdapter`):**
  * Connect to local Ollama instances (`http://localhost:11434/api/generate`) or `llama.cpp` server for 100% offline, private route copywriting without internet access.
  * Supported models: Llama 3, Mistral, Gemma.
* **OpenAI-Compatible Custom Endpoints:**
  * Base URL + API key interface allowing self-hosted models (vLLM, LocalAI, OpenRouter, Groq).

### Production Cloud Architecture & Tool Calling
* For a comprehensive blueprint of how Route Scout transitions from local CLI execution (`agy`) to production cloud APIs with native tool calling (OSRM snapping, Google Places, Google Search Grounding, and structured JSON schemas), see [Route Scout Cloud Architecture](projects/route-scout-cloud/route_scout_cloud_architecture.md).

---

## 2. Voice & Audio Narration

* **Custom High-Fidelity Voice Synthesis (ElevenLabs):**
  * Option in the Route Builder to pre-render voice scripts using ElevenLabs or Google Cloud TTS neural voices into compressed `.mp3` or `.ogg` audio clips bundled with the itinerary export.
  * The Android app would then play pre-rendered audio clips directly rather than relying on on-device TTS.
* **Audio Cues & Earcons:**
  * Play a subtle 1-second chime or radio squelch before the co-pilot speaks to grab the driver's attention before ducking music.
* **Driver Voice Profiles:**
  * Different narrative tones: "Tour Guide" (historical facts & geology), "Concise Navigator" (safety & turns only), "Adventure Storyteller" (lore & trivia).

---

## 3. Cartography & Route Planning

* **GPX / KML Track Import & Export:**
  * Allow importing existing `.gpx` tracks from AllTrails, Gaia GPS, OnX Offroad, or Garmin.
  * Export itinerary waypoints and polylines as `.gpx` for handheld GPS devices.
* **Elevation Profiles & Mountain Pass Telemetry:**
  * Display elevation gradient charts along the drive timeline.
  * Trigger warnings for steep descents, switchbacks, or high-altitude passes.
* **Live Weather & Road Condition Overlays:**
  * Fetch NOAA weather radar and alert data along the planned route.
  * Warn the driver of imminent precipitation, snow on high passes, or high wind warnings for scenic pull-offs.
* **EV Charging & Fuel Stop Optimizer:**
  * Integrate with Open Charge Map or NREL data to automatically suggest charging/fuel stops within comfortable vehicle range.

---

## 4. Android Auto & In-Car Enhancements

* **Mobile Route Editing:**
  * Allow adding, editing, or reordering waypoints directly in the phone UI without requiring a desktop browser.
* **OBD-II Bluetooth Integration:**
  * Read vehicle speed, fuel level, and compass heading directly from an OBD-II dongle to refine ahead/behind pace calculations and dead-reckoning in tunnels or canyons.
* **Full Map Surface (MapTemplate):**
  * If Google expands Android Auto permissions for general navigation in the Car App Library, render an interactive turn map alongside co-pilot alerts.
