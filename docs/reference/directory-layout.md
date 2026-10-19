# Repository Directory Layout

This document maintains the complete directory structure and architectural component map for **Roadtrip Co-Pilot**.

```
roadtrip-copilot/
├── .agents/                   # Antigravity harness adapter rules & customizations
│   └── rules/
│       └── antigravity-harness.md # Antigravity delegation mechanics (invoke_subagent)
├── .github/                   # GitHub Actions CI/CD workflows
│   └── workflows/
│       ├── ci.yml             # Pull request and branch verification workflow
│       └── deploy.yml         # Main branch and manual workflow_dispatch deployment
├── .opencode/                 # OpenCode harness adapter config, agent profiles & commands
│   ├── opencode.json          # Project configuration declaring harness rules
│   ├── rules/
│   │   └── harness.md         # OpenCode delegation mechanics (subagent)
│   ├── agents/                # Configured worker profiles (impl, infra, test, reviewer)
│   └── commands/              # Workflow commands (kickoff, wrapup)
├── AGENTS.md                  # Shared developer and agent handbook
├── README.md                  # Project overview and setup guide
├── itineraries/               # Workspace itineraries directory (git-ignored custom routes)
│   ├── .gitignore             # Ignores *.json while tracking sample_itinerary.json
│   └── sample_itinerary.json  # Bundled sample route (Phoenix → Sedona → Flagstaff)
├── docs/
│   ├── README.md              # Documentation directory map & architectural taxonomy
│   ├── IDEAS.md               # Feature backlog and uncommitted ideas (incubator)
│   ├── projects/              # Major multi-session initiatives (with 3-tier planning & ADRs)
│   │   ├── route-scout-cloud/ # [ACTIVE PROJECT] Production Cloud Architecture, Auth, Bedrock AI & AWS Deployment
│   │   │   ├── route_scout_cloud_architecture.md # Tier 1 Architectural Blueprint
│   │   │   ├── WORKING_MODEL.md   # Project planning model, orchestrator-worker protocol & ADR rules
│   │   │   ├── DECISIONS.md       # ADR Table of Contents & high-level decision index
│   │   │   ├── decisions/         # Standalone Architecture Decision Record (ADR) files
│   │   │   └── plan/              # Rolling-wave planning directory
│   │   │       ├── active/        # Single active Work Package (Tier 3)
│   │   │       └── archive/       # Completed and retired Work Packages
│   │   └── android-route-client/  # [QUEUED PROJECT — Phase 2, blocked by cloud] Android Route Editing & Cloud Co-Pilot
│   │       ├── android_route_editing_and_cloud_client.md # Tier 1 Architectural Blueprint
│   │       ├── WORKING_MODEL.md   # Project working model, sequencing & dependency rules
│   │       ├── DECISIONS.md       # ADR Table of Contents & high-level decision index
│   │       ├── decisions/         # Standalone Architecture Decision Record (ADR) files
│   │       └── plan/              # Rolling-wave planning directory (queued)
│   │           ├── active/        # Single active Work Package (Tier 3)
│   │           └── archive/       # Completed and retired Work Packages
│   ├── reference/             # Living platform invariants & architectural rationales
│   │   ├── android_auto_multitasking_architecture.md # Coolwalk multitasking model, slot mechanics & design rationale
│   │   └── directory-layout.md # This repository layout map
│   ├── tasks/                 # Standalone tactical spike plans & feature experiments
│   │   └── carapp_notification_experiment_implementation_plan.md # Car App Library notification experiment plan
│   └── archive/               # Completed historical research & superseded specifications
│       └── route_builder_research_and_architecture.md # Technical specification & domain architecture
├── scripts/                   # Verification, deployment & environment scripts
│   ├── ci_check.sh            # Unified CI verification (route-builder, infra CDK, Android)
│   ├── deploy_cloud.sh        # Unified cloud deployment (CDK deploy, S3 sync, CloudFront invalidation, smoke check)
│   ├── run_dhu.sh             # Desktop Head Unit runner for Android Auto testing
│   └── setup_env.sh           # Environment setup & dependency validation
├── infra/                     # AWS CDK TypeScript infrastructure-as-code
│   ├── bin/
│   │   └── infra.ts           # CDK app entrypoint & stack instantiation (selected Region)
│   ├── lib/
│   │   └── roadtrip-cloud-stack.ts # CloudFront, S3, Fastify Lambda (LWA streaming) & OIDC stack
│   ├── test/
│   │   └── roadtrip-cloud-stack.test.ts # Vitest CDK infrastructure assertions
│   ├── cdk.json               # AWS CDK execution configuration
│   ├── package.json           # CDK dependencies & scripts (build, test, synth, deploy)
│   └── tsconfig.json          # Strict TypeScript configuration
├── gradlew, gradlew.bat       # Gradle wrapper executable
├── settings.gradle.kts        # Multi-project gradle settings
├── build.gradle.kts           # Root build configuration
├── route-builder/             # Full-Stack Web Studio
│   ├── Dockerfile             # Multi-stage Docker build with AWS Lambda Web Adapter streaming
│   ├── .dockerignore          # Docker build exclusions
│   ├── AGENTS.md              # Route Builder subproject agent handbook & directory structure
│   ├── README.md              # User-facing web studio documentation & setup
│   ├── package.json           # Node scripts (dev, build, test, test:backend, test:engine, test:ai, test:schema)
│   ├── vite.config.ts         # Vite configuration with /api reverse proxy to port 3001
│   ├── server/                # Fastify TypeScript backend
│   │   ├── app.ts             # Fastify app factory with CORS, authGuard hook, and routes
│   │   ├── index.ts           # Server entrypoint (listening on 0.0.0.0:3001)
│   │   ├── hooks/             # Fastify preHandler hooks (authGuard.ts dual-mode OIDC + allowlist gate)
│   │   ├── routes/            # Fastify plugins (auth.ts, routing.ts, ai.ts, device.ts, itineraries.ts, scout.ts)
│   │   ├── services/          # Business logic (authService, routeService, geocodeService, routeCache, aiService, deviceService, itineraryStorageService, scoutService)
│   │   └── types/             # Strict TypeScript interfaces (auth, routing, ai, scout — 0 any types)
│   ├── src/                   # React frontend
│   │   ├── App.tsx            # Main application layout, auth gate & state coordinator
│   │   ├── components/        # AppHeader, AuthGateScreen, DayTabBar, RouteSelectorModal, MapCanvas, TimelineSidebar, SearchBar, EditWaypointModal, ExportModal, RouteScoutDrawer, InlineEdit
│   │   ├── engine/            # cascade.ts (math cascade), googleMapsUrl.ts (chunking), export.ts (V2 JSON), itineraryParser.ts (multi-day import)
│   │   ├── services/          # api.ts (HTTP client), aiQueue.ts (concurrency queue)
│   │   └── types/             # Frontend data models (auth, routing, ai, scout)
│   └── tests/                 # Vitest suites: backend, engine, AI, schema/device, and React scheduling workflows (ui/)
└── app/
    ├── build.gradle.kts       # App module dependencies & SDK config
    └── src/
        ├── test/              # JUnit & Robolectric unit tests (RouteRepositoryTest, RouteListScreenTest, ItineraryTest, WaypointRowModelTest)
        └── main/
            ├── AndroidManifest.xml
            ├── res/
            │   ├── layout/    # Dashboard (activity_main.xml, incl. collapsible read-only Itinerary card), route library bottom sheet (bottom_sheet_routes.xml, item_route_manage.xml), itinerary stop row (item_waypoint_row.xml)
            │   ├── drawable/  # Vector assets
            │   └── xml/
            │       └── automotive_app_desc.xml
            └── java/com/roadtrip/copilot/
                ├── MainActivity.kt        # Phone dashboard, active route card, read-only itinerary progress list, route library sheet, SAF import & volume calibration
                ├── CopilotService.kt      # Foreground service lifecycle, dynamic route loading & pace telemetry
                ├── LocationTracker.kt     # Event-driven GPS, sequential progression & pace resolution
                ├── AudioDuckEngine.kt     # Audio focus, stream routing & TTS manager
                ├── NotificationEngine.kt  # Android Auto MessagingStyle heads-up cards
                ├── NotificationReceiver.kt# Broadcast receiver for AA voice reply & dismiss
                ├── car/                   # Android Auto In-Car UI (Android for Cars App Library)
                │   ├── CopilotCarAppService.kt   # Automotive app service & host validator
                │   ├── CopilotCarSession.kt      # Automotive session manager
                │   ├── CopilotDashboardScreen.kt # PaneTemplate car dashboard with live telemetry
                │   ├── WaypointListScreen.kt     # ListTemplate for chronological milestones
                │   ├── RouteListScreen.kt        # Dynamic ListTemplate with 6-item pagination & distraction compliance
                │   └── SettingsScreen.kt         # ListTemplate for audio ducking toggles & calibration
                └── model/
                    ├── RouteRepository.kt # Singleton scanning storage & dynamic ingestion, StateFlow<List<RouteOption>>
                    ├── RouteOption.kt     # Unified route metadata class
                    ├── WaypointRowModel.kt# Pure presentation mapper for the phone itinerary list (passed/next/upcoming, arrive/stay/depart text)
                    ├── AssetProvider.kt   # Interface abstraction for pure JVM unit testing
                    └── ItineraryModels.kt # Itinerary data classes (V1 & V2 schemas), pace resolution
```
