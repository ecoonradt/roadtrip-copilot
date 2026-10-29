# Feature Ideas & Roadmap Backlog

This document captures architectural concepts, feature proposals, and community ideas for **Roadtrip Co-Pilot**.

---

## 1. Engineering Infrastructure & Monorepo CI/CD

### Monorepo Path-Filtered CI/CD Pipelines (Android vs. Web Studio & Cloud)
* **Context & Problem:** The repository functions as a full-system monorepo containing both the native Android Auto background service (`app/`) and the full-stack Web Studio + AWS cloud infrastructure (`route-builder/`, `infra/`). Currently, CI runs all checks together, and Android unit tests on headless GitHub runners require an Android SDK that is not pre-installed on basic runner images.
* **Objective:** Decouple CI verification so each subsystem runs its test suite only when PRs or commits touch relevant paths:
  * **Web Studio & Cloud Infrastructure Job:**
    * Trigger paths: `route-builder/**`, `infra/**`, `scripts/ci_check.sh`, `scripts/deploy_cloud.sh`.
    * Steps: Node 20 setup, `npm test` across Fastify and React, `npm run build`, CDK unit assertions (`vitest run`), and `cdk synth`.
  * **Android Native Co-Pilot Job:**
    * Trigger paths: `app/**`, `gradle/**`, `build.gradle.kts`, `settings.gradle.kts`.
    * Steps: JDK 17 setup, Android SDK setup (e.g. `android-actions/setup-android@v3` with command-line tools and platform API 34), Gradle dependency caching, and `./gradlew testDebugUnitTest`.
  * **Unified Local Verification (`scripts/ci_check.sh`):**
    * Retain the existing local script with `--skip-android` and `--skip-web` flags so developers working exclusively on one subsystem can run end-to-end verification without needing the other toolchain installed locally.
* **Roadmap Alignment:** Implement as part of Phase 2 preparation or when kicking off [`projects/android-route-client`](projects/android-route-client/WORKING_MODEL.md).

---

## 2. Vehicle & In-Car Telemetry (Low Priority Backlog)

### OBD-II Bluetooth Integration
* **Concept:** Read real-time vehicle speed, fuel level, and compass heading directly from a standard Bluetooth OBD-II dongle (ELM327 protocol).
* **Benefits:** Refines ahead/behind schedule pace telemetry and enables dead-reckoning during GPS dropouts in highway tunnels or deep mountain canyons.
* **Status:** Exploratory / Low Priority.

---

## 3. Cartography & Route Planning (Low Priority Backlog)

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
