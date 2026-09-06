package com.roadtrip.copilot

import com.google.gson.Gson
import com.roadtrip.copilot.model.Itinerary
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
}
