# AGENTS.md — Roadtrip Co-Pilot Developer & Agent Handbook

## 1. Project Purpose & Architecture Context
* **Mission:** An open-source native Android background co-pilot designed to run alongside Google Maps in Android Auto during multi-stop road trips.
* **The Problem:** Android Auto's split-screen dashboard only permits two active tiles (typically Google Maps on the left, Media/Spotify on the right). A custom third-party Car App screen would displace music or navigation.
* **The Solution:** A lightweight native Android **Foreground Service** that runs in the background. It monitors GPS location against local waypoint coordinates, posts high-priority heads-up cards over Google Maps, and ducks car audio to speak upcoming scenic and itinerary details.

---

## 2. Core Architectural Pillars

* **A. Background Service Lifecycle:** Runs as an Android Foreground Service (`location` type) with fine/coarse GPS and notification permissions to guarantee continuous background execution alongside Google Maps and media apps.
* **B. Audio Focus & Transient Pausing:** Requests `AUDIOFOCUS_GAIN_TRANSIENT` on the `USAGE_ASSISTANCE_NAVIGATION_GUIDANCE` channel to cleanly pause music (Spotify, YouTube Music) during spoken waypoint alerts, resuming audio immediately on speech completion. Avoids hardcoded inaudible DSP ducking.
* **C. Android Auto Heads-Up Notifications:** Dispatches high-priority `NotificationCompat.MessagingStyle` heads-up cards over Google Maps using a stable notification ID (`2000`) and conversation identity (`setShortcutId("copilot_alerts")`). Alerts auto-dismiss via speech completion grace period, car session open, or driver action. (See [`docs/reference/android_auto_multitasking_architecture.md`](docs/reference/android_auto_multitasking_architecture.md)).
* **D. Pace & Schedule Telemetry Engine:** Calculates dynamic ahead/behind schedule deltas relative to planned waypoint milestones, supporting both fixed ISO-dated itineraries and relative ad-hoc routes. Locks in-transit telemetry to confirmed milestones to eliminate parked departure errors.
* **E. 100% Offline Resilience:** Operates with zero network dependency during drives. GPS satellite reception, local Haversine proximity calculations, on-device JSON itineraries, and local offline TextToSpeech run completely offline.
* **F. Route Builder Web Studio (`route-builder/`):** Full-stack authoring studio (Fastify backend on `:3001`, React frontend on `:5173`). Features OSRM routing proxies, timeline schedule cascading, multi-stop Google Maps chunking, AI alert generation, Route Scout co-pilot powered by Amazon Bedrock `Converse`/`ConverseStream` with configurable multi-vendor model selection (`us.moonshotai.kimi-k3` & `us.amazon.nova-2-lite-v1:0` defaults) and a 7-tool discovery & deterministic domain grounding library (`scoutTools.ts`), stateless dual-mode Google OIDC authentication (`HTTP-Only` web cookies + Android Bearer JWTs with `ALLOWED_EMAILS` allowlist gating and local dev bypass), and atomic Amazon S3 / local filesystem itinerary persistence with ETag concurrency safety. Governed by [`route-builder/AGENTS.md`](route-builder/AGENTS.md).

---

## 3. Directory Layout
The full repository directory layout and component map is maintained in [`docs/reference/directory-layout.md`](docs/reference/directory-layout.md).
Subproject directory details are maintained locally in their respective handbooks (e.g. [`route-builder/AGENTS.md`](route-builder/AGENTS.md)).

---

## 4. Environment & Build Commands

### Prerequisites
* **Java:** OpenJDK 17 (`java -version`, `javac -version`).
* **Android SDK:** Installed at `$ANDROID_HOME` or OS default (Linux: `$HOME/Android/Sdk`, macOS: `~/Library/Android/sdk`, Windows: `%LOCALAPPDATA%\Android\Sdk`).
* **ADB:** Available in system PATH (`adb devices`).
* **Node.js & npm:** Node v18+ (Node 20+ LTS recommended) and npm v9+.
* **AWS CLI / Credentials:** Configured AWS credentials with Amazon Bedrock access in `us-east-2` (production uses the Lambda execution role; local development uses the ambient AWS credential chain).

### Android Native Commands
* **Build Debug APK:**
  ```bash
  ./gradlew assembleDebug
  ```
* **Run Android Unit & Robolectric Tests:**
  ```bash
  ./gradlew testDebugUnitTest
  ```
* **Install to Connected Android Phone:**
  ```bash
  adb install -r app/build/outputs/apk/debug/app-debug.apk
  ```
* **Stream Live Logs from Connected Phone:**
  ```bash
  adb logcat -s CopilotService:V AudioDuckEngine:V LocationTracker:V NotificationEngine:V RouteRepository:V
  ```
* **Simulate Location Mock via ADB:**
  ```bash
  adb emu geo fix -73.7562 42.6526
  ```

### Route Builder Web Studio Commands
* **Install Dependencies:**
  ```bash
  cd route-builder && npm install
  ```
* **Start Dev Server (Both Frontend :5173 and Backend :3001):**
  ```bash
  cd route-builder && npm run dev
  ```
* **Compile TypeScript & Production Build:**
  ```bash
  cd route-builder && npm run build
  ```
* **Run All Vitest Tests:**
  ```bash
  cd route-builder && npm test
  ```
* **Run Browser Header & Account Acceptance Tests:**
  ```bash
  cd route-builder && npm run test:browser
  ```
  Requires one-time `npx playwright install chromium`; runs against local API fixtures without cloud credentials. Browser tests are separate from `scripts/ci_check.sh`.
* **Run Granular Test Suites:**
  ```bash
  cd route-builder && npm run test:backend  # OSRM, Nominatim, LRU cache
  cd route-builder && npm run test:engine   # Timeline cascade & Google Maps chunking
  cd route-builder && npm run test:ai       # AI harness adapters, schema validation, scout
  cd route-builder && npm run test:schema   # V2 export & device sync
  ```

### Cloud Infrastructure & CI/CD Commands (`infra/` & `scripts/`)
* **Unified Local & CI Verification Pipeline:**
  ```bash
  ./scripts/ci_check.sh
  ```
  Runs the full verification pipeline across all subprojects: `route-builder` tests & production build, `infra` CDK unit tests & CloudFormation synthesis, and Android unit tests (`./gradlew testDebugUnitTest`).
* **CDK Infrastructure Testing & CloudFormation Synthesis:**
  ```bash
  cd infra && npm test && npx cdk synth
  ```
  Executes CDK unit assertions (validating S3 public access blocks, Lambda Web Adapter response streaming, CloudFront API routes) and synthesizes the CloudFormation template.
* **On-Demand Cloud Deployment:**
  ```bash
  ./scripts/deploy_cloud.sh
  ```
  Deploys the full serverless stack to the project's assigned AWS Region: builds the web studio, runs `cdk deploy`, syncs the S3 static hosting bucket, invalidates CloudFront cache, and verifies deployment via `/api/health` live HTTP smoke check.

---

## 5. Rules for Contributing Developers & Agents
1. **Never add cloud API dependencies to the Android in-car drive loop:** `CopilotService`, `LocationTracker`, `AudioDuckEngine`, `NotificationEngine`, and Tier 1 local route editing must operate 100% offline with zero network calls. (Optional Phase 2 Tier 2 cloud sync and mobile Route Scout live strictly on the phone UI when online and must never block or enter the active drive loop).
2. **Strict Battery & Threading Discipline:** In Android, use Kotlin Coroutines (`Dispatchers.IO` for disk/storage/assets, `Dispatchers.Default` for math/JSON parsing, `Dispatchers.Main` for UI/notifications). In Node/Fastify, keep network I/O asynchronous and use LRU caching for routing calls.
3. **Preserve Backward Compatibility in Itineraries:** The Android app must seamlessly parse both V1 schemas (bundled static assets) and V2 schemas (`dwell_minutes`, `type`, `metadata`). Never remove fields from `ItineraryModels.kt`.
4. **Strict TypeScript in `route-builder/`:** Enforce `strict: true` with **zero `any` types**. Catch blocks must use `err: unknown` with `err instanceof Error` narrowing.
5. **Preserve Literal Semicolon in OSRM Coordinate Paths:** The OSRM routing engine strictly requires unencoded `;` delimiters in its URL path segment. Never call `encodeURIComponent` on coordinate strings passed in URL paths.
6. **Preserve Android Auto Distraction Constraints:** List templates displayed while driving must never exceed 6 items per page. Always use pagination or truncation in `androidx.car.app` screens.
7. **Idiomatic Code:** Write concise, null-safe Kotlin and modular, typed TypeScript with single-responsibility components.
8. **Maintain Clean, Human-Friendly UI:** Never introduce internal debug text or verification claims into `route-builder/`. All UI updates must adhere to Human-Centered UI/UX Principles in [`route-builder/AGENTS.md`](route-builder/AGENTS.md) Section 2C.
9. **Maintain Directory Layout:** Whenever adding, removing, or relocating core classes, services, or architecture files, update the Directory Layout in [`docs/reference/directory-layout.md`](docs/reference/directory-layout.md) so that developers and agents can quickly navigate the codebase without scanning the entire tree.
10. **Preserve Route Scout Prompt Purity:** Keep `buildScoutDomainPrompt` strictly domain-focused. Never leak harness-specific tool bans, terminal commands, or background task mechanics into the domain prompt. Implement all harness capabilities, tool allowlists, and response cleaning via the `AiHarnessAdapter` seam (`decorateScoutPrompt` and `sanitizeResponse`).
11. **Adhere to the Project & Task Working Models (Section 6):** Frontier models act as orchestrators (authoring plans, conducting research, verifying code) and delegate implementation to cheaper worker subagents per the active harness adapter to optimize developer quota. For major initiatives in `docs/projects/`, never modify code without an active Work Package, and record all technical surprises in ADRs (`decisions/`) and `DECISIONS.md` before continuing.
12. **No Silent Fallbacks or Mock Degradation:** Silent fallbacks (such as catching a failure in an external service or cloud API like Amazon Bedrock, OSRM, or Google OIDC and silently falling back to mock templates, client-side mocks, or local CLI tools) are strictly forbidden. Silent fallbacks mask critical operational failures, break in cloud environments, and circumvent proper error handling. Any failure in external APIs or internal dependencies must fail loudly, transparently, and deterministically with accurate HTTP status codes and clear error messages surfaced to the caller and UI. **Silent fallbacks are almost always wrong. Always check with the user and obtain explicit approval before designing or implementing any fallback mechanism.**

---

## 6. Planning & Execution Working Models
For full architectural details and mechanics, see [`docs/README.md`](docs/README.md), [`docs/projects/route-scout-cloud/WORKING_MODEL.md`](docs/projects/route-scout-cloud/WORKING_MODEL.md), and [`docs/projects/android-route-client/WORKING_MODEL.md`](docs/projects/android-route-client/WORKING_MODEL.md).

### A. Large Multi-Session Projects (`docs/projects/`) — 3-Tier Rolling Wave
1. Tier 1 Architectural North Star: the complete system specification in the project directory.
2. Tier 2 Phase Roadmap (`plan/ROADMAP.md`): milestones and strict Definition of Done.
   Never break milestone N+1 into micro-tasks before N is merged and verified.
3. Tier 3 Active Work Package (`plan/active/WP-XX-*.md`): exactly ONE at a time, 1-2 session scope.
4. ADRs (`DECISIONS.md` + `decisions/`): scan the index first; record surprises before coding on.

### B. Smaller Tactical Tasks & Spikes (`docs/tasks/`) — Single-File Plan
Self-contained experiments or 1-2 session features. One markdown file holds spec, steps,
verification matrix, and findings. Retire to `docs/archive/` when done.

### C. Orchestrator-Worker Delegation Model
The role split is fixed and harness-independent:

* **Orchestrator** (the primary agent) authors plans, researches external API contracts, defines
  interfaces and boundaries, formulates task prompts, reviews every diff, and runs the
  verification suites.
* **Workers** (delegated subagents) implement bounded, explicitly specified units of work and
  author their tests. Workers never decide architecture.

Non-negotiable properties:

1. **Fresh context & Contract-First prompts.** Every worker starts with no memory. The orchestrator must pass all required context — exact file paths, literal TypeScript/Kotlin interfaces, HTTP status codes, concurrency/cleanup invariants (`AbortController`, revision refs, `clearInterval`), negative constraints (no hardcoded `'us-east-1'` region fallbacks, no `any`, no unmocked browser `/api/*` calls, **no silent fallbacks to mock templates or local CLIs**), and relevant ADR excerpts — in the task prompt.
2. **Single level only.** Workers cannot spawn further workers in any harness. The orchestrator owns
   all fan-out and parallelism.
3. **Bounded tasks only.** Never dispatch open-ended or ambiguous requests to a worker.
4. **Surprises escalate.** If an unexpected constraint appears, stop and record an ADR (Section 3)
   before writing any speculative workaround.
5. **Adversarial verification is never delegated.** The orchestrator personally audits the full `git diff` against the 8-point Adversarial Review Checklist in `WORKING_MODEL.md` (region/IAM accuracy, async race/abort safety, timer/stream leak cleanup, input allowlist validation, output/reasoning tag hygiene, zero silent fallbacks, unhappy-path test coverage, and UI layout geometry) and runs both `./scripts/ci_check.sh` and `cd route-builder && npm run test:browser`. A worker's own report of success is not evidence.

**Harness-specific mechanics are deliberately NOT defined here.** Which delegation tool to call,
which worker types exist, and how models are bound belong to the harness in use. Consult your
harness adapter before delegating:

* **Antigravity:** `.agents/rules/antigravity-harness.md`
* **OpenCode:** `.opencode/rules/harness.md`

### D. Session Lifecycle
1. **Kickoff:** read `DECISIONS.md` and the active Work Package. If `plan/active/` is empty, author
   `ROADMAP.md` and the next WP (with Gate 1 Contract-First specifications) before touching code. Verify live cloud/SDK assumptions with read-only checks. State scope to the user, then begin.
2. **In-flight:** delegate bounded implementation using Contract-First prompts; log ADRs on surprises.
3. **Wrap-up:** perform the Gate 2 Adversarial Diff Audit, run `./scripts/ci_check.sh` and `npm run test:browser`, sync living docs, update the WP handoff log, archive the WP once its Definition of Done is verified.

### E. Project Sequencing & Dependencies
1. **Phase 1 [ACTIVE]:** `docs/projects/route-scout-cloud/`.
2. **Phase 2 [QUEUED]:** `docs/projects/android-route-client/`, blocked until Phase 1 is Done.

---

<!-- BEGIN AWS Agent Toolkit rules -->
# AWS Guidance for Roadtrip Co-Pilot Cloud Stack

This AWS account operates as a standard AWS account with root credentials, IAM Identity Center, and advanced cloud capabilities activated.

Where this guidance conflicts with the project's own instructions, the project's instructions take precedence.

## Architectural & Regional Guardrails:

- **Primary Region (`us-east-2`):**
  - All Regional resources (Lambda functions, S3 app data buckets, Systems Manager parameters, Bedrock inference) MUST target `us-east-2`.
  - CloudFront is a global service configured via `us-east-1` distribution management, with Lambda Function URL origins pointing directly to `us-east-2`.
  - Co-locating resources in `us-east-2` minimizes invocation latency, prevents cross-Region data egress fees, and maintains straightforward observability.
- **Strict $0 Idle Cost Discipline:**
  - Every cloud component must scale to exact zero when not in use:
    - AWS Lambda: On-demand execution only (zero provisioned concurrency).
    - Lambda Function URLs: Used directly behind CloudFront with zero API Gateway hourly base fees.
    - Amazon S3: Pay-per-storage only (zero provisioned capacity).
    - Amazon Bedrock: Serverless on-demand token inference only (zero provisioned throughput units).
    - AWS Systems Manager Parameter Store: Standard `SecureString` parameters (zero monthly secret base fees).
  - Never introduce fixed-cost idle infrastructure (e.g. NAT Gateways, Application Load Balancers, or provisioned databases).
- **Billing & Cost Monitoring:**
  - Cost tracking and spending alerts are managed through AWS Billing and Cost Management using AWS Budgets.
  - Active promotional credits apply automatically against usage before card billing.
- **IAM & Security Best Practices:**
  - Use least-privilege IAM execution roles for Lambda and CI deployers.
  - Never hardcode credentials; resolve runtime secrets via SSM Parameter Store under `/roadtrip-copilot/*`.
  - Machine deployments currently use a scoped IAM deployer user; keyless GitHub Actions OIDC federation is tracked in Issue #7.

### Help level

- help_level: MEDIUM (saved preference — apply AWS security and cost best practices by default; ask at most 1–2 clarifying questions only when something is ambiguous or risky; do not re-ask the user for their help_level).

Constraints for each level:

**LOW:**

- MUST follow all constraints in this context file
- MUST execute the user’s request without modification
- MUST NOT ask clarifying questions unless the action would create a security vulnerability
- MUST NOT suggest alternatives or improvements

**MEDIUM:**

- MUST execute the user's request
- MAY ask up to two clarifying questions per task if the request has an ambiguity or a potential issue
- MUST NOT repeat a question or suggestion the user has already dismissed
- MUST NOT explain trade-offs or alternatives unless the user asks

**HIGH:**

- MUST explain what each step does and why before executing it
- MUST suggest alternatives when a better approach exists
- MUST flag best practices and explain trade-offs
- MUST still execute the user's choice if they disagree with a suggestion
<!-- END AWS Agent Toolkit rules -->
