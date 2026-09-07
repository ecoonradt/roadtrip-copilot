package com.roadtrip.copilot

import com.google.gson.Gson
import com.roadtrip.copilot.model.Itinerary
import com.roadtrip.copilot.model.ScheduleDelta
import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

class ItineraryTest {

    private fun haversineMiles(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val r = 3958.8
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val a = sin(dLat / 2.0).pow(2.0) +
                cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) *
                sin(dLon / 2.0).pow(2.0)
        val c = 2.0 * atan2(sqrt(a), sqrt(1.0 - a))
        return r * c
    }

    @Test
    fun testParseFullItinerary() {
        val file = File("src/main/assets/itinerary.json")
        assertTrue("itinerary.json must exist in assets", file.exists())

        val itinerary = Gson().fromJson(file.readText(), Itinerary::class.java)
        assertEquals("Phoenix to Albuquerque Road Trip", itinerary.tripName)
        assertNotNull(itinerary.days)
        assertEquals(4, itinerary.days!!.size)

        for (day in 1..4) {
            val checkpoints = itinerary.getCheckpointsForDay(day)
            assertTrue("Day $day should have checkpoints", checkpoints.isNotEmpty())
            for (cp in checkpoints) {
                assertTrue("Trigger radius must be positive", cp.triggerRadiusMiles > 0)
                assertNotNull("Checkpoint name should not be null", cp.name)
            }
        }
    }

    @Test
    fun testParseTestItinerary() {
        val file = File("src/main/assets/test_itinerary.json")
        assertTrue("test_itinerary.json must exist in assets", file.exists())

        val itinerary = Gson().fromJson(file.readText(), Itinerary::class.java)
        assertEquals("Test Run: Albany to Nassau", itinerary.tripName)

        val checkpoints = itinerary.getCheckpointsForDay(1)
        assertEquals(5, checkpoints.size)
        assertEquals("depart_Albany", checkpoints[0].id)
        assertEquals("Schenectady_arrival", checkpoints[4].id)
    }

    @Test
    fun testParseReturnItinerary() {
        val file = File("src/main/assets/test_itinerary_return.json")
        assertTrue("test_itinerary_return.json must exist in assets", file.exists())

        val itinerary = Gson().fromJson(file.readText(), Itinerary::class.java)
        assertEquals("Return Run: Nassau to Albany", itinerary.tripName)

        val checkpoints = itinerary.getCheckpointsForDay(1)
        assertEquals(5, checkpoints.size)
        assertEquals("depart_nassau", checkpoints[0].id)
        assertEquals("Albany_arrival", checkpoints[4].id)
    }

    @Test
    fun testHaversineDistanceAccuracy() {
        // Empire State Plaza Departure
        val lat1 = 42.65260
        val lon1 = -73.75620

        // Nassau Destination
        val lat2 = 42.81450
        val lon2 = -73.94050

        val distance = haversineMiles(lat1, lon1, lat2, lon2)
        // Straight line distance between Albany and Nassau is ~15.5 miles
        assertTrue("Straight-line distance should be ~15.5 miles", distance in 15.0..16.0)
    }

    @Test
    fun testFixedItineraryResolutionAndPace() {
        val file = File("src/main/assets/itinerary.json")
        assertTrue("itinerary.json must exist in assets", file.exists())

        val itinerary = Gson().fromJson(file.readText(), Itinerary::class.java)
        val dummyStart = System.currentTimeMillis()
        val checkpoints = itinerary.resolveCheckpointsForDay(1, dummyStart)

        val phxPickup = checkpoints.first { it.id == "phx_rental_pickup" }
        assertNotNull("phx_rental_pickup targetEpochMillis must not be null", phxPickup.targetEpochMillis)

        // Verify exact target epoch for Day 1: 2026-10-09 14:30:00 America/Phoenix (UTC-7)
        val expectedZdt = ZonedDateTime.of(2026, 10, 9, 14, 30, 0, 0, ZoneId.of("America/Phoenix"))
        val expectedEpoch = expectedZdt.toInstant().toEpochMilli()
        assertEquals(expectedEpoch, phxPickup.targetEpochMillis)

        // Simulate evaluation on September 7, 2026 at 10:00 AM EDT
        val testNow = ZonedDateTime.of(2026, 9, 7, 10, 0, 0, 0, ZoneId.of("America/New_York")).toInstant().toEpochMilli()
        val delta = ScheduleDelta.fromDeltaMillis(phxPickup.targetEpochMillis!! - testNow)

        assertTrue("Delta should be ahead", delta.isAhead)
        // 32 days = 46080 minutes
        assertTrue("Delta minutes should be around 32 days ahead", delta.deltaMinutes > 40000)
        assertTrue("Status text should mention days ahead", delta.statusText.contains("days") && delta.statusText.contains("ahead"))
    }

    @Test
    fun testAdHocItineraryResolutionAndArrival() {
        val file = File("src/main/assets/test_itinerary_return.json")
        assertTrue("test_itinerary_return.json must exist in assets", file.exists())

        val itinerary = Gson().fromJson(file.readText(), Itinerary::class.java)
        val tripStartTime = 1700000000000L // arbitrary fixed test epoch
        val checkpoints = itinerary.resolveCheckpointsForDay(1, tripStartTime)

        // 1. Departure Checkpoint at T=0
        val departCp = checkpoints.first { it.id == "depart_nassau" }
        assertEquals(tripStartTime, departCp.targetEpochMillis)

        // At driveway when trip begins (now == tripStartTime)
        val drivewayDelta = ScheduleDelta.fromDeltaMillis(departCp.targetEpochMillis!! - tripStartTime)
        assertEquals(0, drivewayDelta.deltaMinutes)
        assertEquals("On schedule", drivewayDelta.statusText)
        assertEquals(" You are on schedule.", drivewayDelta.formatForSpeech())

        // 2. Arrival Checkpoint (offset 31 minutes)
        val arrivalCp = checkpoints.first { it.id == "Albany_arrival" }
        val expectedArrivalTarget = tripStartTime + (31 * 60_000L)
        assertEquals(expectedArrivalTarget, arrivalCp.targetEpochMillis)

        // Drive actually took 23 minutes (arrived at tripStartTime + 23 min)
        val actualArrivalNow = tripStartTime + (23 * 60_000L)
        val arrivalDelta = ScheduleDelta.fromDeltaMillis(arrivalCp.targetEpochMillis!! - actualArrivalNow)
        assertEquals(8, arrivalDelta.deltaMinutes)
        assertTrue(arrivalDelta.isAhead)
        assertEquals("8 min ahead of schedule", arrivalDelta.statusText)
        assertEquals(" You are currently 8 minutes ahead of schedule.", arrivalDelta.formatForSpeech())
    }

    @Test
    fun testScheduleDeltaScales() {
        // Exact on schedule
        val onSchedule = ScheduleDelta.fromDeltaMillis(0L)
        assertEquals("On schedule", onSchedule.statusText)

        // 1 min behind -> considered on schedule threshold
        val oneMinBehind = ScheduleDelta.fromDeltaMillis(-50_000L)
        assertEquals("On schedule", oneMinBehind.statusText)

        // 14 min ahead
        val fourteenAhead = ScheduleDelta.fromDeltaMillis(14 * 60_000L)
        assertEquals("14 min ahead of schedule", fourteenAhead.statusText)
        assertEquals(" You are currently 14 minutes ahead of schedule.", fourteenAhead.formatForSpeech())

        // 10 min behind
        val tenBehind = ScheduleDelta.fromDeltaMillis(-10 * 60_000L)
        assertEquals("10 min behind schedule", tenBehind.statusText)
        assertEquals(" You are currently 10 minutes behind schedule.", tenBehind.formatForSpeech())

        // 2 hr 15 min ahead
        val twoHoursAhead = ScheduleDelta.fromDeltaMillis((2 * 60 + 15) * 60_000L)
        assertEquals("2 hr 15 min ahead of schedule", twoHoursAhead.statusText)
        assertEquals(" You are currently 2 hours and 15 minutes ahead of schedule.", twoHoursAhead.formatForSpeech())

        // 32 days ahead
        val thirtyTwoDaysAhead = ScheduleDelta.fromDeltaMillis(32L * 24 * 60 * 60_000L)
        assertTrue(thirtyTwoDaysAhead.statusText.startsWith("32 days"))
    }
}
