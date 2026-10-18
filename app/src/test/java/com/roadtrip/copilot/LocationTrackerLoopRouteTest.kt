package com.roadtrip.copilot

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.roadtrip.copilot.model.Checkpoint
import com.roadtrip.copilot.model.CheckpointNotification
import com.roadtrip.copilot.model.EvaluationResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class LocationTrackerLoopRouteTest {

    private lateinit var context: Context
    private var lastResult: EvaluationResult? = null

    private val loopCheckpoints = listOf(
        Checkpoint(
            id = "origin_park",
            name = "The Crossings of Colonie",
            lat = 42.7160,
            lng = -73.7870,
            type = "origin",
            triggerRadiusMiles = 0.3,
            offsetMinutesFromStart = 0,
            notification = CheckpointNotification(
                title = "The Crossings Departure",
                message = "Ready to begin your scenic drive.",
                speech = "Welcome to your road trip departure point."
            )
        ),
        Checkpoint(
            id = "cumberland_farms",
            name = "Cumberland Farms (Fuel)",
            lat = 42.7402,
            lng = -73.7355,
            type = "fuel",
            triggerRadiusMiles = 0.5,
            offsetMinutesFromStart = 2,
            notification = CheckpointNotification(
                title = "Cumberland Farms Fuel",
                message = "Approaching fuel stop.",
                speech = "Approaching Cumberland Farms for fuel stop."
            )
        ),
        Checkpoint(
            id = "haswell_rd",
            name = "Haswell Road Scenic Drive-By",
            lat = 42.7473,
            lng = -73.7204,
            type = "scenic_drive_by",
            triggerRadiusMiles = 0.4,
            offsetMinutesFromStart = 13,
            notification = CheckpointNotification(
                title = "Haswell Road Drive-By",
                message = "In-transit audio commentary.",
                speech = "Now cruising along Haswell Road."
            )
        ),
        Checkpoint(
            id = "boght_rd",
            name = "Boght Road Route Anchor",
            lat = 42.7365,
            lng = -73.7129,
            type = "scenic_drive_by",
            triggerRadiusMiles = 0.4,
            offsetMinutesFromStart = 14,
            notification = CheckpointNotification(
                title = "Boght Road Anchor",
                message = "Steering loop back toward home.",
                speech = "Passing Boght Road route anchor."
            )
        ),
        Checkpoint(
            id = "dest_park",
            name = "The Crossings of Colonie",
            lat = 42.7160,
            lng = -73.7870,
            type = "destination",
            triggerRadiusMiles = 0.5,
            offsetMinutesFromStart = 15,
            notification = CheckpointNotification(
                title = "Arriving at The Crossings",
                message = "Test loop complete!",
                speech = "Approaching final destination. You have returned to the park."
            )
        )
    )

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        lastResult = null
    }

    @Test
    fun testLoopRouteDoesNotTriggerDestinationAtStart() {
        val tracker = LocationTracker(context) { result ->
            lastResult = result
        }

        val startTime = System.currentTimeMillis()
        tracker.setCheckpoints(loopCheckpoints, startTime)

        // Step 1: Parked at Origin (lat: 42.7160, lng: -73.7870)
        tracker.evaluate(42.7160, -73.7870, 0.0)

        assertNotNull(lastResult)
        // Checkpoint 0 should trigger
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("origin_park", lastResult!!.alerts[0].id)
        assertTrue("Speech should be departure speech", lastResult!!.alerts[0].speech.contains("departure"))

        // Next checkpoint MUST be Cumberland Farms, NOT Destination
        assertEquals("cumberland_farms", lastResult!!.nextCheckpoint?.id)

        // Step 2: Driving down park road (0.11 miles from origin, still within 0.5 mi of destination)
        tracker.evaluate(42.7175, -73.7860, 30.0)

        // Destination must NOT have triggered
        assertTrue("No alert should trigger mid-street near park", lastResult!!.alerts.isEmpty())
        assertEquals("cumberland_farms", lastResult!!.nextCheckpoint?.id)

        // Step 3: Arriving at Cumberland Farms
        tracker.evaluate(42.7402, -73.7355, 15.0)
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("cumberland_farms", lastResult!!.alerts[0].id)
        assertEquals("haswell_rd", lastResult!!.nextCheckpoint?.id)

        // Step 4: Arriving at Haswell Road
        tracker.evaluate(42.7473, -73.7204, 30.0)
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("haswell_rd", lastResult!!.alerts[0].id)
        assertEquals("boght_rd", lastResult!!.nextCheckpoint?.id)

        // Step 5: Arriving at Boght Road
        tracker.evaluate(42.7365, -73.7129, 25.0)
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("boght_rd", lastResult!!.alerts[0].id)
        assertEquals("dest_park", lastResult!!.nextCheckpoint?.id)

        // Step 6: Returning to The Crossings
        tracker.evaluate(42.7160, -73.7870, 5.0)
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("dest_park", lastResult!!.alerts[0].id)
        assertTrue(lastResult!!.alerts[0].speech.contains("returned"))
        assertNull("All waypoints visited", lastResult!!.nextCheckpoint)
    }

    @Test
    fun testLoopRouteAllowsSkippingIntermediateStop() {
        val tracker = LocationTracker(context) { result ->
            lastResult = result
        }

        tracker.setCheckpoints(loopCheckpoints, System.currentTimeMillis())

        // Start at park origin
        tracker.evaluate(42.7160, -73.7870, 0.0)
        assertEquals("cumberland_farms", lastResult!!.nextCheckpoint?.id)

        // Visit Cumberland Farms
        tracker.evaluate(42.7402, -73.7355, 15.0)
        assertEquals("haswell_rd", lastResult!!.nextCheckpoint?.id)

        // Visit Haswell Road
        tracker.evaluate(42.7473, -73.7204, 30.0)
        assertEquals("boght_rd", lastResult!!.nextCheckpoint?.id)

        // Skip Boght Road and drive directly back to Park
        tracker.evaluate(42.7160, -73.7870, 10.0)
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("dest_park", lastResult!!.alerts[0].id)
        assertNull("All waypoints completed after skip", lastResult!!.nextCheckpoint)
    }

    @Test
    fun testGenericStopIsSilentAndUpdatesPaceAndMilestones() {
        val tracker = LocationTracker(context) { result ->
            lastResult = result
        }

        val routeWithGenericStop = listOf(
            Checkpoint(
                id = "origin_start",
                name = "Park Departure",
                lat = 42.7160,
                lng = -73.7870,
                type = "origin",
                triggerRadiusMiles = 0.3,
                offsetMinutesFromStart = 0,
                notification = CheckpointNotification(
                    title = "Starting Trip",
                    message = "Departing now.",
                    speech = "Starting your trip."
                )
            ),
            Checkpoint(
                id = "grocery_errand",
                name = "Trader Joe's Grocery Stop",
                lat = 42.7400,
                lng = -73.7350,
                type = "stop",
                dwellMinutes = 20,
                triggerRadiusMiles = 0.5,
                offsetMinutesFromStart = 10,
                notification = null // Silent generic stop
            ),
            Checkpoint(
                id = "fuel_stop",
                name = "Shell Station",
                lat = 42.7600,
                lng = -73.7250,
                type = "fuel",
                dwellMinutes = 10,
                triggerRadiusMiles = 0.5,
                offsetMinutesFromStart = 30,
                notification = CheckpointNotification(
                    title = "Fuel Stop",
                    message = "Shell Station refuel.",
                    speech = "Approaching Shell Station for refuel."
                )
            ),
            Checkpoint(
                id = "destination_end",
                name = "Weekend Cabin",
                lat = 42.7800,
                lng = -73.7100,
                type = "destination",
                triggerRadiusMiles = 0.5,
                offsetMinutesFromStart = 45,
                notification = CheckpointNotification(
                    title = "Arrived at Cabin",
                    message = "Trip complete.",
                    speech = "Welcome to your cabin."
                )
            )
        )

        val startTime = System.currentTimeMillis()
        tracker.setCheckpoints(routeWithGenericStop, startTime)

        // 1. Departure triggers origin alert
        tracker.evaluate(42.7160, -73.7870, 0.0)
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("origin_start", lastResult!!.alerts[0].id)
        assertEquals("grocery_errand", lastResult!!.nextCheckpoint?.id)

        // 2. Arriving at grocery errand (type = "stop")
        tracker.evaluate(42.7400, -73.7350, 10.0)
        // MUST be completely silent: zero alerts generated!
        assertTrue("Generic stop must NOT produce any in-car alerts", lastResult!!.alerts.isEmpty())
        // Next checkpoint must advance to the fuel station
        assertEquals("fuel_stop", lastResult!!.nextCheckpoint?.id)
        // Schedule pace telemetry delta must still be resolved and tracked
        assertNotNull("Pace telemetry must still be recorded for silent stops", lastResult!!.scheduleDelta)

        // 3. Arriving at fuel stop (type = "fuel", configured notification)
        tracker.evaluate(42.7600, -73.7250, 10.0)
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("fuel_stop", lastResult!!.alerts[0].id)
        assertTrue(lastResult!!.alerts[0].speech.contains("Approaching Shell Station for refuel."))
        assertEquals("destination_end", lastResult!!.nextCheckpoint?.id)

        // 4. Arriving at destination triggers destination alert
        tracker.evaluate(42.7800, -73.7100, 10.0)
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("destination_end", lastResult!!.alerts[0].id)
        assertNull("All stops completed", lastResult!!.nextCheckpoint)
    }

    @Test
    fun testClearedAlertWaypointIsSilentAndAdvancesNextCheckpoint() {
        val tracker = LocationTracker(context) { result ->
            lastResult = result
        }

        val routeWithClearedStop = listOf(
            Checkpoint(
                id = "origin_start",
                name = "Park Departure",
                lat = 42.7160,
                lng = -73.7870,
                type = "origin",
                triggerRadiusMiles = 0.3,
                offsetMinutesFromStart = 0,
                notification = CheckpointNotification("Start", "Departing", "Starting trip.")
            ),
            Checkpoint(
                id = "lunch_stop",
                name = "Lumberyard Brewing Co",
                lat = 42.7500,
                lng = -73.7300,
                type = "meal",
                dwellMinutes = 45,
                triggerRadiusMiles = 0.5,
                offsetMinutesFromStart = 20,
                notification = null // User explicitly cleared alert in Route Builder Studio
            ),
            Checkpoint(
                id = "destination_end",
                name = "Cabin",
                lat = 42.7800,
                lng = -73.7100,
                type = "destination",
                triggerRadiusMiles = 0.5,
                offsetMinutesFromStart = 75,
                notification = CheckpointNotification("Destination", "Arrived", "Welcome to cabin.")
            )
        )

        val startTime = System.currentTimeMillis()
        tracker.setCheckpoints(routeWithClearedStop, startTime)

        // 1. Departure triggers origin alert
        tracker.evaluate(42.7160, -73.7870, 0.0)
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("origin_start", lastResult!!.alerts[0].id)

        // 2. Arriving at lunch stop where alert was cleared
        tracker.evaluate(42.7500, -73.7300, 10.0)
        // MUST be completely silent: user cleared notifications so no audio ducking or speech!
        assertTrue("Cleared alert waypoint must NOT produce any in-car alerts", lastResult!!.alerts.isEmpty())
        // Next checkpoint must advance to the destination
        assertEquals("destination_end", lastResult!!.nextCheckpoint?.id)
        assertNotNull("Pace telemetry must still be tracked", lastResult!!.scheduleDelta)

        // 3. Arriving at destination triggers destination alert
        tracker.evaluate(42.7800, -73.7100, 10.0)
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("destination_end", lastResult!!.alerts[0].id)
        assertNull("All stops completed", lastResult!!.nextCheckpoint)
    }

    @Test
    fun testLegacyUntypedWaypointPreservesFallbackAlert() {
        val tracker = LocationTracker(context) { result ->
            lastResult = result
        }

        val legacyRoute = listOf(
            Checkpoint(
                id = "origin_start",
                name = "Park Departure",
                lat = 42.7160,
                lng = -73.7870,
                triggerRadiusMiles = 0.3,
                offsetMinutesFromStart = 0,
                notification = CheckpointNotification("Start", "Departing", "Starting trip.")
            ),
            Checkpoint(
                id = "legacy_scenic",
                name = "Scenic Overlook",
                lat = 42.7500,
                lng = -73.7300,
                type = null, // Legacy untyped milestone
                triggerRadiusMiles = 0.5,
                offsetMinutesFromStart = 20,
                notification = null // Legacy without explicit notification
            ),
            Checkpoint(
                id = "destination_end",
                name = "Cabin",
                lat = 42.7800,
                lng = -73.7100,
                triggerRadiusMiles = 0.5,
                offsetMinutesFromStart = 40,
                notification = CheckpointNotification("Destination", "Arrived", "Welcome to cabin.")
            )
        )

        val startTime = System.currentTimeMillis()
        tracker.setCheckpoints(legacyRoute, startTime)

        // 1. Departure triggers origin alert
        tracker.evaluate(42.7160, -73.7870, 0.0)
        assertEquals(1, lastResult!!.alerts.size)

        // 2. Arriving at legacy untyped milestone
        tracker.evaluate(42.7500, -73.7300, 10.0)
        // Legacy untyped milestone must preserve fallback announcement behavior
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("legacy_scenic", lastResult!!.alerts[0].id)
        assertTrue(lastResult!!.alerts[0].speech.contains("Approaching Scenic Overlook"))
        assertEquals("destination_end", lastResult!!.nextCheckpoint?.id)
    }

    @Test
    fun testBlankSpeechNotificationFallsBackToApproachingName() {
        val tracker = LocationTracker(context) { result ->
            lastResult = result
        }

        val routeWithBlankSpeech = listOf(
            Checkpoint(
                id = "origin_start",
                name = "Park",
                lat = 42.7160,
                lng = -73.7870,
                type = "origin",
                triggerRadiusMiles = 0.3,
                offsetMinutesFromStart = 0,
                notification = CheckpointNotification("Start", "Departing", "Starting trip.")
            ),
            Checkpoint(
                id = "scenic_blank_speech",
                name = "Lookout Point",
                lat = 42.7500,
                lng = -73.7300,
                type = "scenic_pull_off",
                triggerRadiusMiles = 0.5,
                offsetMinutesFromStart = 20,
                notification = CheckpointNotification("Lookout Point", "Scenic view ahead", "") // Blank speech
            )
        )

        val startTime = System.currentTimeMillis()
        tracker.setCheckpoints(routeWithBlankSpeech, startTime)

        // 1. Departure
        tracker.evaluate(42.7160, -73.7870, 0.0)

        // 2. Arriving at lookout point
        tracker.evaluate(42.7500, -73.7300, 10.0)
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("scenic_blank_speech", lastResult!!.alerts[0].id)
        assertTrue(lastResult!!.alerts[0].speech.contains("Approaching Lookout Point"))
    }

    @Test
    fun testSkipTwoConsecutiveWaypointsProgression() {
        val tracker = LocationTracker(context) { result ->
            lastResult = result
        }

        tracker.setCheckpoints(loopCheckpoints, System.currentTimeMillis())

        // 1. Departure at origin
        tracker.evaluate(42.7160, -73.7870, 0.0)
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("origin_park", lastResult!!.alerts[0].id)
        assertEquals("cumberland_farms", lastResult!!.nextCheckpoint?.id)

        // 2. Driver skips BOTH Cumberland Farms (stop 1) AND Haswell Road (stop 2),
        // and arrives directly at Boght Road (stop 3).
        tracker.evaluate(42.7365, -73.7129, 25.0)

        // Boght Road must trigger successfully even after skipping 2 consecutive stops!
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("boght_rd", lastResult!!.alerts[0].id)
        // Next checkpoint must now be destination
        assertEquals("dest_park", lastResult!!.nextCheckpoint?.id)
    }

    @Test
    fun testVisitedCheckpointsPersistenceAcrossInstances() {
        val routeId = "test_persisted_route_day_1"
        val tracker1 = LocationTracker(context) { result ->
            lastResult = result
        }
        tracker1.clearVisitedState(routeId)

        val startTime = System.currentTimeMillis()
        tracker1.setCheckpoints(loopCheckpoints, startTime, routeIdentifier = routeId)

        // Start and visit Cumberland Farms
        tracker1.evaluate(42.7160, -73.7870, 0.0)
        tracker1.evaluate(42.7402, -73.7355, 15.0)
        assertEquals("haswell_rd", lastResult!!.nextCheckpoint?.id)

        // Now simulate service restart / new tracker instance
        val tracker2 = LocationTracker(context) { result ->
            lastResult = result
        }
        tracker2.setCheckpoints(loopCheckpoints, startTime, routeIdentifier = routeId, restorePersisted = true)

        // Tracker2 should restore that origin_park and cumberland_farms are already visited
        assertEquals("haswell_rd", lastResult!!.nextCheckpoint?.id)
        assertEquals("In Progress", lastResult!!.scheduleDelta?.statusText)

        tracker1.clearVisitedState(routeId)
    }

    @Test
    fun testReRunningCompletedRouteAutoResets() {
        val routeId = "test_completed_route_run"
        val tracker = LocationTracker(context) { result ->
            lastResult = result
        }
        tracker.clearVisitedState(routeId)

        val startTime = System.currentTimeMillis()
        tracker.setCheckpoints(loopCheckpoints, startTime, routeIdentifier = routeId)

        // Complete the entire route: origin -> cumberland -> haswell -> boght -> dest
        tracker.evaluate(42.7160, -73.7870, 0.0) // origin
        tracker.evaluate(42.7402, -73.7355, 15.0)    // cumberland
        tracker.evaluate(42.7483, -73.7274, 25.0)    // haswell
        tracker.evaluate(42.7365, -73.7129, 25.0)    // boght
        tracker.evaluate(42.7160, -73.7870, 0.0) // dest

        // Now all checkpoints are visited
        assertNull(lastResult!!.nextCheckpoint)

        // Simulate re-running the route later (e.g. mock test or driving the loop again)
        val secondTracker = LocationTracker(context) { result ->
            lastResult = result
        }
        secondTracker.setCheckpoints(loopCheckpoints, System.currentTimeMillis(), routeIdentifier = routeId, restorePersisted = true)

        // Should have auto-reset because all checkpoints were previously visited!
        assertEquals("origin_park", lastResult!!.nextCheckpoint?.id)
        assertEquals("Awaiting Departure", lastResult!!.scheduleDelta?.statusText)

        secondTracker.clearVisitedState(routeId)
    }

    @Test
    fun testExpiredVisitedStateClearsAutomatically() {
        val routeId = "test_expired_route_run"
        val prefs = context.getSharedPreferences("copilot_location_prefs", Context.MODE_PRIVATE)

        // Write a visited set with timestamp 13 hours in the past
        val thirteenHoursAgo = System.currentTimeMillis() - (13 * 60 * 60 * 1000L)
        prefs.edit()
            .putStringSet("visited_$routeId", setOf("origin_park", "cumberland_farms"))
            .putLong("visited_${routeId}_ts", thirteenHoursAgo)
            .apply()

        val tracker = LocationTracker(context) { result ->
            lastResult = result
        }
        tracker.setCheckpoints(loopCheckpoints, System.currentTimeMillis(), routeIdentifier = routeId, restorePersisted = true)

        // Expired visited state must be cleared: starts fresh at origin_park
        assertEquals("origin_park", lastResult!!.nextCheckpoint?.id)
        assertEquals("Awaiting Departure", lastResult!!.scheduleDelta?.statusText)

        tracker.clearVisitedState(routeId)
    }

    @Test
    fun testResetProgressExplicitCall() {
        val routeId = "test_reset_progress_call"
        val tracker = LocationTracker(context) { result ->
            lastResult = result
        }
        tracker.clearVisitedState(routeId)

        tracker.setCheckpoints(loopCheckpoints, System.currentTimeMillis(), routeIdentifier = routeId)
        tracker.evaluate(42.7160, -73.7870, 0.0) // origin
        tracker.evaluate(42.7402, -73.7355, 15.0)    // cumberland

        assertEquals("haswell_rd", lastResult!!.nextCheckpoint?.id)

        // Explicitly reset progress
        tracker.resetProgress()

        assertEquals("origin_park", lastResult!!.nextCheckpoint?.id)
        assertEquals("Awaiting Departure", lastResult!!.scheduleDelta?.statusText)

        tracker.clearVisitedState(routeId)
    }
}
