package com.roadtrip.copilot

import com.roadtrip.copilot.model.AssetProvider
import com.roadtrip.copilot.model.RouteOption
import com.roadtrip.copilot.model.RouteRepository
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class RouteRepositoryTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private lateinit var primaryStorageDir: File
    private lateinit var secondaryStorageDir: File
    private lateinit var fileAssetProvider: AssetProvider

    @Before
    fun setUp() {
        primaryStorageDir = tempFolder.newFolder("internal_itineraries")
        secondaryStorageDir = tempFolder.newFolder("external_itineraries")

        // AssetProvider that opens files from src/main/assets in unit test JVM environment
        fileAssetProvider = AssetProvider { fileName ->
            val file = File("src/main/assets", fileName)
            if (file.exists()) file.inputStream() else null
        }
    }

    /**
     * Scenario 1: Asset Fallback
     * When filesDir / itineraries is empty, repository returns all 6 bundled asset route options
     * in the exact specified order:
     * 1. "Return Run: Nassau to Albany" (test_itinerary_return.json, day 1)
     * 2. "Test Run: Albany to Nassau" (test_itinerary.json, day 1)
     * 3. Day 1: Red Rock Entry & Oak Creek Canyon Switchbacks (itinerary.json, day 1)
     * 4. Day 2: High Desert, Shiprock & Chama Valley (itinerary.json, day 2)
     * 5. Day 3: Brazos Pass to Taos High Road (itinerary.json, day 3)
     * 6. Day 4: Taos Plaza & High Road into Santa Fe (itinerary.json, day 4)
     */
    @Test
    fun testScenario1_AssetFallbackWhenStorageEmpty() = runBlocking {
        assertTrue("Primary storage must be empty initially", primaryStorageDir.listFiles()?.isEmpty() == true)

        val repository = RouteRepository(
            storageDir = primaryStorageDir,
            assetProvider = fileAssetProvider
        )

        val routes = repository.refreshRoutes()

        assertEquals("Should return exactly 6 bundled asset route options", 6, routes.size)

        // 1. Return Run
        assertEquals("Return Run: Nassau to Albany", routes[0].title)
        assertEquals("test_itinerary_return.json", routes[0].routeFile)
        assertEquals(1, routes[0].dayNumber)
        assertTrue(routes[0].isAsset)
        assertNull(routes[0].absolutePath)

        // 2. Test Run
        assertEquals("Test Run: Albany to Nassau", routes[1].title)
        assertEquals("test_itinerary.json", routes[1].routeFile)
        assertEquals(1, routes[1].dayNumber)
        assertTrue(routes[1].isAsset)
        assertNull(routes[1].absolutePath)

        // 3. Day 1
        assertEquals("Day 1: Red Rock Entry & Oak Creek Canyon Switchbacks", routes[2].title)
        assertEquals("itinerary.json", routes[2].routeFile)
        assertEquals(1, routes[2].dayNumber)
        assertTrue(routes[2].isAsset)
        assertNull(routes[2].absolutePath)

        // 4. Day 2
        assertEquals("Day 2: High Desert, Shiprock & Chama Valley", routes[3].title)
        assertEquals("itinerary.json", routes[3].routeFile)
        assertEquals(2, routes[3].dayNumber)
        assertTrue(routes[3].isAsset)

        // 5. Day 3
        assertEquals("Day 3: Brazos Pass to Taos High Road", routes[4].title)
        assertEquals("itinerary.json", routes[4].routeFile)
        assertEquals(3, routes[4].dayNumber)
        assertTrue(routes[4].isAsset)

        // 6. Day 4
        assertEquals("Day 4: Taos Plaza & High Road into Santa Fe", routes[5].title)
        assertEquals("itinerary.json", routes[5].routeFile)
        assertEquals(4, routes[5].dayNumber)
        assertTrue(routes[5].isAsset)

        // Verify getRouteOptions() matches
        assertEquals(routes, repository.getRouteOptions())
        assertEquals(routes, repository.routes.value)

        // Verify loadItinerary successfully loads asset files
        val itReturn = repository.loadItinerary(routes[0])
        assertNotNull(itReturn)
        assertEquals("Return Run: Nassau to Albany", itReturn?.tripName)
        assertEquals(5, itReturn?.getCheckpointsForDay(1)?.size)

        val itFull = repository.loadItinerary(routes[2])
        assertNotNull(itFull)
        assertEquals("Phoenix to Albuquerque Road Trip", itFull?.tripName)
        assertEquals(4, itFull?.days?.size)

        // Also test resilience when AssetProvider is unavailable/null:
        // Must still fallback to all 6 permanent defaults!
        val nullAssetRepo = RouteRepository(
            storageDir = primaryStorageDir,
            assetProvider = AssetProvider { null }
        )
        val fallbackRoutes = nullAssetRepo.refreshRoutes()
        assertEquals(6, fallbackRoutes.size)
        assertEquals("Return Run: Nassau to Albany", fallbackRoutes[0].title)
        assertEquals("Day 1: Red Rock Entry & Oak Creek Canyon Switchbacks", fallbackRoutes[2].title)
    }

    /**
     * Scenario 2: Dynamic Ingestion
     * Placing a valid custom itinerary in filesDir / itineraries dynamically populates in the route list.
     */
    @Test
    fun testScenario2_DynamicIngestionOfCustomItinerary() = runBlocking {
        val repository = RouteRepository(
            storageDir = primaryStorageDir,
            assetProvider = fileAssetProvider
        )

        // Initially 6 routes
        assertEquals(6, repository.refreshRoutes().size)

        // Ingest a custom single-route itinerary
        val customJson = """
            {
              "trip_name": "Moab Scenic Red Rock Byway",
              "date": "2026-10-15",
              "timezone": "America/Denver",
              "checkpoints": [
                {
                  "id": "moab_center",
                  "name": "Moab Downtown",
                  "lat": 38.5733,
                  "lng": -109.5498,
                  "trigger_radius_miles": 0.5,
                  "offset_minutes_from_start": 0
                },
                {
                  "id": "arches_turn",
                  "name": "Arches NP Junction",
                  "lat": 38.6166,
                  "lng": -109.5798,
                  "trigger_radius_miles": 1.5,
                  "offset_minutes_from_start": 15
                }
              ]
            }
        """.trimIndent()

        val customFile = File(primaryStorageDir, "moab_trip.json")
        customFile.writeText(customJson)

        val updatedRoutes = repository.refreshRoutes()
        assertEquals("Route list should grow from 6 to 7", 7, updatedRoutes.size)

        val customOption = updatedRoutes.find { it.routeFile == "moab_trip.json" }
        assertNotNull("Custom route must be found in route options", customOption)
        assertEquals("Moab Scenic Red Rock Byway", customOption?.title)
        assertEquals(1, customOption?.dayNumber)
        assertFalse(customOption!!.isAsset)
        assertEquals(customFile.absolutePath, customOption.absolutePath)
        assertEquals("2 checkpoints", customOption.subtitle)

        // Load itinerary from custom file
        val loadedItinerary = repository.loadItinerary(customOption)
        assertNotNull(loadedItinerary)
        assertEquals("Moab Scenic Red Rock Byway", loadedItinerary?.tripName)

        // Resolve checkpoints
        val resolvedCheckpoints = repository.resolveCheckpoints(customOption, tripStartTimeMillis = 1700000000000L)
        assertEquals(2, resolvedCheckpoints.size)
        assertEquals(1700000000000L, resolvedCheckpoints[0].targetEpochMillis)
        assertEquals(1700000000000L + (15 * 60_000L), resolvedCheckpoints[1].targetEpochMillis)

        // StateFlow emission check
        assertEquals(7, repository.routes.value.size)

        // Delete custom file and verify refresh drops it
        customFile.delete()
        val afterDeleteRoutes = repository.refreshRoutes()
        assertEquals(6, afterDeleteRoutes.size)
        assertNull(afterDeleteRoutes.find { it.routeFile == "moab_trip.json" })
    }

    /**
     * Scenario 3: Corrupted File Resilience
     * Corrupted or malformed JSON files in filesDir / itineraries are logged and gracefully skipped
     * without throwing exceptions or crashing the app.
     */
    @Test
    fun testScenario3_CorruptedFileResilience() = runBlocking {
        val repository = RouteRepository(
            storageDir = primaryStorageDir,
            assetProvider = fileAssetProvider
        )

        // Place a malformed JSON file
        val corruptedFile = File(primaryStorageDir, "corrupted_syntax.json")
        corruptedFile.writeText("{ \"trip_name\": \"Broken Trip\", \"checkpoints\": [ { invalid json")

        // Place an empty 0-byte file
        val emptyFile = File(primaryStorageDir, "empty.json")
        emptyFile.writeText("")

        // Place a JSON file with valid syntax but empty structure (no days, no checkpoints)
        val nonTripFile = File(primaryStorageDir, "random.json")
        nonTripFile.writeText("{ \"arbitrary_key\": 12345 }")

        // Place a valid custom itinerary alongside the bad files
        val validFile = File(primaryStorageDir, "valid_custom.json")
        validFile.writeText("""
            {
              "trip_name": "Valid Custom Trip",
              "checkpoints": [
                {
                  "id": "cp1",
                  "name": "Start",
                  "lat": 40.0,
                  "lng": -74.0,
                  "offset_minutes_from_start": 0
                }
              ]
            }
        """.trimIndent())

        // Track log events
        val loggedEvents = mutableListOf<String>()
        repository.logListener = { level, tag, msg, _ ->
            loggedEvents.add("[$level] $tag: $msg")
        }

        // Must NOT throw any exception
        val routes = repository.refreshRoutes()

        // Verify corrupted file was logged
        assertTrue(
            "Should have logged an error for corrupted JSON",
            loggedEvents.any { it.contains("ERROR") && it.contains("corrupted_syntax.json") }
        )
        // Verify empty file was logged
        assertTrue(
            "Should have logged a warning for empty file",
            loggedEvents.any { it.contains("WARN") && it.contains("empty.json") }
        )

        // The 3 bad files must be skipped, valid_custom.json ingested + 6 bundled = 7 routes
        assertEquals(7, routes.size)
        assertNull(routes.find { it.routeFile == "corrupted_syntax.json" })
        assertNull(routes.find { it.routeFile == "empty.json" })
        assertNull(routes.find { it.routeFile == "random.json" })
        assertNotNull(routes.find { it.routeFile == "valid_custom.json" })

        // Loading a non-existent or corrupted file should return null without crashing
        val corruptedOption = RouteOption(
            title = "Corrupted",
            routeFile = "corrupted_syntax.json",
            dayNumber = 1,
            isAsset = false,
            absolutePath = corruptedFile.absolutePath
        )
        val loaded = repository.loadItinerary(corruptedOption)
        assertNull("Loading a corrupted itinerary file must safely return null", loaded)

        val nonExistentOption = RouteOption(
            title = "Missing",
            routeFile = "does_not_exist.json",
            dayNumber = 1,
            isAsset = false
        )
        val loadedMissing = repository.loadItinerary(nonExistentOption)
        assertNull("Loading a non-existent file must safely return null", loadedMissing)
    }

    /**
     * Scenario 4: Multi-Day vs. Single Route
     * Correctly parses and resolves both multi-day itineraries (days array) and ad-hoc single-route itineraries (checkpoints array).
     */
    @Test
    fun testScenario4_MultiDayVsSingleRouteParsingAndResolution() = runBlocking {
        val repository = RouteRepository(
            storageDir = primaryStorageDir,
            assetProvider = fileAssetProvider
        )

        // 1. Create a 3-day multi-day itinerary
        val multiDayJson = """
            {
              "trip_name": "Southwest Canyon Loop",
              "dates": {
                "start": "2026-11-01",
                "end": "2026-11-03"
              },
              "days": [
                {
                  "day": 1,
                  "date": "2026-11-01",
                  "timezone": "America/Phoenix",
                  "title": "Phoenix to Sedona",
                  "origin": "Phoenix Sky Harbor",
                  "destination": "Sedona, AZ",
                  "checkpoints": [
                    { "id": "d1_c1", "name": "PHX Terminal", "lat": 33.4357, "lng": -112.0152, "target_time": "09:00:00" },
                    { "id": "d1_c2", "name": "Bell Rock", "lat": 34.8010, "lng": -111.7645, "target_time": "11:30:00" }
                  ]
                },
                {
                  "day": 2,
                  "date": "2026-11-02",
                  "timezone": "America/Phoenix",
                  "title": "Sedona to Grand Canyon",
                  "origin": "Sedona, AZ",
                  "destination": "South Rim",
                  "checkpoints": [
                    { "id": "d2_c1", "name": "Oak Creek Overlook", "lat": 35.0345, "lng": -111.7330, "target_time": "08:30:00" },
                    { "id": "d2_c2", "name": "Flagstaff Downtown", "lat": 35.1983, "lng": -111.6513, "target_time": "10:00:00" },
                    { "id": "d2_c3", "name": "Mather Point", "lat": 36.0570, "lng": -112.1130, "target_time": "13:00:00" }
                  ]
                },
                {
                  "day": 3,
                  "date": "2026-11-03",
                  "timezone": "America/Denver",
                  "title": "Grand Canyon to Monument Valley",
                  "origin": "South Rim",
                  "destination": "Monument Valley, UT",
                  "checkpoints": [
                    { "id": "d3_c1", "name": "Desert View Watchtower", "lat": 36.0428, "lng": -111.8262, "target_time": "10:00:00" }
                  ]
                }
              ]
            }
        """.trimIndent()
        File(primaryStorageDir, "multi_day.json").writeText(multiDayJson)

        // 2. Create an ad-hoc single-route itinerary (checkpoints array only, no days)
        val singleRouteJson = """
            {
              "trip_name": "Albany Quick Test Loop",
              "date": "2026-09-10",
              "timezone": "America/New_York",
              "checkpoints": [
                { "id": "alb_start", "name": "Albany Plaza", "lat": 42.6526, "lng": -73.7562, "offset_minutes_from_start": 0 },
                { "id": "alb_mid", "name": "Washington Park", "lat": 42.6580, "lng": -73.7690, "offset_minutes_from_start": 10 },
                { "id": "alb_end", "name": "Troy Bridge", "lat": 42.7284, "lng": -73.6918, "offset_minutes_from_start": 25 }
              ]
            }
        """.trimIndent()
        File(primaryStorageDir, "single_run.json").writeText(singleRouteJson)

        val routes = repository.refreshRoutes()

        // 3 multi-day options + 1 single route option + 6 bundled asset options = 10 options
        assertEquals(10, routes.size)

        // Verify multi-day options
        val multiDayOptions = routes.filter { it.routeFile == "multi_day.json" }
        assertEquals("Multi-day itinerary must generate exactly 3 RouteOptions", 3, multiDayOptions.size)

        val day1 = multiDayOptions[0]
        assertEquals("Day 1: Phoenix to Sedona", day1.title)
        assertEquals(1, day1.dayNumber)
        assertFalse(day1.isAsset)

        val day2 = multiDayOptions[1]
        assertEquals("Day 2: Sedona to Grand Canyon", day2.title)
        assertEquals(2, day2.dayNumber)
        assertFalse(day2.isAsset)

        val day3 = multiDayOptions[2]
        assertEquals("Day 3: Grand Canyon to Monument Valley", day3.title)
        assertEquals(3, day3.dayNumber)
        assertFalse(day3.isAsset)

        // Verify checkpoints resolution for each day in multi-day
        val d1Cps = repository.resolveCheckpoints(day1)
        assertEquals(2, d1Cps.size)
        assertEquals("d1_c1", d1Cps[0].id)
        assertNotNull(d1Cps[0].targetEpochMillis)

        val d2Cps = repository.resolveCheckpoints(day2)
        assertEquals(3, d2Cps.size)
        assertEquals("d2_c1", d2Cps[0].id)

        val d3Cps = repository.resolveCheckpoints(day3)
        assertEquals(1, d3Cps.size)
        assertEquals("d3_c1", d3Cps[0].id)

        // Verify single-route option
        val singleOption = routes.find { it.routeFile == "single_run.json" }
        assertNotNull("Single route must generate a RouteOption", singleOption)
        assertEquals("Albany Quick Test Loop", singleOption?.title)
        assertEquals(1, singleOption?.dayNumber)
        assertFalse(singleOption!!.isAsset)

        // Verify checkpoints resolution for single route
        val singleCps = repository.resolveCheckpoints(singleOption, tripStartTimeMillis = 1000000L)
        assertEquals(3, singleCps.size)
        assertEquals("alb_start", singleCps[0].id)
        assertEquals(1000000L, singleCps[0].targetEpochMillis)
        assertEquals(1000000L + (10 * 60_000L), singleCps[1].targetEpochMillis)
        assertEquals(1000000L + (25 * 60_000L), singleCps[2].targetEpochMillis)
    }

    /**
     * Additional Invariant: Save and Delete Itinerary
     * Validates saving/importing new itineraries into internal storage and deleting custom files.
     */
    @Test
    fun testSaveAndDeleteItinerary() = runBlocking {
        val repository = RouteRepository(
            storageDir = primaryStorageDir,
            assetProvider = fileAssetProvider
        )

        val json = """
            {
              "trip_name": "Saved Trip Test",
              "checkpoints": [
                { "id": "s1", "name": "Stop 1", "lat": 30.0, "lng": -90.0, "offset_minutes_from_start": 0 }
              ]
            }
        """.trimIndent()

        val savedOption = repository.saveItinerary("saved_trip.json", json)
        assertNotNull("saveItinerary must return the new RouteOption", savedOption)
        assertEquals("Saved Trip Test", savedOption?.title)

        val fileOnDisk = File(primaryStorageDir, "saved_trip.json")
        assertTrue("File must exist on disk", fileOnDisk.exists())

        // Try deleting bundled asset -> must return false
        val assetOption = repository.getRouteOptions().first { it.isAsset }
        val assetDeleted = repository.deleteItinerary(assetOption)
        assertFalse("Cannot delete bundled asset", assetDeleted)

        // Delete custom route
        val customDeleted = repository.deleteItinerary(savedOption!!)
        assertTrue("Custom itinerary should be deleted successfully", customDeleted)
        assertFalse("File must no longer exist on disk", fileOnDisk.exists())
        assertNull(repository.getRouteOptions().find { it.routeFile == "saved_trip.json" })
    }

    /**
     * Additional Invariant: Multiple Storage Directories & Deduplication
     * Ensures scanning across both internal and external storage works without duplicating files.
     */
    @Test
    fun testMultipleStorageDirectoriesDeduplication() = runBlocking {
        val json1 = """
            {
              "trip_name": "Route From Internal",
              "checkpoints": [{ "id": "c1", "name": "C1", "lat": 1.0, "lng": 2.0 }]
            }
        """.trimIndent()

        val json2 = """
            {
              "trip_name": "Route From External",
              "checkpoints": [{ "id": "c2", "name": "C2", "lat": 3.0, "lng": 4.0 }]
            }
        """.trimIndent()

        // Place unique files
        File(primaryStorageDir, "internal_route.json").writeText(json1)
        File(secondaryStorageDir, "external_route.json").writeText(json2)

        // Place duplicate in secondary
        File(secondaryStorageDir, "internal_route.json").writeText(json1)

        val repository = RouteRepository(
            storageDirs = listOf(primaryStorageDir, secondaryStorageDir),
            assetProvider = fileAssetProvider
        )

        val routes = repository.refreshRoutes()

        val matchingInternal = routes.filter { it.routeFile == "internal_route.json" }
        assertEquals("Duplicate filename across directories should be deduplicated", 1, matchingInternal.size)

        assertNotNull("External route must be present", routes.find { it.routeFile == "external_route.json" })
    }

    /**
     * Additional Invariant: Unicode & Diacritics Preservation
     * Road trips through New Mexico / Southwest feature Spanish & Native American names with diacritics.
     */
    @Test
    fun testUnicodeAndDiacriticsPreservation() = runBlocking {
        val json = """
            {
              "trip_name": "Pueblos of New Mexico: Peñasco & Chimayó",
              "days": [
                {
                  "day": 1,
                  "title": "Ruta Escénica: San José a Cañoncito",
                  "checkpoints": [
                    { "id": "p1", "name": "Santuario de Chimayó", "lat": 35.987, "lng": -105.928 }
                  ]
                }
              ]
            }
        """.trimIndent()

        File(primaryStorageDir, "pueblos.json").writeText(json, Charsets.UTF_8)

        val repository = RouteRepository(
            storageDir = primaryStorageDir,
            assetProvider = fileAssetProvider
        )

        val routes = repository.refreshRoutes()
        val puebloOption = routes.find { it.routeFile == "pueblos.json" }

        assertNotNull(puebloOption)
        assertEquals("Day 1: Ruta Escénica: San José a Cañoncito", puebloOption?.title)
        assertEquals("Pueblos of New Mexico: Peñasco & Chimayó", puebloOption?.subtitle)
    }

    /**
     * Additional Invariant: RouteOption Spinner formatting
     * toString() must return title for ArrayAdapter compatibility in MainActivity spinner.
     */
    @Test
    fun testRouteOptionToStringReturnsTitle() {
        val option = RouteOption(
            title = "Day 1: Red Rock Entry & Oak Creek Canyon Switchbacks",
            routeFile = "itinerary.json",
            dayNumber = 1
        )
        assertEquals("Day 1: Red Rock Entry & Oak Creek Canyon Switchbacks", option.toString())
    }
}
