# Car App Library Notification Experiment — Research and Implementation Plan

**Prepared:** October 6, 2026  
**Repository inspected:** `/home/eric/code/roadtrip-copilot`  
**Source baseline inspected:** `f97d4bcbcd5f6d0489438aefae9dc98768906d76` on `main`  
**Status:** Research complete; implementation, builds, installation, and validation have NOT been performed.  
**Audience:** An implementing agent that should be able to follow this plan without rediscovering the architecture or guessing library APIs.

> **Current authorization is documentation only.** The owner explicitly deferred the build. Do not interpret this document's commands or code examples as permission to execute them now. Obtain a subsequent implementation request before editing app code, and explicit approval before replacing the phone's tested APK or changing Android Auto/device state.

## Contents

1. [Objective and success criteria](#1-objective-and-success-criteria)
2. [Evidence, history, and unresolved questions](#2-evidence-history-and-unresolved-questions)
3. [Research sources and exact API findings](#3-research-sources-and-exact-api-findings)
4. [Scope, invariants, and design decisions](#4-scope-invariants-and-design-decisions)
5. [Branch and artifact preparation](#5-branch-and-artifact-preparation)
6. [File-by-file implementation](#6-file-by-file-implementation)
7. [Automated tests](#7-automated-tests)
8. [Build and static verification](#8-build-and-static-verification)
9. [Phone installation and rollback](#9-phone-installation-and-rollback)
10. [DHU and real-car validation](#10-dhu-and-real-car-validation)
11. [Diagnostic collection and interpretation](#11-diagnostic-collection-and-interpretation)
12. [Failure handling and decision gates](#12-failure-handling-and-decision-gates)
13. [Implementing-agent checklist and handoff](#13-implementing-agent-checklist-and-handoff)

---

## 1. Objective and success criteria

### 1.1 The problem

After a successful trip, the owner parks the car, launches Roadtrip Co-Pilot from Android Auto's app launcher, and sees the last waypoint's messaging conversation instead of the app's dashboard/settings. Returning to Maps, opening Android Auto's notification center, and selecting **Clear all** does not restore access to the intended app interface.

The earlier incident involved an old test alert. The October 6 reproduction instead involved the **last real trip alert**. Do not design a solution specific to driveway test notifications.

### 1.2 The experiment

On a separate source branch, change waypoint alerts from the legacy Android Auto messaging integration to ordinary notifications extended through the **Android for Cars App Library**:

- Keep a **template-only** automotive capability declaration.
- Keep the car app's **POI** category.
- Use `androidx.car.app.notification.CarAppExtender`.
- Post alert builders through `CarNotificationManager`.
- Use a `CarPendingIntent` explicitly targeting `CopilotCarAppService` for **car-side notification taps**.
- Remove messaging-style content, conversation identity, and reply actions from newly posted alerts.
- Keep the normal phone notification tap targeting `MainActivity`.
- Retain cancellation hygiene and all existing driving/audio behavior.

This is an **eligibility and launcher-routing experiment**, not a proven fix.

### 1.3 Conditions required for success

Both of these must pass in the actual vehicle:

1. **Alert delivery:** Real waypoint heads-up cards appear while Google Maps remains the navigation provider and Co-Pilot operates in the background, including when the Co-Pilot car UI has not been opened in that connection session.
2. **Car interface access:** The Android Auto launcher opens Co-Pilot's templated interface before and after alerts, after Clear all, and after the last real trip alert. Settings remain accessible.

Also require:

- A second alert still produces a fresh heads-up presentation, including a second update while the first notification is active.
- Speech still pauses music by default and music returns after speech completion.
- No extra notification chime is introduced.
- Notifications do not become ongoing navigation cards or claim Maps' navigation role.
- Dismissal, timeout, trip stop, and service destruction remove the alert without removing the foreground status notification while tracking is active.
- Phone operation without Android Auto continues to work.
- Imported routes, selected route/day, preferences, and progress remain compatible with the saved known-good APK.

**A successful build, unit suite, or DHU run alone does not satisfy these success criteria.**

---

## 2. Evidence, history, and unresolved questions

### 2.1 Established observations

- `tmp/android_auto_ui_investigation_summary.md` records the October 2/3 investigation. Preserve it as a historical artifact; it is not authoritative proof of a root cause.
- The owner reproduced the issue after a complete successful trip while **parked**, then again after **Clear all**.
- `af68b61` added notification lifecycle hygiene on October 3: stable ID `2000`, legacy ID sweeping, a conversation shortcut ID, speech-based dismissal, stop/destroy cleanup, and cleanup on car session creation.
- The APK installed on the phone during the October 6 test contains those cleanup changes. Its DEX contains `car_session_created`, `speech_grace_period_expired`, `service_stopped`, `service_destroyed`, and `copilot_alerts`.
- An October 6 ADB snapshot showed **no currently active Co-Pilot notification**, but Android Auto had already disconnected around 10:36. This does not prove what was active while the unwanted car screen was visible.
- Normal app logs for the launcher taps had rolled out of the buffers. Internal Android Auto dumps retained some audio and disconnect history, not a conclusive package-selection trace.

### 2.2 Working hypothesis, not a diagnosis

The app advertises both messaging and templates and creates message conversations for waypoint alerts. Android Auto may be selecting/resuming its message experience for this package rather than opening `CopilotCarAppService`.

If the host does not enter the car app session, cleanup in `CopilotCarSession.onCreateScreen()` cannot redirect the host. Removing more app-side notifications might not erase host-retained conversation history.

Do **not** state that any of the following has been proven:

- A BMW-specific launcher bug.
- A particular stuck communication-task implementation.
- Reinstalling an APK completely flushes Android Auto's cached conversation/task state.
- Dual `notification` + `template` capabilities are universally invalid.

Google expressly supports both capabilities for true templated messaging apps. Our POI app emitting advisory alerts as messages is a different combination.

### 2.3 Git history: what was actually attempted

All available branches and reflog-reachable commits were searched:

```bash
git log --all --reflog -G 'CarAppExtender|CarNotificationManager|CarPendingIntent' --format='%h %s'
```

At the inspected baseline, this returned no matches. Uncommitted experiments cannot be ruled out.

| Commit | Historical behavior | Important limitation |
|---|---|---|
| `db6f435`, Sept. 6 | Legacy `NotificationCompat.CarExtender`, `BigTextStyle`, `CATEGORY_NAVIGATION` | No automotive descriptor or corresponding application manifest metadata |
| `3c493ca`, Sept. 6 | Same legacy extender/style; category changed to `CATEGORY_EVENT`; actions/sound/priority adjusted | Still no automotive registration |
| `be4876c`, Sept. 7 | Added automotive registration and changed alerts to `MessagingStyle` / `CATEGORY_MESSAGE`, with reply/read actions | Several variables changed simultaneously; cannot attribute improvement to style alone |
| `07f40af`, Sept. 8 | First added `androidx.car.app:app:1.4.0` and templated POI screens | Alert implementation remained legacy messaging-based |
| `af68b61`, Oct. 3 | Added cancellation hygiene | Did not replace messaging or the legacy extender |

The actual classes differ:

```text
Existing/historical: androidx.core.app.NotificationCompat.CarExtender
Proposed experiment: androidx.car.app.notification.CarAppExtender
```

The old failures justify caution but are not a clean failed test of the proposed combination.

### 2.4 The key unresolved platform question

Will projected Android Auto accept these ordinary, high-importance, Car App Library notifications from a **POI background companion**, while **Google Maps** is active and without an already-open Co-Pilot car session?

Library code and documentation support constructing this payload. They do not establish this exact host eligibility scenario. Google's notification showcase demonstrates a non-navigation *notification*, but its app manifest declares the **NAVIGATION app category**. Do not present that sample as proof of POI eligibility.

Do not conflate projected Android Auto with **Android Automotive OS (AAOS)**. AAOS notification category/HUN restrictions are not automatically evidence about this phone-projected app.

---

## 3. Research sources and exact API findings

### 3.1 Sources to consult, in order of authority

For method signatures, use the pinned **1.4.0** source artifact, not whatever the latest online reference happens to show.

1. **Pinned app-library sources:**
   - URL: <https://dl.google.com/dl/android/maven2/androidx/car/app/app/1.4.0/app-1.4.0-sources.jar>
   - Local research copy: `/tmp/opencode/copilot-aa-20261006/app-1.4.0-sources.jar`
   - SHA-256: `ef916609f6f08792debdd659bdb0d26aea7bda452505e45424a4c95d71b7a259`
   - Relevant entries: `androidx/car/app/notification/CarAppExtender.java`, `CarNotificationManager.java`, `CarPendingIntent.java`, `CarAppNotificationBroadcastReceiver.java`, plus `androidx/car/app/CarAppService.java` and `Session.java`.
2. **Pinned testing-library sources:**
   - URL: <https://dl.google.com/dl/android/maven2/androidx/car/app/app-testing/1.4.0/app-testing-1.4.0-sources.jar>
   - Local copy: `/tmp/opencode/copilot-aa-20261006/app-testing-1.4.0-sources.jar`
   - SHA-256: `eaf836c826576433170a8e1c2e452ec205af3e7c8c59fea3a3a56a6932c83fe0`
   - Relevant entries: `SessionController.java`, `TestScreenManager.java`, `TestCarContext.java`.
3. **Official API documentation:**
   - <https://developer.android.com/reference/androidx/car/app/notification/CarAppExtender>
   - <https://developer.android.com/reference/androidx/car/app/notification/CarNotificationManager>
   - <https://developer.android.com/reference/androidx/car/app/notification/CarPendingIntent>
4. **Official capability and app-category guidance:**
   - <https://developer.android.com/training/cars/apps/auto>
   - <https://developer.android.com/training/cars/apps/poi>
   - <https://developer.android.com/training/cars/apps/navigation>
   - <https://developer.android.com/training/cars/communication/notification-messaging>
   - <https://developer.android.com/training/cars/communication/templated-messaging>
5. **Official sample, pinned for reproducibility:**
   - Repository commit inspected: `android/car-samples` at `9be0b199986770cd5cde7765765c0eaef0758d15`.
   - [NotificationDemoScreen.java](https://github.com/android/car-samples/blob/9be0b199986770cd5cde7765765c0eaef0758d15/car_app_library/showcase/common/src/main/java/androidx/car/app/sample/showcase/common/screens/templatelayouts/gridtemplates/NotificationDemoScreen.java)
   - [Showcase Android Auto manifest](https://github.com/android/car-samples/blob/9be0b199986770cd5cde7765765c0eaef0758d15/car_app_library/showcase/mobile/src/main/AndroidManifest.xml)
   - The notification demo supports category `None`; the manifest still declares a navigation app. Both facts matter.
6. **Robolectric 4.11.1 test helpers:**
   - <https://github.com/robolectric/robolectric/blob/robolectric-4.11.1/shadows/framework/src/main/java/org/robolectric/shadows/ShadowPackageManager.java>
   - <https://github.com/robolectric/robolectric/blob/robolectric-4.11.1/shadows/framework/src/main/java/org/robolectric/shadows/ShadowPendingIntent.java>

Research copies under `/tmp/opencode` may disappear. URLs, versions, and critical findings are retained here so the implementation does not depend on those copies.

### 3.2 Verified 1.4.0 signatures

```java
CarAppExtender.Builder.addAction(int icon, CharSequence title, PendingIntent intent)
CarAppExtender.Builder.setContentIntent(PendingIntent intent)
CarAppExtender.Builder.setDeleteIntent(PendingIntent intent)
CarAppExtender.Builder.setImportance(int importance)
CarAppExtender.Builder.setColor(CarColor color)

CarNotificationManager.from(Context context)
CarNotificationManager.notify(int id, NotificationCompat.Builder notification)
CarNotificationManager.notify(String tag, int id, NotificationCompat.Builder notification)

CarPendingIntent.getCarApp(Context context, int requestCode, Intent intent, int flags)

SessionController(Session session, TestCarContext context, Intent intent)
SessionController.moveToState(Lifecycle.State state)
```

### 3.3 Implementation traps that must be avoided

1. **Pass a builder to `CarNotificationManager.notify`, not a built `Notification`.** Do not call `.build()` as the argument. The foreground status path still returns a built `Notification`, as before.
2. **Do not pass `NotificationCompat.Action` to `CarAppExtender.Builder.addAction`.** In 1.4.0, use the three-argument overload shown above. Newer framework-action overloads are not available in this dependency.
3. **Car-side launch intents must be mutable.** `CarPendingIntent.getCarApp` explicitly removes `FLAG_IMMUTABLE` and adds its mutable flag. The host must add a binder extra to launch the app. Pass `FLAG_UPDATE_CURRENT`; let the helper handle mutability. Phone content and dismiss pending intents should remain explicit and immutable.
4. **`CarPendingIntent` accepts an ordinary `Context`.** It does not require holding a `CarContext`, an existing `Session`, or a host connection in `NotificationEngine`.
5. **Target the car app service, not `MainActivity` or `CopilotService`.** The helper validates that a service component exists in the caller's package. Use `CopilotCarAppService` explicitly.
6. **The helper mutates its supplied `Intent`.** On projected Android Auto it stores the original component in an extra and retargets the intent to `CarAppNotificationBroadcastReceiver`. Construct a fresh intent for this call; never reuse the phone or dismiss intent.
7. **Do not add or export the library's internal receiver manually.** The 1.4.0 AAR already declares `androidx.car.app.notification.CarAppNotificationBroadcastReceiver` with `android:exported="false"`. Verify the merged manifest instead.
8. **Manually sending the car launch pending intent is not a valid car-launch test.** Without the host-supplied binder, the library receiver logs `CarApp.NBR: Notification intent missing expected extra` and cannot start the projected app.
9. **`setColor` takes `CarColor`, not an Android color integer, and its car background color is for navigation notifications.** Omit it for this experiment; do not chase color behavior.
10. **`CarAppExtender.setChannelId` is an AAOS override.** On this projected app, set the channel on `NotificationCompat.Builder`; set car importance with `setImportance`.
11. **Car actions override top-level phone actions when supplied.** Define the car dismiss action in the extender even if a corresponding phone action is present.
12. **Warm launches use `Session.onNewIntent`, not necessarily `onCreateScreen`.** Add warm-launch cleanup/diagnostics without recreating the screen stack.
13. **`CarAppService.onBind` and `dump` are final in 1.4.0.** Do not override them to add instrumentation. Log in `onCreateSession`, `onCreateScreen`, and `onNewIntent` instead.
14. **`CarNotificationManager` is a wrapper, not a second host-rendered notification database.** For projected Android Auto it delegates to `NotificationManagerCompat`; existing targeted OS notification cancellation still applies.

---

## 4. Scope, invariants, and design decisions

### 4.1 Expected changed files

| File | Planned change |
|---|---|
| `app/src/main/res/xml/automotive_app_desc.xml` | Remove messaging capability; retain template capability |
| `app/src/main/java/com/roadtrip/copilot/NotificationEngine.kt` | Replace only waypoint alert payload/posting; isolated experimental alert channel |
| `app/src/main/java/com/roadtrip/copilot/NotificationReceiver.kt` | Add ordinary dismiss handling; preserve legacy read/reply handling |
| `app/src/main/AndroidManifest.xml` | Add ordinary dismiss action to existing receiver filter; retain all automotive/service metadata |
| `app/src/main/java/com/roadtrip/copilot/car/CopilotCarSession.kt` | Log cold/warm entry and clean alerts on warm entry |
| `app/src/main/java/com/roadtrip/copilot/car/CopilotCarAppService.kt` | Add one session-creation diagnostic log |
| `app/src/test/java/com/roadtrip/copilot/NotificationEngineTest.kt` | Preserve existing tests and expand coverage for new payload/intents/channel |
| `app/src/test/java/com/roadtrip/copilot/CopilotCarSessionTest.kt` | Add focused cold/warm session cleanup tests |
| `AGENTS.md` and `README.md` | On the experimental branch, describe the actual experimental path and its unverified vehicle status |

No new production module, screen, service, adapter layer, build flavor, or provider is needed.

### 4.2 Leave these alone

- `app/build.gradle.kts`: keep app ID, version code/name, SDK levels, dependencies, and signing behavior unchanged.
- `CopilotService.kt`: preserve notification scheduling, speech dispatch, GPS lifecycle, and foreground status updates. Inspect but do not refactor it for this task.
- `AudioDuckEngine.kt`, `LocationTracker.kt`, itinerary models, and `RouteRepository.kt`.
- Every bundled, imported, workspace, and custom route file.
- Route Builder and its web/backend code.
- Existing dashboard/settings layout and navigation behavior.
- Existing foreground/resume notifications: IDs `1001` and `1002`, phone-side `MainActivity` intents, status channel, and existing posting mechanisms.

If an unexpected defect in one of these blocks implementation, report it separately; do not turn the experiment into a general cleanup.

### 4.3 Non-negotiable compatibility invariants

- Application ID: `com.roadtrip.copilot`.
- `versionCode = 1`, `versionName = "1.0"` for this local A/B experiment, unless the owner explicitly chooses another strategy. Keeping equal version codes avoids a downgrade problem during rollback.
- Same signing certificate as the saved known-good APK. Verify it; do not assume a regenerated debug key is identical.
- Same route and preference schemas, storage paths, and selection/progress keys.
- No uninstall, app-data clear, preference reset, itinerary rewrite/import, or automatic progress reset.
- Keep `ALERT_NOTIFICATION_ID = 2000` and sweep range `2000..2049`.
- Keep the 15-second notification timeout and 8-second post-speech grace period.
- Do not set `onlyAlertOnce = true` on waypoint alerts. New/updated alerts must be eligible to produce another HUN.
- Do not set waypoint alerts ongoing.
- Do not use `CATEGORY_NAVIGATION`, change the car service to `NAVIGATION`, add navigation permissions, or call `NavigationManager.navigationStarted()`.
- Keep default `AUDIOFOCUS_GAIN_TRANSIENT`, navigation-guidance audio usage, speech content type, and existing pause/duck selection.
- Do not add network/cloud dependencies to the driving loop.
- Do not post both old messaging and new car notifications as a fallback. That would defeat the experiment and could duplicate alerts or recreate the launcher ambiguity.

`AGENTS.md` currently describes messaging as the implementation. The owner's requested experiment intentionally replaces those **implementation-specific §2C details on the experimental branch**. Preserve the handbook's offline, audio, lifecycle, and distraction requirements. Do not "fix" a failed test by restoring the messaging payload.

### 4.4 Fixed choices for the first experiment

Use these choices rather than inventing alternatives during implementation:

- New alert channel ID: `copilot_alert_channel_carapp_experiment_v1`.
- Existing channel name/description string resources may be reused. Log the actual channel ID so the two implementations are distinguishable.
- Never delete, recreate, or explicitly mutate the legacy `copilot_alert_channel_v4` or older alert channels. Reverting the APK should use their preserved settings.
- New alerts use `BigTextStyle` on the phone, plain title/text car overrides, and **no explicit notification category**. This matches the ordinary category-`None` branch of Google's sample and avoids pretending to be a turn-by-turn navigator or message conversation.
- One ordinary **Dismiss** action and matching delete intent, on both phone and car.
- Phone tap opens `MainActivity`, unchanged.
- Car tap opens the existing Co-Pilot car interface; cold entry returns the dashboard, warm entry preserves the current app screen. Directly jumping to Settings is out of scope.
- The car launcher must work separately from notification taps. An explicit car content intent does not prove that launcher routing was fixed.
- Stable pending-intent request codes: phone content `2000`; dismiss `20002`; car content `20003`.
- Diagnostic source extra: `copilot_launch_source`, with value `waypoint_alert` on the car notification intent. Missing source means `unspecified`, not conclusively "launcher".

---

## 5. Branch and artifact preparation

**Future execution only, after implementation is requested. Do not build or install during the current planning task.**

### 5.1 Preserve the exact tested APK

A copy of the APK that was installed during the successful October 6 trip has already been pulled:

```text
/tmp/opencode/copilot-aa-20261006/copilot-installed.apk
Size: 8,141,760 bytes
SHA-256: c896aab2ae7225c41fc84f28c7cae4fd052ab8d951a7c46f81414d9d53932c54
Recorded installed version: 1.0, versionCode 1
Recorded lastUpdateTime: 2026-10-04 09:50:47
```

Copy this specific file to an owner-approved durable backup location before any future replacement. Verify its hash after copying. Keep an additional copy outside temporary folders before relying on it for a trip. Do not assume `/tmp/opencode` survives cleanup/reboots.

**Do not rebuild today's `main` and label that output "the tested build."** The installed APK predates current HEAD. Its exact source commit is not encoded in the current version name/code and has not been proven. Recent non-notification source changes can confound comparisons.

Distinguish artifacts:

- `copilot-known-good-installed-20261006.apk`: exact pulled tested APK.
- Optional `copilot-control-source-<base-commit>.apk`: unchanged chosen source base, built later only if authorized, for a controlled same-base comparison.
- `copilot-carapp-experiment-<experiment-commit>.apk`: new experiment.

The known-good artifact is the rollback target regardless of whether a new source-control baseline is built.

### 5.2 Source branch

Inspect user work before branching:

```bash
git status --short --branch
git rev-parse HEAD
```

Default branch name: `experiment/carapp-waypoint-notifications`.

After confirming the selected source base and a clean working tree:

```bash
git switch -c experiment/carapp-waypoint-notifications
```

Do not reset, discard, stash, or overwrite someone else's work without authorization. If the branch already exists, inspect it rather than force-moving it. Record the actual base commit in the implementation report.

An isolated worktree is an acceptable alternative. Refer to `docs/tasks/carapp_notification_experiment_implementation_plan.md` (or copy it if branching from an older commit that predates `docs/tasks/`). Read the applicable `AGENTS.md` there. Do not create multiple implementation variants unless the owner requests them.

### 5.3 Record artifact provenance

For each future APK, keep a small accompanying text file with:

- Artifact role: known-good, same-base control, or experiment.
- Exact file path and SHA-256.
- Source commit/base if known; explicitly `unknown` for the installed APK's source commit.
- Whether the source tree was dirty at build time.
- Version code, version name, package ID, certificate SHA-256 digest.
- Build command and date.
- Validation status: `local tests only`, `DHU tested`, `vehicle tested`, or `not tested`.

Source branches do not switch the phone's installed code. Only explicit APK installation does that.

In the future command examples below, `KNOWN_GOOD_APK` and `EXPERIMENT_APK` must be set to the real, verified absolute paths of the two saved artifacts. `ARTIFACT_DIR` and `DIAG_DIR` must be existing owner-approved directories. Names containing `<base-commit>` or `<experiment-commit>` are naming templates, not literal shell commands. Never execute a placeholder path or infer which APK a generic `app-debug.apk` currently contains.

---

## 6. File-by-file implementation

### 6.1 Automotive descriptor

In `app/src/main/res/xml/automotive_app_desc.xml`, use exactly:

```xml
<?xml version="1.0" encoding="utf-8"?>
<automotiveApp>
    <uses name="template" />
</automotiveApp>
```

Retain the manifest's `com.google.android.gms.car.application` metadata referring to this resource. Retain `androidx.car.app.minCarApiLevel = 1`, the exported `CopilotCarAppService`, its `androidx.car.app.CarAppService` action, and its **POI** category.

### 6.2 NotificationEngine: imports and manager separation

In `app/src/main/java/com/roadtrip/copilot/NotificationEngine.kt`:

- Remove imports used only by the old alert payload: legacy `NotificationCompat.CarExtender`, `Person`, and `RemoteInput`.
- Add `ComponentName`, `CarAppExtender`, `CarNotificationManager`, `CarPendingIntent`, and `CopilotCarAppService` imports.
- Keep the current `NotificationManagerCompat` property for `postResumeNotification`.
- Add a separate car alert manager, e.g.:

```kotlin
private val carNotificationManager = CarNotificationManager.from(context)
```

- Change `CHANNEL_ALERT_ID` to the isolated experimental channel ID in §4.4.
- Add `const val EXTRA_CAR_LAUNCH_SOURCE = "copilot_launch_source"` for notification/session diagnostics.
- Remove unused `ALERT_SHORTCUT_ID` only after checking for other references. Do not manipulate platform shortcuts or try to erase Android Auto conversation storage.

Keep `buildForegroundNotification`, `postResumeNotification`, and `cancelAlerts` behavior intact.

### 6.3 NotificationEngine: channel behavior

The experimental alert channel remains:

- `NotificationManager.IMPORTANCE_HIGH`.
- Silent: `setSound(null, null)`.
- Existing vibration pattern `longArrayOf(0, 350, 200, 350)`.
- Public visibility and existing badge behavior.

Only change the alert channel ID; do not increase the status channel's importance or extend status/resume notifications for the car. Do not call any channel deletion APIs. Do not add `DEFAULT_ALL`, which could conflict with silent TTS operation.

Channel preferences are persistent OS state. The new channel intentionally starts with its own settings. Returning to the old APK uses the untouched old channel. An unused experiment channel remaining after rollback is not a data-schema incompatibility.

### 6.4 NotificationEngine: replace postHeadsUpAlert

Replace the body of `postHeadsUpAlert(title, message)` rather than keeping two selectable implementations. Keep the public method signature so existing service call sites stay unchanged.

The following is an implementation blueprint with signatures verified against 1.4.0. It has **not been compiled**. Adapt the log wording to surrounding style, but preserve its behavior:

```kotlin
fun postHeadsUpAlert(title: String, message: String) {
    val alertId = ALERT_NOTIFICATION_ID
    Log.i(TAG, "Posting car-app waypoint alert: \"$title\" (id: $alertId, channel: $CHANNEL_ALERT_ID)")

    try {
        val phoneIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val phonePendingIntent = PendingIntent.getActivity(
            context,
            alertId,
            phoneIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val dismissIntent = Intent(context, NotificationReceiver::class.java).apply {
            action = NotificationReceiver.ACTION_DISMISS
            putExtra(NotificationReceiver.EXTRA_NOTIFICATION_ID, alertId)
        }
        val dismissPendingIntent = PendingIntent.getBroadcast(
            context,
            alertId * 10 + 2,
            dismissIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Fresh intent: the library mutates it into its internal broadcast wrapper.
        val carIntent = Intent(Intent.ACTION_VIEW).apply {
            component = ComponentName(context, CopilotCarAppService::class.java)
            putExtra(EXTRA_CAR_LAUNCH_SOURCE, "waypoint_alert")
        }
        val carPendingIntent = CarPendingIntent.getCarApp(
            context,
            alertId * 10 + 3,
            carIntent,
            PendingIntent.FLAG_UPDATE_CURRENT
        )

        val phoneDismissAction = NotificationCompat.Action.Builder(
            R.drawable.ic_copilot,
            "Dismiss",
            dismissPendingIntent
        )
            .setShowsUserInterface(false)
            .build()

        val carExtender = CarAppExtender.Builder()
            .setContentTitle(title)
            .setContentText(message)
            .setSmallIcon(R.drawable.ic_copilot)
            .setImportance(NotificationManager.IMPORTANCE_HIGH)
            .setContentIntent(carPendingIntent)
            .setDeleteIntent(dismissPendingIntent)
            .addAction(R.drawable.ic_copilot, "Dismiss", dismissPendingIntent)
            .build()

        val builder = NotificationCompat.Builder(context, CHANNEL_ALERT_ID)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setSmallIcon(R.drawable.ic_copilot)
            .setContentIntent(phonePendingIntent)
            .setDeleteIntent(dismissPendingIntent)
            .addAction(phoneDismissAction)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setOngoing(false)
            .setVibrate(longArrayOf(0, 350, 200, 350))
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setTimeoutAfter(15_000L)
            .extend(carExtender)

        // Intentionally no CATEGORY_MESSAGE, CATEGORY_NAVIGATION, or shortcut ID.
        // notify takes the builder, not builder.build().
        carNotificationManager.notify(alertId, builder)
        Log.i(TAG, "Car-app waypoint alert submitted (id: $alertId)")
    } catch (e: SecurityException) {
        Log.w(TAG, "SecurityException posting car-app alert: ${e.message}", e)
    } catch (e: IllegalArgumentException) {
        Log.e(TAG, "Invalid car-app notification setup: ${e.message}", e)
    }
}
```

Why the exception boundary surrounds construction as well as posting:

- `CarPendingIntent` performs component validation and can throw before `notify`.
- Permission/configuration problems should be logged without preventing the existing service from reaching its next statement, which dispatches speech.
- `InvalidParameterException` is an `IllegalArgumentException` subtype.
- Do not catch every exception and silently fall back to messaging. These errors mean the experiment is failing and must be diagnosed.

Do not add navigation actions, a fake sender, a reply action, a shortcut ID, or a separate message notification. Do not report "shown in car" from the submission log: local submission is not host rendering.

### 6.5 Ordinary dismiss receiver and manifest

In `NotificationReceiver.kt`:

1. Add:

```kotlin
const val ACTION_DISMISS = "com.roadtrip.copilot.ACTION_DISMISS"
```

2. Add an `ACTION_DISMISS` case that performs the same targeted cleanup as the existing mark-as-read path, using reason `action_dismiss`:
   - `NotificationEngine.cancelAlerts(context, "action_dismiss")`.
   - `CopilotService.getInstance()?.cancelAlerts("action_dismiss")` to cancel the pending dismissal job and clear `hasActiveAlert`.
   - Preserve the existing notification-ID cancellation behavior.
3. Keep `ACTION_MARK_AS_READ`, `ACTION_REPLY`, `KEY_TEXT_REPLY`, and their existing handling. They are compatibility handlers for old pending intents, not part of newly posted payloads.
4. Dismissal must **not** stop GPS tracking, mark waypoints visited, reset progress, start the phone UI, or restart the service.

Keeping a small duplicate case is acceptable for the first experiment; do not refactor the entire receiver. If a helper is extracted, keep all existing action behavior and reason logging clear.

In the existing receiver's manifest filter, add:

```xml
<action android:name="com.roadtrip.copilot.ACTION_DISMISS" />
```

Keep `android:exported="false"` and both old action entries. The explicit pending intent can invoke the non-exported receiver on behalf of the app. Do not broaden receiver export or permissions to solve a test failure.

The same ordinary dismiss pending intent is used for the phone action, phone delete intent, car action, and car delete intent. Clear all should therefore invoke app cleanup if the host sends that delete intent. Timeout/system cancellation does not necessarily invoke it; existing OS timeout and service cleanup remain independent safeguards.

### 6.6 Car session: cold and warm entry

In `CopilotCarSession.kt`:

- Keep `onCreateScreen` returning `CopilotDashboardScreen(carContext)`.
- Keep both existing cancellation calls on cold entry.
- Add a `Log.i` entry with a stable tag `CopilotCarSession` and callback name, action, and `EXTRA_CAR_LAUNCH_SOURCE` (or `unspecified`). Do not dump the entire intent/extras or route coordinates.
- Override `onNewIntent(intent: Intent)`:
  - Call `super.onNewIntent(intent)`.
  - Log the entry and source.
  - Call both cancellation paths with reason `car_session_new_intent`.
  - Do **not** push a new dashboard, clear the screen stack, or force Settings. Keep the current screen so a warm entry can return to Settings if that is where the user left off.

A small private helper may share the two cancellation calls between cold/warm entry. Preserve reason `car_session_created` for cold entry because existing diagnostics use it.

In `CopilotCarAppService.kt`, add a session-creation `Log.i` with tag `CopilotCarAppService` inside the existing `onCreateSession()`. Leave the existing route initialization and host validator unchanged. Do not upgrade the callback to a newer API solely for this experiment.

The session logs are proof that these callbacks ran, not proof that the host rendered their returned templates. Pair them with observation/photographs.

### 6.7 Branch-local documentation

Update `AGENTS.md` §2C and the notification entries in its directory layout to describe the **experimental** implementation and legacy-compatible dismiss receiver. Add the new session test to the test overview if appropriate.

Update relevant README sections to explain:

- This branch tests non-messaging waypoint cards; vehicle reliability is not yet established.
- The old message-notification toggles were prerequisites for the messaging build, not a proven requirement of this experimental path.
- Unknown sources remains a sideloaded-app requirement.
- The app remains a background companion to Maps; it is not a turn-by-turn navigation provider.
- Exact known-good APK replacement remains the fallback.

Do not rewrite unrelated architecture docs or the old investigation summary. Do not claim "fixed" or universal POI eligibility based on local tests.

---

## 7. Automated tests

**These commands compile code and are deferred until future build/test authorization. None were run while preparing this plan.**

### 7.1 Critical test setup: Config.NONE does not register the car service

`NotificationEngineTest.kt` currently uses `@Config(manifest = Config.NONE)`. After the change, `CarPendingIntent` checks `PackageManager.getServiceInfo` and will reject an unregistered service in this test environment.

Do not remove production component validation or add a fake production fallback. Register the real service name in the Robolectric package manager during test setup:

```kotlin
import android.content.ComponentName
import org.robolectric.Shadows.shadowOf
import com.roadtrip.copilot.car.CopilotCarAppService

// After obtaining context, before constructing/posting with NotificationEngine:
shadowOf(context.packageManager).addServiceIfNotPresent(
    ComponentName(context, CopilotCarAppService::class.java)
)
```

This helper exists in Robolectric 4.11.1. Use `context.packageName` through `ComponentName(context, ...)`; with `Config.NONE` the runtime test package need not be `com.roadtrip.copilot`.

Use an SDK supported by the pinned Robolectric version, e.g. `@Config(manifest = Config.NONE, sdk = [33])`, for pending-intent/channel assertions. Do not upgrade Robolectric, compile SDK, or dependencies to model the owner's Android 17 phone in unit tests. Grant simulated notification permission inside the test setup if the chosen shadow requires it; never change phone permissions as part of unit tests.

### 7.2 Preserve the existing three tests

- Posting twice leaves exactly one alert with ID `2000`.
- `cancelAlerts` removes all IDs in `2000..2049` and preserves non-alert ID `1001`.
- Legacy mark-as-read and reply receiver actions still cancel alerts.

Adapt setup, not those established semantics.

### 7.3 Add payload and intent tests

Inspect the posted notification from `NotificationManager.activeNotifications`, then construct `CarAppExtender(notification)` to read its public overrides.

| Test | Required assertions |
|---|---|
| `testAlertUsesCarAppExtenderWithoutConversationPayload` | `CarAppExtender.isExtended(notification)` true; correct car title/text/icon; car importance HIGH; no shortcut ID; no message array/messaging-person extras; category null; BigText content matches phone message |
| `testPhoneTapAndCarTapHaveDifferentTargets` | Top-level `contentIntent` is an immutable activity pending intent targeting `MainActivity`; extender `contentIntent` is a mutable broadcast pending intent targeting the library wrapper, carrying the original `CopilotCarAppService` component |
| `testCarLaunchPendingIntentRemainsMutable` | Mutable flag set; immutable flag absent; stable request code `20003`; source extra `waypoint_alert` preserved |
| `testDismissActionsAndDeleteIntentsAreOrdinary` | One phone/car action titled Dismiss; no remote input; phone semantic action is not REPLY or MARK_AS_READ; phone/car delete intents point to ordinary dismiss; no activity started by dismissal |
| `testRepeatedPostingReplacesContentAndDoesNotSetOnlyAlertOnce` | Same alert ID; second title/message replace first; `FLAG_ONLY_ALERT_ONCE` absent; `FLAG_ONGOING_EVENT` absent |
| `testAlertKeepsTimeoutAndPublicVisibility` | `timeoutAfter == 15_000L`; visibility PUBLIC; AUTO_CANCEL present |
| `testDismissReceiverCancelsAlertButPreservesStatus` | ACTION_DISMISS removes alert(s); non-alert status notification remains |
| `testExperimentalChannelIsHighImportanceAndSilent` | Experimental channel HIGH; sound null; vibration retained |
| `testLegacyChannelConfigurationIsNotChanged` | Seed `copilot_alert_channel_v4` with distinct settings before engine construction; assert its importance/sound remain unchanged afterward |
| `testForegroundAndResumeNotificationsAreNotCarExtended` | Existing foreground/resume notifications do not gain car extensions, messaging, or the experimental alert channel |
| `testPostingAndDismissalDoNotMigrateTripPreferences` | Seed selected route/day, pause setting, and visited-progress preferences; posting/cancelling leaves those maps unchanged |

Avoid brittle exact `android.template` class-name assertions across SDKs; assert the relevant content and absence of messaging extras instead.

#### Pending-intent inspection details

Robolectric 4.11.1 exposes `shadowOf(pendingIntent).savedIntent`, `.flags`, `.requestCode`, `.isActivity`, `.isBroadcast`, and `.isImmutable`.

For this pinned projected implementation:

```text
Car wrapper component class:
androidx.car.app.notification.CarAppNotificationBroadcastReceiver

Original component extra key:
androidx.car.app.notification.COMPONENT_EXTRA_KEY
```

The second key is a private library implementation detail. It is acceptable to assert this literal in a version-specific regression test, with a comment tying it to 1.4.0. Do not import or reflect on the library's private constant in production code.

Use a fresh `Intent`/copy when manually invoking `NotificationReceiver.onReceive` in tests. Do not call the car launch pending intent's `.send()` and expect a car app to appear: host launch integration belongs in DHU/vehicle tests.

### 7.4 Descriptor and merged manifest checks

Add a resource test that reads `R.xml.automotive_app_desc` and checks the `uses` names are exactly `template`. Also inspect the **built merged/packaged manifest** in §8, since `Config.NONE` registration tests do not verify production manifest merging.

Required packaged state:

- Automotive descriptor metadata still references the resource.
- Car service remains exported with POI category and min car API 1.
- `NotificationReceiver` remains non-exported and handles the new ordinary action.
- Library internal car-notification receiver is present and non-exported.
- Location foreground-service type and permission declarations remain unchanged.

### 7.5 Cold and warm session tests

Create `app/src/test/java/com/roadtrip/copilot/CopilotCarSessionTest.kt` using the already included Car App testing library.

Basic lifecycle setup:

```kotlin
val testCarContext = TestCarContext.createCarContext(context)
val session = CopilotCarSession()
val controller = SessionController(session, testCarContext, Intent(Intent.ACTION_VIEW))
controller.moveToState(Lifecycle.State.CREATED)
```

At CREATED, `SessionController` calls `onCreateScreen` and pushes the returned screen. Use `TestScreenManager` to inspect it. Destroy the controller in teardown, and isolate existing static route/repository state using the project's existing testing seams if needed; do not add production reset APIs just for this test.

Test these two cases:

1. **Cold entry:** Seed a raw alert ID `2000` and non-alert ID `1001` using `NotificationManager`. Create the session. Assert alert removal, status preservation, and a dashboard screen on the stack. The raw alert avoids needing a second service-registration setup here.
2. **Warm entry:** Once a session exists, push `SettingsScreen(testCarContext)` using the test manager, seed another raw alert, and invoke `session.onNewIntent(...)`. Assert alert removal, status preservation, and that the existing Settings screen remains the stack's top. No new dashboard is pushed.

These tests cover callback behavior, not Android Auto's decision to call the callbacks. Existing dashboard initialization may load route state asynchronously; keep repository fixtures isolated and report fixture issues separately rather than changing route production code.

### 7.6 Service timer/audio behavior

Do not refactor the service/audio pipeline merely to introduce new mocks. Verify that these unchanged call sites remain intact by review and the manual matrix:

- `handleEvaluationResult`: cancel old timer, set active-alert state, post card, then speak.
- `testAlert`: same post/speech lifecycle.
- `handleSpeechFinished`: schedules existing 8-second dismissal.
- `stopCopilot` / `onDestroy`: cancel alerts.
- Receiver/session calls into the service's existing `cancelAlerts` method.

Where a practical existing test seam exists, add a focused test for cancelling a pending dismissal job. Otherwise label timer/audio integration as manually tested, not unit-proven. Do not use sleeps as evidence of OS timeout behavior in Robolectric.

---

## 8. Build and static verification

**Future stage; not authorized by the documentation request.**

### 8.1 Environment checks

Use the project's existing JDK/SDK setup, not upgrades:

```bash
java -version
./gradlew --version
```

The handbook specifies JDK 17. Respect current build configuration. If the environment fails before compiling changed code, report the prerequisite issue instead of changing SDK/dependency versions.

### 8.2 Future build/test commands

From repository root:

```bash
./gradlew :app:testDebugUnitTest --tests com.roadtrip.copilot.NotificationEngineTest --tests com.roadtrip.copilot.CopilotCarSessionTest
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
```

Optional after the above passes:

```bash
./gradlew :app:lintDebug
```

Record failures accurately. Do not delete or weaken unrelated failing tests. If baselining against the unchanged source is necessary, do it in an isolated source checkout/worktree without discarding user changes.

### 8.3 Diff and artifact checks

```bash
git diff --check
git diff --stat
git diff -- app/build.gradle.kts app/src/main/java/com/roadtrip/copilot/CopilotService.kt app/src/main/java/com/roadtrip/copilot/AudioDuckEngine.kt app/src/main/java/com/roadtrip/copilot/LocationTracker.kt app/src/main/java/com/roadtrip/copilot/model
```

The last command should show no experiment changes. Also confirm no route/assets/builder modifications, no dependency changes, no signing changes, and no version-code bump.

Inspect the generated merged manifest using the actual paths produced by this Gradle version (`app/build/intermediates/**/AndroidManifest.xml`); do not assume one hard-coded intermediate directory. For the packaged APK, use installed SDK tools such as `apkanalyzer manifest print` or `aapt2 dump xmltree` to verify both `AndroidManifest.xml` and `res/xml/automotive_app_desc.xml`.

Verify certificates with the existing SDK's `apksigner`, for both known-good and experiment:

```bash
apksigner verify --verbose --print-certs "$KNOWN_GOOD_APK"
apksigner verify --verbose --print-certs "$EXPERIMENT_APK"
```

If the tool is not on PATH, use the installed `$ANDROID_HOME/build-tools/<version>/apksigner`. The signer certificate SHA-256 digests must match. Version code and application ID must also match. A file SHA-256 is an artifact identifier, not a signing-certificate digest.

Copy the experimental APK out of `app/build/outputs/apk/debug/app-debug.apk` to its clearly named artifact path. Building another branch will overwrite that generic output; never use it as the only saved version.

Do not commit APKs, diagnostics containing phone data, or signing keys.

---

## 9. Phone installation and rollback

### 9.1 Explicit owner approval is required

An implementation request does not automatically authorize replacing the phone's pre-trip tested build. State what passed locally, what is unverified, and ask before installation.

Do not switch APKs during navigation or an active trip. Stop Co-Pilot through its normal UI, park safely, and disconnect Android Auto before replacing the app. Replacing an APK can stop its process/service; preserved progress does not mean uninterrupted tracking.

### 9.2 Data snapshot before replacement

Back up more than the APK. An APK does **not** contain imported routes or the current preferences/progress.

Storage used by the app:

- Internal imported routes: app `files/itineraries`.
- External imported routes: `/sdcard/Android/data/com.roadtrip.copilot/files/itineraries`.
- Shared preferences, including `copilot_prefs` and `copilot_location_prefs`.

With the normal service stopped and an owner-approved `ARTIFACT_DIR`, a debug build can usually be backed up with:

```bash
adb devices -l
adb shell dumpsys package com.roadtrip.copilot > "$ARTIFACT_DIR/package-before.txt"
adb exec-out run-as com.roadtrip.copilot tar -cf - shared_prefs files > "$ARTIFACT_DIR/internal-data-before.tar"
adb pull /sdcard/Android/data/com.roadtrip.copilot/files/itineraries "$ARTIFACT_DIR/external-itineraries-before"
tar -tf "$ARTIFACT_DIR/internal-data-before.tar"
```

These are examples for a **future authorized backup**, not commands already executed. Confirm `ARTIFACT_DIR` is a real approved directory first. If `run-as`/directory access fails, do not treat an empty/partial archive as a backup, root the phone, alter permissions, or proceed with an uninstall. Inspect existing directories read-only and obtain another backup method with the owner.

Do not automatically restore these files after every APK switch: doing so could overwrite legitimate settings/progress. The backup is protection, not a migration mechanism. Restoring data requires separate approval.

### 9.3 Install either version in place

With matching package ID/certificate and equal version code:

```bash
adb install -r "$EXPERIMENT_APK"
```

Rollback:

```bash
adb install -r "$KNOWN_GOOD_APK"
```

After each installation:

- Verify the exact artifact used and the new `lastUpdateTime`.
- Open the phone app and check selected route/day, imports, pause setting, notification/location permissions, and progress where visible.
- Confirm the expected old/new notification channel is used when an alert is tested.
- Restart the trip manually only when intended. Do not issue reset/import/start commands automatically.

If install returns `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, stop: likely certificate mismatch. If it returns a downgrade error, inspect actual version codes. Do not "solve" either failure by uninstalling, clearing storage, raising version codes repeatedly, or casually adding `-d`.

### 9.4 State that switching APKs does not roll back

The two APKs share application data by design. Switching code does not undo settings/progress changes made by the user while testing. The new channel remains as unused OS configuration after rollback, and the old channel remains available with its prior settings.

Android Auto can retain package indexing, launcher, or conversation state independently. First disconnect/reconnect and verify the new packaged descriptor. A host restart may be useful while parked, but only after capturing evidence and obtaining approval. Do not clear Android Auto's storage or the app's storage as an automatic fix.

---

## 10. DHU and real-car validation

### 10.1 Safety and setup

- The owner controls physical-car testing. Agents must not simulate movement or inject physical-device mock GPS without explicit authorization.
- No itinerary edits are required for the basic test. Do not create/import/replace a test route as a side effect.
- Do not test a new build on the real trip if there is no opportunity to validate and roll back beforehand.
- Android Auto unknown sources must remain enabled for sideloaded templates. Preserve current settings rather than changing multiple host controls during the same experiment.
- Keep a live log stream from before connecting through the reproduction. The phone's small circular buffers already lost useful evidence in the earlier investigation.

### 10.2 Phone-only checks, before projection

1. Launch the phone app and confirm routes/selected day/settings remain intact.
2. Use the existing **Test Alert** button while idle, once the service is bound. This exercises the same `NotificationEngine.postHeadsUpAlert` path without changing a route.
3. Confirm phone card text, silent notification behavior, TTS, and Dismiss.
4. Repeat to check that another alert is posted and spoken.
5. Let a card expire and confirm it is removed; check the logs for speech-grace/service cleanup reasons rather than assuming which mechanism removed it.

**Existing test-hook caveat:** `MainActivity` has an ADB `test_action=test_alert` hook, but if its service is not yet bound it may start tracking instead of posting the requested test alert. Prefer the visible button after binding, and do not send blind start/reset commands. Phone Test Alert is disabled when tracking is active; do not modify that policy for this experiment.

**Service-lifetime caveat:** Idle phone testing can use a bound-only `CopilotService`. Leaving the phone activity can destroy that service, which correctly cancels the notification. A card disappearing because of `service_destroyed` is not proof that Android Auto accepted/rejected it. Keep the phone activity visible for the initial idle test or use the existing car test action in an already-open idle car session. Validate the real foreground-drive path separately.

### 10.3 DHU matrix

Start the phone's Android Auto Head Unit Server, then use the existing script after authorization:

```bash
./scripts/run_dhu.sh
```

The script uses a wide layout when available and forwards port 5277. Do not modify it for this experiment. It projects the **same phone app**, so installing an experiment for DHU also replaces the phone build; approval/rollback safeguards still apply.

Perform the matrix below with Maps visible and media available. Use DHU's `help` output before assuming a console command exists. Driving restrictions can be exercised with `restrict all` if supported by the installed DHU. Do not claim that this models every BMW behavior.

### 10.4 Common manual matrix

| Case | Procedure | Expected result |
|---|---|---|
| First launch before alerts | Connect a fresh projection session; open Co-Pilot from app launcher | Dashboard and Settings accessible |
| Background without prior car UI | In a separate fresh connection, do not open Co-Pilot's car UI; trigger an idle phone Test Alert while keeping its bound service alive | HUN over Maps; no automatic switch to Co-Pilot UI |
| Explicit car notification tap | Trigger a card, tap its body in Android Auto | Existing car interface opens; `waypoint_alert` source appears in cold/warm entry logs |
| Phone notification tap | Tap the phone card separately | Phone `MainActivity`, not a car launch wrapper |
| Consecutive updates | Trigger two alerts within the active-notification interval, then another after dismissal | Correct latest text; each eligible alert produces a HUN; no accumulation |
| Dismiss | Use car Dismiss/close | Alert removed; Maps/foreground tracking unaffected |
| Clear all | Trigger alert; open notification center; Clear all; launch Co-Pilot | Car interface opens; ordinary dismiss logged if host invokes delete intent |
| Passive expiry | Trigger alert; do nothing; reopen Co-Pilot after speech/timeout | No stale message reader; car interface available |
| Warm entry from Settings | Open Settings, return to Maps, receive an alert, then reopen Co-Pilot | Existing Settings screen remains accessible; warm callback handles cleanup |
| Drive loop | Use an owner-approved existing test trip | Real alerts/TTS/pace remain correct while Maps stays navigator |
| Last real alert regression | Finish that trip; park; launch Co-Pilot; return to Maps; Clear all; launch again | Dashboard/settings rather than the last real alert's message reader |
| Stop/destroy | End trip normally; disconnect/reconnect | No orphan alert; routes/preferences persist |
| Rollback | Install saved known-good APK in place | Known-good trip/notification behavior and data preserved |

A UI that opens only because a notification explicitly targets the service is not enough. Test the **launcher icon** before/after alerts independently.

### 10.5 Vehicle-specific validation

At minimum, repeat in the owner's BMW:

1. Fresh parked connection: launcher baseline before any new alert.
2. Background alert over Maps without opening Co-Pilot's car UI first.
3. Card tap, Dismiss, Clear all, and repeated launcher opens.
4. A real existing test drive followed by the exact **last real alert → park → launcher → Maps → Clear all → launcher** sequence.
5. Reconnect and rollback check.

If the short parked test passes but the full drive cannot be performed before departure, report **partially tested**, not trip-ready. Leave/reinstall the exact known-good build for the real trip unless the owner explicitly accepts the risk.

---

## 11. Diagnostic collection and interpretation

### 11.1 Capture before resetting anything

Start an unfiltered live stream in a separate terminal before the reproduction, using a real approved diagnostics directory:

```bash
adb logcat -b main -b system -b events -v threadtime > "$DIAG_DIR/logcat-live.txt"
```

Stop it with Ctrl-C after the reproduction. Do not run `adb logcat -c`, reinstall, force-stop, clear notifications, or reset host state before collecting the failing-screen snapshot. If using agent tools, manage the long-running capture explicitly rather than leaving an unmanaged process.

While the unwanted screen or a missing-HUN condition is observable, collect:

```bash
adb shell dumpsys notification --noredact > "$DIAG_DIR/notifications.txt"
adb shell dumpsys activity services com.roadtrip.copilot > "$DIAG_DIR/copilot-services.txt"
adb shell dumpsys activity activities > "$DIAG_DIR/activities.txt"
adb shell dumpsys activity service com.google.android.projection.gearhead > "$DIAG_DIR/gearhead-service-detail.txt"
adb shell dumpsys package com.roadtrip.copilot > "$DIAG_DIR/copilot-package.txt"
adb shell dumpsys package com.google.android.projection.gearhead > "$DIAG_DIR/gearhead-package.txt"
adb shell getprop ro.build.fingerprint > "$DIAG_DIR/phone-build.txt"
```

Record APK hash, date/time of each tap, connected/disconnected status, Maps navigation status, alert title, and whether the car app had already been opened that session. Photograph the **car display** if possible. `adb exec-out screencap` normally captures the phone display, not the projected car screen.

`--noredact` dumps can contain private notifications and route/location-related text. Keep raw files local and ignored; redact before sharing publicly.

### 11.2 Useful log tags

```text
NotificationEngine
NotificationReceiver
CopilotService
AudioDuckEngine
CopilotCarAppService
CopilotCarSession
CarApp
CarApp.NBR
```

Use grep/filtering on the saved unfiltered stream. Do not assume one fixed Android Auto tag captures its complete launcher behavior.

### 11.3 Interpret evidence correctly

| Evidence | What it supports | What it does not establish |
|---|---|---|
| Local alert submitted, OS notification ID 2000 present, correct car extras | App generated and posted the intended payload | Android Auto accepted it or displayed a HUN |
| Phone alert exists but no car HUN | Host eligibility/policy, channel settings, or integration may be blocking projection | GPS/TTS failure or need to become a navigation app |
| `CarApp.NBR` missing expected extra after manual PI send | Launch wrapper lacked the host binder | Correctness of a real Android Auto notification tap |
| New session entry logs, then dashboard observed | Host entered our car session and rendered the interface | All future launcher launches are reliable |
| New session entry logs absent while message reader appears | Host may be selecting another experience | A definitive cause without host traces; cached state must be considered |
| No active OS alert while unwanted screen remains, captured while still connected | Strong evidence of host-retained UI/history rather than a live app notification | That the OEM alone caused it |
| No active OS alert after disconnection | Only post-disconnect notification state | What existed during the reproduction |
| Dismiss log after Clear all | Host sent our ordinary delete/action intent | Guaranteed erasure of host conversation/task history |
| Service destroyed during idle test | Existing service cleanup can explain card disappearance | Host eligibility of the foreground-drive scenario |

The earlier phone snapshot recorded Android Auto `17.7.663654-release` and an Android 17 Pixel 7 Pro. Capture fresh versions for future tests; do not upgrade/downgrade them during the initial A/B test unless separately agreed.

---

## 12. Failure handling and decision gates

### Gate A — Implementation/local readiness

Pass only when:

- The code uses the pinned APIs correctly.
- Focused and full relevant unit suites pass, or unrelated baseline failures are clearly documented.
- Built descriptor/manifest and signatures are verified.
- Protected driving/data files are unchanged.
- Known-good APK/data backup and rollback artifacts exist.

Status at this gate: **experiment built, vehicle behavior unverified**. Do not merge to main or install automatically.

### Gate B — Projection viability

Test on DHU after owner-approved installation. If ordinary alerts never project:

1. Confirm correct APK/descriptor, permission/channel importance, non-ongoing state, car extensions, and library receiver.
2. Confirm the test service was alive long enough and the app actually posted.
3. Capture host diagnostics.
4. Stop rather than converting the app into a navigator or re-enabling messaging as an implicit fallback.

The experiment can fail because of real host policy; compiling successfully does not entitle us to force eligibility.

### Gate C — Vehicle viability

Both alert delivery and launcher access must pass the vehicle matrix, including real foreground-trip alerts and post-trip launch/Clear all behavior. DHU-only success is not sufficient because the original issue did not reproduce there.

If settings work but waypoint HUNs fail, this is **not** a successful replacement. Preserve the tested messaging build.

If HUNs work but launcher ambiguity remains, capture a connected failing-screen snapshot before resetting. Verify the installed template-only descriptor and distinguish cached old host state from newly generated ordinary alerts. Do not assert one cause prematurely.

### Gate D — Promotion

Only with owner approval after successful vehicle testing:

- Review the branch diff and test evidence.
- Update branch documentation with measured results, not guesses.
- Decide separately whether to merge/release.

If adequate validation cannot happen before the real trip, leave the known-good APK installed. The experiment can remain on its branch indefinitely.

### Explicitly deferred alternatives

These require a new design decision and are **not** authorized substitutions:

- A separate Co-Pilot Controls package to isolate settings from message-app classification.
- Notification-only operation with phone settings.
- Changes to navigation category/provider behavior.
- Dependency/SDK upgrades to chase host compatibility.
- A custom screen/third dashboard tile or media impersonation.
- A runtime feature toggle that tries to switch automotive capabilities without reinstalling a different descriptor.

The fallback preference is to preserve reliable trip alerts over pursuing unverified in-car settings immediately before departure.

---

## 13. Implementing-agent checklist and handoff

### 13.1 Ordered checklist

- [ ] Read this entire plan and the repository handbook; understand which §2C details are intentionally changed only on the experiment branch.
- [ ] Confirm new authorization for implementation/build; retain a separate explicit installation gate.
- [ ] Inspect worktree state; choose and record source base without discarding user work.
- [ ] Preserve/verify the exact known-good installed APK; do not mislabel a fresh main build.
- [ ] Create the experiment branch or approved isolated worktree.
- [ ] Make the descriptor template-only while retaining POI metadata.
- [ ] Add the isolated experimental channel without deleting/touching legacy channels.
- [ ] Replace only waypoint alert construction/posting with the 1.4.0 API blueprint.
- [ ] Keep car launch PI mutable; keep phone/dismiss PIs immutable and explicit.
- [ ] Add ordinary dismiss while preserving legacy receiver actions.
- [ ] Add cold/warm session diagnostics and warm cleanup without resetting screen navigation.
- [ ] Fix Robolectric's test-service registration, not production validation.
- [ ] Preserve old tests and add payload/intents/channel/descriptor/session tests.
- [ ] Update branch-local handbook/README with experimental status.
- [ ] Run approved local tests/build; inspect packaged manifest/descriptor and signing certificate.
- [ ] Inspect final diff for forbidden changes and route edits.
- [ ] Save clearly named experiment APK with provenance; generic build output is not a backup.
- [ ] Stop and report before installing unless the owner has explicitly approved replacement.
- [ ] With installation approval, snapshot data and use in-place `adb install -r` only.
- [ ] Capture live diagnostics and perform phone/DHU checks, then owner-controlled vehicle checks.
- [ ] Require both working HUNs over Maps and reliable launcher/settings access.
- [ ] Restore the saved tested APK if validation fails or remains incomplete before the trip.
- [ ] Do not merge/publish without the owner's separate approval.

### 13.2 What to report back

Keep the implementation handoff factual:

```text
Branch and base commit:
Changed files:
Protected source/data paths confirmed unchanged:
Tests/build commands and results:
Manifest/descriptor/certificate verification:
Known-good APK path + SHA-256:
Experimental APK path + SHA-256:
Installed on phone? (yes/no, explicit authorization):
Phone/DHU/vehicle cases actually performed:
Cases not performed:
Current phone APK / rollback status:
Unresolved eligibility or launcher questions:
Recommendation: retain experiment / investigate / restore known-good / request promotion review.
```

Do not say "Android Auto fixed" when only unit tests passed. Do not silently leave the experimental APK installed if the owner expects the known-good build for the real trip.

### 13.3 Short reusable implementation prompt

> Implement `docs/tasks/carapp_notification_experiment_implementation_plan.md` on a separate experiment branch, preserving the known-good installed APK, all routes/preferences/progress compatibility, and all GPS/audio behavior. Follow the pinned AndroidX 1.4.0 signatures, ordinary notification payload, mutable car-launch pending intent, immutable phone/dismiss intents, and test setup described in the plan. Do not make Co-Pilot a navigation provider. Do not install, reset phone/Android Auto state, or merge to main without explicit approval. If local build/test execution is not included in the new authorization, stop before running Gradle. Report any blocker rather than broadening scope or silently falling back to messaging.

---

**Planning-task completion boundary:** Only this new Markdown plan was added to the repository. Source code, route files, branch state, installed APK, app data, and Android Auto state were not changed. Pinned source artifacts were downloaded to `/tmp/opencode` for read-only API research. No Gradle task, APK build, installation, or runtime test was performed.
