# ADR-0003: Phone-Screen-Only Route Editing & Scout UX to Enforce Android Auto Distraction Compliance

* **Date:** 2026-10-17
* **Status:** Accepted
* **Deciders:** Eric, Antigravity
* **Related Work Package:** N/A (Foundational Blueprint)

---

## 1. Context & Problem Statement
Android Auto strictly enforces driver distraction guidelines. Under Google's Car App Library guidelines and **Rule 6 of AGENTS.md**, screens displayed on the vehicle head unit must limit cognitive load: lists cannot exceed 6 items without pagination, complex text inputs or multi-turn conversational chat are prohibited while driving, and deep interactive canvases are rejected.

At the same time, drivers and passengers need rich interactive capabilities: deleting stops, adjusting dwell times, reading Route Scout recommendations, and applying suggestion cards.

## 2. Decision Drivers
* Strict adherence to Google Android for Cars App Library distraction constraints and app store review policies.
* Driver safety on the road: No conversational chat or complex route editing on the vehicle dashboard.
* Optimal ergonomics: Complex touch manipulation is far easier on a smartphone screen during rest stops or in the passenger seat.

## 3. Considered Options
* **Option A: Attempt Car App Library Conversational Screen:** Build custom templates on the car display for Route Scout chat and waypoint editing. (Rejected: Violates Car App Library template constraints, risks Google Play rejection, and creates extreme driver distraction hazards).
* **Option B: Phone-Screen-Only Interactive Editing with Passive Car Reflection:**
  * All active route editing (Skip Stop, Delete Stop, Dwell adjust) and Route Scout conversational chat live exclusively on the **phone screen (`MainActivity.kt`)** via bottom sheets and row gestures.
  * The in-car Android Auto screens (`CopilotDashboardScreen`, `WaypointListScreen`, `RouteListScreen`) remain lightweight, read-only, distraction-compliant views.
  * Edits made on the phone hot-reload `CopilotService` in-place, instantly updating the vehicle's dashboard telemetry and waypoint list without driver intervention.

## 4. Decision Outcome
Chosen Option: **Option B (Phone-Screen-Only Interactive Editing)**.

Route Scout chat is housed in `RouteScoutBottomSheet.kt` on the phone. Route modifications occur via phone UI gestures on `item_waypoint_row.xml`. The car display automatically reflects changes via `CopilotService.telemetryFlow`.

### Positive Consequences
* 100% compliant with Google Car App Library and vehicle safety guidelines.
* Unconstrained UI fidelity on the phone: rich markdown, suggestion cards, quick prompt chips, and bottom sheets.
* Seamless synchronization: In-car display updates passively via existing StateFlow architecture.

### Negative Consequences / Trade-offs
* Route modifications and Route Scout queries cannot be executed directly via the car screen controls while driving (must be performed by a passenger or while safely stopped).

## 5. Implementation Notes & Code Touchpoints
* Blueprint: [android_route_editing_and_cloud_client.md](../android_route_editing_and_cloud_client.md#d-distraction--safety-compliance-phone-ui-only)
* Phone UI files: `MainActivity.kt`, `item_waypoint_row.xml`, `RouteScoutBottomSheet.kt`
* Car screens (read-only): `CopilotDashboardScreen.kt`, `WaypointListScreen.kt`
