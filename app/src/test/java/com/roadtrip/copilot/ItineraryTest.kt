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
    fun testParseSampleItinerary() {
        val file = File("src/main/assets/sample_itinerary.json")
        assertTrue("sample_itinerary.json must exist in assets", file.exists())

        val itinerary = Gson().fromJson(file.readText(), Itinerary::class.java)
        assertEquals("Scenic Southwest: Phoenix to Flagstaff", itinerary.tripName)
        assertNotNull(itinerary.days)
        assertEquals(1, itinerary.days!!.size)

        val checkpoints = itinerary.getCheckpointsForDay(1)
        assertEquals(4, checkpoints.size)
        assertEquals("phx_rental_pickup", checkpoints[0].id)
        assertEquals("flagstaff_arrival", checkpoints[3].id)
        for (cp in checkpoints) {
            assertTrue("Trigger radius must be positive", cp.triggerRadiusMiles > 0)
            assertNotNull("Checkpoint name should not be null", cp.name)
        }
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
        val file = File("src/main/assets/sample_itinerary.json")
        assertTrue("sample_itinerary.json must exist in assets", file.exists())

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
        val adHocJson = """
        {
          "trip_name": "Ad-Hoc Test Route",
          "date": "2026-09-06",
          "timezone": "America/New_York",
          "checkpoints": [
            {
              "id": "depart_test",
              "name": "Departure Point",
              "offset_minutes_from_start": 0,
              "trigger_radius_miles": 0.5
            },
            {
              "id": "arrival_test",
              "name": "Arrival Point",
              "offset_minutes_from_start": 31,
              "trigger_radius_miles": 0.5
            }
          ]
        }
        """.trimIndent()

        val itinerary = Gson().fromJson(adHocJson, Itinerary::class.java)
        val tripStartTime = 1700000000000L // arbitrary fixed test epoch
        val checkpoints = itinerary.resolveCheckpointsForDay(1, tripStartTime)

        // 1. Departure Checkpoint at T=0
        val departCp = checkpoints.first { it.id == "depart_test" }
        assertEquals(tripStartTime, departCp.targetEpochMillis)

        // At driveway when trip begins (now == tripStartTime)
        val drivewayDelta = ScheduleDelta.fromDeltaMillis(departCp.targetEpochMillis!! - tripStartTime)
        assertEquals(0, drivewayDelta.deltaMinutes)
        assertEquals("On schedule", drivewayDelta.statusText)
        assertEquals(" You are on schedule.", drivewayDelta.formatForSpeech())

        // 2. Arrival Checkpoint (offset 31 minutes)
        val arrivalCp = checkpoints.first { it.id == "arrival_test" }
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

    @Test
    fun testExportedJsonSchemaCompatibility() {
        // Sample Multi-Day Itinerary v2 exported from Route Builder
        val multiDayJson = """
        {
          "trip_name": "Phoenix to Albuquerque Road Trip v2",
          "dates": {
            "start": "2026-10-09",
            "end": "2026-10-12"
          },
          "metadata": {
            "version": "2.0.0",
            "author": "Roadtrip Co-Pilot Route Builder",
            "created_at": "2026-09-10T12:00:00.000Z"
          },
          "days": [
            {
              "day": 1,
              "date": "2026-10-09",
              "timezone": "America/Phoenix",
              "title": "Day 1: Red Rock Entry & Oak Creek Switchbacks",
              "origin": "PHX Rental Car Facility",
              "destination": "Little America Hotel Flagstaff",
              "departure_time": "14:30:00",
              "checkpoints": [
                {
                  "id": "wp_phx_rental",
                  "name": "PHX Rental Car Facility",
                  "type": "origin",
                  "lat": 33.4357,
                  "lng": -112.0152,
                  "target_time": "14:30:00",
                  "dwell_minutes": 0,
                  "trigger_radius_miles": 0.5,
                  "notification": {
                    "title": "Road Trip Begins!",
                    "message": "Departing PHX via I-17 N towards Sedona.",
                    "speech": "Welcome to Arizona. We are departing Phoenix heading north on I-17 toward Sedona."
                  }
                },
                {
                  "id": "wp_sedona_bell_rock",
                  "name": "Sedona Red Rock Vistas (Bell Rock)",
                  "type": "scenic_pull_off",
                  "lat": 34.801,
                  "lng": -111.7645,
                  "target_time": "16:30:00",
                  "dwell_minutes": 30,
                  "trigger_radius_miles": 3.0,
                  "notification": {
                    "title": "Approaching Sedona Red Rocks",
                    "message": "Target arrival: 4:30 PM. Recommended 30-min stop for red rock vistas.",
                    "speech": "Approaching Sedona on Highway 179. Pull-offs for Bell Rock and Courthouse Butte coming up in two miles."
                  }
                }
              ]
            }
          ]
        }
        """.trimIndent()

        val multiDayItinerary = Gson().fromJson(multiDayJson, Itinerary::class.java)
        assertEquals("Phoenix to Albuquerque Road Trip v2", multiDayItinerary.tripName)
        assertNotNull(multiDayItinerary.days)
        assertEquals(1, multiDayItinerary.days!!.size)

        val day1 = multiDayItinerary.days!![0]
        assertEquals(1, day1.day)
        assertEquals("2026-10-09", day1.date)
        assertEquals("America/Phoenix", day1.timezone)
        assertEquals("Day 1: Red Rock Entry & Oak Creek Switchbacks", day1.title)
        assertEquals("PHX Rental Car Facility", day1.origin)
        assertEquals("Little America Hotel Flagstaff", day1.destination)
        assertEquals(2, day1.checkpoints.size)

        val cp0 = day1.checkpoints[0]
        assertEquals("wp_phx_rental", cp0.id)
        assertEquals("PHX Rental Car Facility", cp0.name)
        assertEquals("origin", cp0.type)
        assertEquals(33.4357, cp0.lat, 0.000001)
        assertEquals(-112.0152, cp0.lng, 0.000001)
        assertEquals("14:30:00", cp0.targetTime)
        assertEquals(0, cp0.dwellMinutes)
        assertEquals(0.5, cp0.triggerRadiusMiles, 0.001)
        assertNotNull(cp0.notification)
        assertEquals("Road Trip Begins!", cp0.notification!!.title)
        assertEquals("Departing PHX via I-17 N towards Sedona.", cp0.notification!!.message)
        assertEquals("Welcome to Arizona. We are departing Phoenix heading north on I-17 toward Sedona.", cp0.notification!!.speech)

        val cp1 = day1.checkpoints[1]
        assertEquals("wp_sedona_bell_rock", cp1.id)
        assertEquals("scenic_pull_off", cp1.type)
        assertEquals(30, cp1.dwellMinutes)
        assertEquals(3.0, cp1.triggerRadiusMiles, 0.001)

        // Verify epoch resolution
        val resolvedCheckpoints = multiDayItinerary.resolveCheckpointsForDay(1, System.currentTimeMillis())
        assertEquals(2, resolvedCheckpoints.size)

        val expectedZdt0 = ZonedDateTime.of(2026, 10, 9, 14, 30, 0, 0, ZoneId.of("America/Phoenix"))
        val expectedEpoch0 = expectedZdt0.toInstant().toEpochMilli()
        assertEquals(expectedEpoch0, resolvedCheckpoints[0].targetEpochMillis)

        val expectedZdt1 = ZonedDateTime.of(2026, 10, 9, 16, 30, 0, 0, ZoneId.of("America/Phoenix"))
        val expectedEpoch1 = expectedZdt1.toInstant().toEpochMilli()
        assertEquals(expectedEpoch1, resolvedCheckpoints[1].targetEpochMillis)

        // Sample Single-Route Itinerary exported from Route Builder
        val singleRouteJson = """
        {
          "trip_name": "Albany to Nassau Single Route Test",
          "date": "2026-10-09",
          "timezone": "America/New_York",
          "metadata": {
            "version": "2.0.0",
            "author": "Roadtrip Co-Pilot Route Builder",
            "created_at": "2026-09-10T12:00:00.000Z"
          },
          "origin": "Departure: Empire State Plaza",
          "destination": "Destination: Nassau Proctors Theatre",
          "checkpoints": [
            {
              "id": "cp_Albany",
              "name": "Departure: Empire State Plaza",
              "type": "origin",
              "lat": 42.65260,
              "lng": -73.75620,
              "offset_minutes_from_start": 0,
              "dwell_minutes": 0,
              "trigger_radius_miles": 0.5,
              "notification": {
                "title": "Departure",
                "message": "Leaving Albany",
                "speech": "Test route started."
              }
            },
            {
              "id": "cp_nassau",
              "name": "Destination: Nassau Proctors Theatre",
              "type": "destination",
              "lat": 42.81450,
              "lng": -73.94050,
              "offset_minutes_from_start": 30,
              "dwell_minutes": 15,
              "trigger_radius_miles": 1.0,
              "notification": {
                "title": "Arrival",
                "message": "Welcome to Nassau",
                "speech": "Arrived at destination."
              }
            }
          ]
        }
        """.trimIndent()

        val singleRouteItinerary = Gson().fromJson(singleRouteJson, Itinerary::class.java)
        assertEquals("Albany to Nassau Single Route Test", singleRouteItinerary.tripName)
        assertNotNull(singleRouteItinerary.checkpoints)
        assertEquals(2, singleRouteItinerary.checkpoints!!.size)

        val singleCp0 = singleRouteItinerary.checkpoints!![0]
        assertEquals("cp_Albany", singleCp0.id)
        assertEquals("origin", singleCp0.type)
        assertEquals(0, singleCp0.dwellMinutes)
        assertEquals(0, singleCp0.offsetMinutesFromStart)
        assertEquals(0.5, singleCp0.triggerRadiusMiles, 0.001)

        val singleCp1 = singleRouteItinerary.checkpoints!![1]
        assertEquals("cp_nassau", singleCp1.id)
        assertEquals("destination", singleCp1.type)
        assertEquals(15, singleCp1.dwellMinutes)
        assertEquals(30, singleCp1.offsetMinutesFromStart)
        assertEquals(1.0, singleCp1.triggerRadiusMiles, 0.001)

        val testStartTime = 1700000000000L
        val resolvedSingle = singleRouteItinerary.resolveCheckpointsForDay(1, testStartTime)
        assertEquals(2, resolvedSingle.size)
        assertEquals(testStartTime, resolvedSingle[0].targetEpochMillis)
        assertEquals(testStartTime + 30 * 60_000L, resolvedSingle[1].targetEpochMillis)
    }
}
