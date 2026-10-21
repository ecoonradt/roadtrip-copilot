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
* **F. Route Builder Web Studio (`route-builder/`):** Full-stack authoring studio (Fastify backend on `:3001`, React frontend on `:5173`). Features OSRM routing proxies, timeline schedule cascading, multi-stop Google Maps chunking, AI alert generation, Route Scout co-pilot, and stateless dual-mode Google OIDC authentication (`HTTP-Only` web cookies + Android Bearer JWTs with `ALLOWED_EMAILS` allowlist gating and local dev bypass). Governed by [`route-builder/AGENTS.md`](route-builder/AGENTS.md).

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
* **Antigravity CLI (`agy`):** Optional for zero-config local AI copywriting (`~/.local/bin/agy`).

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

1. **Fresh context.** Every worker starts with no memory. The orchestrator must pass all required
   context — file paths, interfaces, acceptance criteria, relevant ADR excerpts — in the task prompt.
2. **Single level only.** Workers cannot spawn further workers in any harness. The orchestrator owns
   all fan-out and parallelism.
3. **Bounded tasks only.** Never dispatch open-ended or ambiguous requests to a worker.
4. **Surprises escalate.** If an unexpected constraint appears, stop and record an ADR (Section 3)
   before writing any speculative workaround.
5. **Verification is never delegated.** The orchestrator re-runs the suites and reviews the diff. A
   worker's own report of success is not evidence.

**Harness-specific mechanics are deliberately NOT defined here.** Which delegation tool to call,
which worker types exist, and how models are bound belong to the harness in use. Consult your
harness adapter before delegating:

* **Antigravity:** `.agents/rules/antigravity-harness.md`
* **OpenCode:** `.opencode/rules/harness.md`

### D. Session Lifecycle
1. **Kickoff:** read `DECISIONS.md` and the active Work Package. If `plan/active/` is empty, author
   `ROADMAP.md` and the next WP before touching code. State scope to the user, then begin.
2. **In-flight:** delegate bounded implementation; log ADRs on surprises.
3. **Wrap-up:** run the verification suites, sync living docs, update the WP handoff log, archive the
   WP once its Definition of Done is verified.

### E. Project Sequencing & Dependencies
1. **Phase 1 [ACTIVE]:** `docs/projects/route-scout-cloud/`.
2. **Phase 2 [QUEUED]:** `docs/projects/android-route-client/`, blocked until Phase 1 is Done.

---

<!-- BEGIN AWS Agent Toolkit rules -->
# AWS Guidance for the new AWS experience

This user has signed up for the new AWS experience. This experience lets you sign into AWS using a social provider and requires the following additional context.

Where this guidance conflicts with the project's own instructions, the project's instructions take precedence.

## Context

### Terminology:

- Say "project" instead of "account" — a project contains an AWS account and settings for sharing with other collaborators
- Say "team member" instead of "IAM user" — users are invited by email, not created or federated in IAM
- Say "AWS Settings" when referring to management tasks at [settings.aws.com](https://settings.aws.com/) (project management, billing, team members, spend limits). Users view their actual AWS resources in the AWS Management Console.
- Say "selected Region" when referring to the user's Region — not "home Region"
- The user has a managed IAM experience. This includes a managed service control policies (SCP) and resource control policies (RCP) that govern the use of AWS. They will still need to use IAM to create policies to let services work with each other. If there are questions about the SCPs or RCPs, go to the documentation at https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html

### Constraints:

- All projects share a single AWS Region determined by the user's contact address. Resources cannot be created in other Regions
- When developing:
  - MUST create all Regional resources in the project's assigned Region
  - You CAN create AWS WAF and Cloudwatch Logs resources in us-east-1 when there are global resources (like a global WAF instance) that require a connection to dependencies in us-east-1. You should not use these for any other reason, because resources in the selected Region will provide lower cost (due to no cross-Region traffic), increased availability (due to no cross-Region traffic), and easier manageability (due to not needing to look in another Region). When you need to do an inventory of resources, you need to look in both the selected Region and us-east-1 for Cloudwatch Logs or WAF resources.
  - MUST NOT attempt to create Lambda, API Gateway, or other Regional resources in any other Region
  - MUST direct users to confirm their Region in AWS Settings > View all projects > Overview > Additional Info > Region. If the user cannot confirm their Region, check in ~/.aws/config
  - MUST NOT use Lambda@Edge — excluded from both Lambda and CloudFront
  - MUST NOT use CloudFormation StackSets — no multi-account or multi-Region deployments
  - MUST NOT attempt cross-Region actions — no cross-Region replication for DynamoDB/S3/RDS, no multi-Region KMS keys
  - MUST NOT use Route 53 cross-Region routing — geolocation, latency-based, and failover routing policies are not available
  - CloudFront is a global service and its actions ARE allowed in `us-east-1`. A user can create a CloudFront distribution pointing to their project-region Lambda function URL or API Gateway. However, Lambda and API Gateway themselves MUST NOT be created in `us-east-1` — they must be in the project Region.
  - Reduced availability in `eu-north-1` specifically: Amazon Rekognition, Amazon Textract, Amazon Personalize, AWS App Runner are not available in that Region.
- IAM permissions for human access are managed by AWS. Don't assign roles to team members unless absolutely necessary
- The user may have a spend limit if they are on the paid plan. The limit that pauses their project if it's exceeded. If resources suddenly become inaccessible, ask if they have a spend limit configured. Only project owners can modify a spend limit.
- When developing:
  - MUST ask about spend limit status if the user reports sudden "Access Denied" errors on operations that previously worked
  - MUST direct users to check spend status in AWS Settings > Billing
  - MUST check if a user has upgraded their account to the paid plan
  - MUST ask the user if they want to clean up the successfully created resources or keep them to reduce cost
- The user sets up billing, creates spend limits, and retrieves and pays invoices in AWS Settings. The user creates budgets and optimizes their costs in the AWS Billing and Cost Management console
- Not all AWS services are available. If a service isn't working, do the following:
  1. Run the command `aws freetier get-account-plan-state`
  2. If accountPlanType": "FREE", check the [Free Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-free-tier) next,
  3. If accountPlanType": "PAID", check the [Paid Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-paid-plan).
  4. If neither list shows the service, check the [Not supported for this experience list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#unsupported-services). The user will need to activate advanced features to access this service.
- Users can activate advanced AWS services and capabilities for their account.
- Before starting a task, check whether a relevant AWS skill is available. Load the skill with retrieve_skill and prefer its guidance over general knowledge.

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
