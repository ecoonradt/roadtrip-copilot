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
     * Scenario 1: Empty Storage Initialization
     * When filesDir / itineraries is empty, repository returns an empty list of route options.
     */
    @Test
    fun testScenario1_AssetFallbackWhenStorageEmpty() = runBlocking {
        assertTrue("Primary storage must be empty initially", primaryStorageDir.listFiles()?.isEmpty() == true)

        val repository = RouteRepository(
            storageDir = primaryStorageDir,
            assetProvider = fileAssetProvider
        )

        val routes = repository.refreshRoutes()

        assertEquals("Should return empty list when storage is empty", 0, routes.size)
        assertEquals(routes, repository.getRouteOptions())
        assertEquals(routes, repository.routes.value)

        val nullAssetRepo = RouteRepository(
            storageDir = primaryStorageDir,
            assetProvider = AssetProvider { null }
        )
        val fallbackRoutes = nullAssetRepo.refreshRoutes()
        assertEquals(0, fallbackRoutes.size)
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

        // Initially 0 routes
        assertEquals(0, repository.refreshRoutes().size)

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
        assertEquals("Route list should grow from 0 to 1", 1, updatedRoutes.size)

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
        assertEquals(1, repository.routes.value.size)

        // Delete custom file and verify refresh drops it
        customFile.delete()
        val afterDeleteRoutes = repository.refreshRoutes()
        assertEquals(0, afterDeleteRoutes.size)
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

        // The 3 bad files must be skipped, valid_custom.json ingested -> 1 route
        assertEquals(1, routes.size)
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

        // 3 multi-day options + 1 single route option = 4 options
        assertEquals(4, routes.size)

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

        assertEquals("Southwest Canyon Loop", day1.tripName)
        assertEquals("Southwest Canyon Loop", day2.tripName)
        assertEquals("Southwest Canyon Loop", day3.tripName)

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
        assertEquals("Albany Quick Test Loop", singleOption.tripName)

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

        // Delete custom route by RouteOption
        val customDeleted = repository.deleteItinerary(savedOption!!)
        assertTrue("Custom itinerary should be deleted successfully", customDeleted)
        assertFalse("File must no longer exist on disk", fileOnDisk.exists())
        assertNull(repository.getRouteOptions().find { it.routeFile == "saved_trip.json" })

        // Save another trip and delete by fileName directly using deleteItineraryFile
        val json2 = """
            {
              "trip_name": "Saved Trip 2",
              "checkpoints": [
                { "id": "s2", "name": "Stop 2", "lat": 31.0, "lng": -91.0, "offset_minutes_from_start": 0 }
              ]
            }
        """.trimIndent()
        val savedOption2 = repository.saveItinerary("saved_trip_2.json", json2)
        assertNotNull(savedOption2)
        val file2OnDisk = File(primaryStorageDir, "saved_trip_2.json")
        assertTrue(file2OnDisk.exists())

        val deletedByFile = repository.deleteItineraryFile("saved_trip_2.json")
        assertTrue("deleteItineraryFile should return true", deletedByFile)
        assertFalse(file2OnDisk.exists())
        assertNull(repository.getRouteOptions().find { it.routeFile == "saved_trip_2.json" })

        // Attempting to delete non-existent file returns false
        assertFalse(repository.deleteItineraryFile("non_existent.json"))
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
            title = "Scenic Southwest: Phoenix to Flagstaff",
            routeFile = "sample_itinerary.json",
            dayNumber = 1
        )
        assertEquals("Scenic Southwest: Phoenix to Flagstaff", option.toString())
    }

    /**
     * Phase 1B Invariant: loadItinerary(routeFile, dayNumber) Overload & Fallback Resolution
     * Verifies that CopilotService can load both bundled assets and custom storage files
     * using routeFile and dayNumber without crashing or failing.
     */
    @Test
    fun testPhase1B_LoadItineraryOverloadsAndFallback() = runBlocking {
        val repository = RouteRepository(
            storageDir = primaryStorageDir,
            assetProvider = fileAssetProvider
        )

        // 1. Create and ingest custom stored route
        val customTripJson = """
            {
              "trip_name": "Sedona Red Rock Vortex Loop",
              "checkpoints": [
                { "id": "vortex_1", "name": "Airport Mesa Vortex", "lat": 34.855, "lng": -111.778, "offset_minutes_from_start": 0 },
                { "id": "vortex_2", "name": "Cathedral Rock Vortex", "lat": 34.821, "lng": -111.792, "offset_minutes_from_start": 20 }
              ]
            }
        """.trimIndent()
        val customFile = File(primaryStorageDir, "sedona_custom.json")
        customFile.writeText(customTripJson)

        repository.refreshRoutes()

        // 2. Load custom stored route by filename + explicit dayNumber
        val customLoaded = repository.loadItinerary("sedona_custom.json", dayNumber = 1)
        assertNotNull("Custom storage itinerary must load by filename and dayNumber", customLoaded)
        assertEquals("Sedona Red Rock Vortex Loop", customLoaded?.tripName)
        assertEquals(2, customLoaded?.getCheckpointsForDay(1)?.size)

        // 3. Load custom stored route with default dayNumber parameter
        val defaultDayLoaded = repository.loadItinerary("sedona_custom.json")
        assertNotNull("Custom storage itinerary must load with default dayNumber parameter", defaultDayLoaded)
        assertEquals("Sedona Red Rock Vortex Loop", defaultDayLoaded?.tripName)

        // 4. Loading a non-existent route returns null safely
        val nonExistentLoaded = repository.loadItinerary("non_existent.json")
        assertNull("Loading non-existent file must safely return null", nonExistentLoaded)
    }

    @Test
    fun testTripGroupGroupingAndToString() {
        val singleOption = RouteOption(
            title = "Albany Quick Test Loop",
            routeFile = "single_run.json",
            dayNumber = 1,
            tripName = "Albany Quick Test Loop"
        )
        val singleGroup = TripGroup(
            title = singleOption.tripName ?: singleOption.title,
            routeFile = singleOption.routeFile,
            isAsset = false,
            days = listOf(singleOption)
        )
        assertEquals("Albany Quick Test Loop", singleGroup.toString())

        val day1 = RouteOption(
            title = "Day 1: Phoenix to Sedona",
            routeFile = "multi_day.json",
            dayNumber = 1,
            tripName = "Southwest Canyon Loop"
        )
        val day2 = RouteOption(
            title = "Day 2: Sedona to Grand Canyon",
            routeFile = "multi_day.json",
            dayNumber = 2,
            tripName = "Southwest Canyon Loop"
        )
        val multiGroup = TripGroup(
            title = day1.tripName ?: "Southwest Canyon Loop",
            routeFile = day1.routeFile,
            isAsset = false,
            days = listOf(day1, day2)
        )
        assertEquals("Southwest Canyon Loop (2 Days)", multiGroup.toString())

        val existingDaysGroup = TripGroup(
            title = "Southwest Canyon Loop (2 Days)",
            routeFile = "multi_day.json",
            isAsset = false,
            days = listOf(day1, day2)
        )
        assertEquals("Southwest Canyon Loop (2 Days)", existingDaysGroup.toString())
    }
}
