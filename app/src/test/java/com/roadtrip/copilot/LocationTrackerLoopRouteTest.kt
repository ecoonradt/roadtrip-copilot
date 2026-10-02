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
            id = "origin_home",
            name = "271 State Street",
            lat = 42.65260,
            lng = -73.75620,
            type = "origin",
            triggerRadiusMiles = 0.3,
            offsetMinutesFromStart = 0,
            notification = CheckpointNotification(
                title = "State Street Departure",
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
            id = "dest_home",
            name = "Home (State Street)",
            lat = 42.7160,
            lng = -73.7870,
            type = "destination",
            triggerRadiusMiles = 0.5,
            offsetMinutesFromStart = 15,
            notification = CheckpointNotification(
                title = "Arriving Home",
                message = "Test loop complete!",
                speech = "Approaching final destination. You have returned home."
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

        // Step 1: Parked in driveway at Origin (lat: 42.65260, lng: -73.75620)
        tracker.evaluate(42.65260, -73.75620, 0.0)

        assertNotNull(lastResult)
        // Checkpoint 0 should trigger
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("origin_home", lastResult!!.alerts[0].id)
        assertTrue("Speech should be departure speech", lastResult!!.alerts[0].speech.contains("departure"))

        // Next checkpoint MUST be Cumberland Farms, NOT Home
        assertEquals("cumberland_farms", lastResult!!.nextCheckpoint?.id)

        // Step 2: Driving down State Street (0.2 miles from home, still within 0.5 mi of destination)
        tracker.evaluate(42.7250, -73.7240, 30.0)

        // Destination must NOT have triggered
        assertTrue("No alert should trigger mid-street near home", lastResult!!.alerts.isEmpty())
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
        assertEquals("dest_home", lastResult!!.nextCheckpoint?.id)

        // Step 6: Returning Home
        tracker.evaluate(42.7160, -73.7870, 5.0)
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("dest_home", lastResult!!.alerts[0].id)
        assertTrue(lastResult!!.alerts[0].speech.contains("returned home"))
        assertNull("All waypoints visited", lastResult!!.nextCheckpoint)
    }

    @Test
    fun testLoopRouteAllowsSkippingIntermediateStop() {
        val tracker = LocationTracker(context) { result ->
            lastResult = result
        }

        tracker.setCheckpoints(loopCheckpoints, System.currentTimeMillis())

        // Start at driveway
        tracker.evaluate(42.65260, -73.75620, 0.0)
        assertEquals("cumberland_farms", lastResult!!.nextCheckpoint?.id)

        // Visit Cumberland Farms
        tracker.evaluate(42.7402, -73.7355, 15.0)
        assertEquals("haswell_rd", lastResult!!.nextCheckpoint?.id)

        // Visit Haswell Road
        tracker.evaluate(42.7473, -73.7204, 30.0)
        assertEquals("boght_rd", lastResult!!.nextCheckpoint?.id)

        // Skip Boght Road and drive directly Home
        tracker.evaluate(42.7160, -73.7870, 10.0)
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("dest_home", lastResult!!.alerts[0].id)
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
                name = "Home Departure",
                lat = 42.65260,
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
        tracker.evaluate(42.65260, -73.7870, 0.0)
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
                name = "Home Departure",
                lat = 42.65260,
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
        tracker.evaluate(42.65260, -73.7870, 0.0)
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
                name = "Home Departure",
                lat = 42.65260,
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
        tracker.evaluate(42.65260, -73.7870, 0.0)
        assertEquals(1, lastResult!!.alerts.size)

        // 2. Arriving at legacy untyped milestone
        tracker.evaluate(42.7500, -73.7300, 10.0)
        // Legacy untyped milestone must preserve fallback announcement behavior
        assertEquals(1, lastResult!!.alerts.size)
        assertEquals("legacy_scenic", lastResult!!.alerts[0].id)
        assertTrue(lastResult!!.alerts[0].speech.contains("Approaching Scenic Overlook"))
        assertEquals("destination_end", lastResult!!.nextCheckpoint?.id)
    }
}
