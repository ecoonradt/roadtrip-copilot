package com.roadtrip.copilot.model

import android.content.Context
import androidx.annotation.VisibleForTesting
import com.google.gson.Gson
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import java.io.File
import java.io.InputStreamReader

/**
 * Repository responsible for discovering, caching, loading, and managing road trip itineraries.
 *
 * Scans internal and external app storage directories for user-imported custom `.json` itineraries,
 * while preserving the 6 bundled asset itineraries as permanent fallback defaults.
 *
 * All disk I/O and JSON deserialization are strictly dispatched to [Dispatchers.IO] to guarantee
 * zero main-thread blocking.
 */
class RouteRepository(
    val storageDirs: List<File>,
    val assetProvider: AssetProvider = AssetProvider { null },
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO
) {

    constructor(
        storageDir: File,
        assetProvider: AssetProvider = AssetProvider { null },
        ioDispatcher: CoroutineDispatcher = Dispatchers.IO
    ) : this(listOf(storageDir), assetProvider, ioDispatcher)

    private val gson = Gson()

    private val _routes = MutableStateFlow<List<RouteOption>>(DEFAULT_ASSET_OPTIONS)
    val routes: StateFlow<List<RouteOption>> = _routes.asStateFlow()

    @VisibleForTesting
    var logListener: ((level: String, tag: String, msg: String, tr: Throwable?) -> Unit)? = null

    /**
     * Returns the current cached list of route options.
     */
    fun getRouteOptions(): List<RouteOption> = _routes.value

    /**
     * Alias returning the reactive [StateFlow] of routes for UI consumers.
     */
    fun getRoutesFlow(): StateFlow<List<RouteOption>> = routes

    /**
     * Scans all configured [storageDirs] for valid `.json` itineraries, parses their
     * route options, appends the 6 bundled asset fallback routes, and updates [routes].
     *
     * Corrupted or malformed files are logged and skipped without throwing.
     */
    suspend fun refreshRoutes(): List<RouteOption> = withContext(ioDispatcher) {
        val customRoutes = mutableListOf<RouteOption>()
        val seenFileNames = mutableSetOf<String>()

        for (dir in storageDirs) {
            if (!dir.exists()) {
                dir.mkdirs()
            }
            if (!dir.isDirectory) continue

            val jsonFiles = dir.listFiles { file ->
                file.isFile && file.name.endsWith(".json", ignoreCase = true)
            }?.sortedBy { it.name } ?: emptyList()

            for (file in jsonFiles) {
                if (seenFileNames.contains(file.name)) continue
                seenFileNames.add(file.name)

                try {
                    val content = file.readText(Charsets.UTF_8)
                    if (content.isBlank()) {
                        logW(TAG, "Skipping empty itinerary file: ${file.name}")
                        continue
                    }

                    val itinerary = gson.fromJson(content, Itinerary::class.java)
                    if (itinerary == null) {
                        logW(TAG, "Skipping null deserialized itinerary: ${file.name}")
                        continue
                    }

                    val optionsForFile = parseItineraryToRouteOptions(
                        itinerary = itinerary,
                        fileName = file.name,
                        absolutePath = file.absolutePath,
                        isAsset = false
                    )

                    if (optionsForFile.isEmpty()) {
                        logW(TAG, "No valid days or checkpoints found in: ${file.name}")
                        continue
                    }
                    customRoutes.addAll(optionsForFile)
                } catch (e: Exception) {
                    logE(TAG, "Failed to parse itinerary file ${file.name}: ${e.message}", e)
                }
            }
        }

        val assetRoutes = loadAssetRoutes().filter { asset ->
            customRoutes.none { it.routeFile == asset.routeFile }
        }
        val combined = customRoutes + assetRoutes
        _routes.value = combined
        combined
    }

    /**
     * Loads the full [Itinerary] object for a given [RouteOption].
     * Handles both bundled assets and storage filesystem paths.
     */
    suspend fun loadItinerary(option: RouteOption): Itinerary? = withContext(ioDispatcher) {
        try {
            if (option.isAsset) {
                val stream = assetProvider.open(option.routeFile)
                if (stream != null) {
                    return@withContext stream.use { s ->
                        InputStreamReader(s, Charsets.UTF_8).use { reader ->
                            gson.fromJson(reader, Itinerary::class.java)
                        }
                    }
                }
                // Fallback: check storage directories
                val file = storageDirs.firstNotNullOfOrNull { dir ->
                    File(dir, option.routeFile).takeIf { it.exists() }
                }
                if (file != null && file.exists()) {
                    return@withContext file.reader(Charsets.UTF_8).use { reader ->
                        gson.fromJson(reader, Itinerary::class.java)
                    }
                }
                logE(TAG, "Bundled asset file not found: ${option.routeFile}")
                return@withContext null
            } else {
                val file = if (!option.absolutePath.isNullOrBlank()) {
                    File(option.absolutePath)
                } else {
                    storageDirs.firstNotNullOfOrNull { dir ->
                        File(dir, option.routeFile).takeIf { it.exists() }
                    }
                }
                if (file != null && file.exists()) {
                    return@withContext file.reader(Charsets.UTF_8).use { reader ->
                        gson.fromJson(reader, Itinerary::class.java)
                    }
                }
                // Fallback: check asset provider
                val stream = assetProvider.open(option.routeFile)
                if (stream != null) {
                    return@withContext stream.use { s ->
                        InputStreamReader(s, Charsets.UTF_8).use { reader ->
                            gson.fromJson(reader, Itinerary::class.java)
                        }
                    }
                }
                logE(TAG, "Storage itinerary file not found: ${option.routeFile} (path: ${option.absolutePath})")
                return@withContext null
            }
        } catch (e: Exception) {
            logE(TAG, "Error loading itinerary for ${option.routeFile}: ${e.message}", e)
            null
        }
    }

    /**
     * Convenience overload to load an itinerary given route file parameters.
     */
    suspend fun loadItinerary(
        routeFile: String,
        isAsset: Boolean = false,
        absolutePath: String? = null
    ): Itinerary? {
        val existing = _routes.value.find { it.routeFile == routeFile }
        val finalIsAsset = existing?.isAsset ?: isAsset
        val finalAbsolutePath = existing?.absolutePath ?: absolutePath
        return loadItinerary(
            RouteOption(
                title = existing?.title ?: routeFile,
                routeFile = routeFile,
                dayNumber = existing?.dayNumber ?: 1,
                isAsset = finalIsAsset,
                absolutePath = finalAbsolutePath
            )
        )
    }

    /**
     * Convenience overload to load an itinerary given route file name and day number.
     */
    suspend fun loadItinerary(
        routeFile: String,
        dayNumber: Int
    ): Itinerary? {
        val existing = _routes.value.find { it.routeFile == routeFile && it.dayNumber == dayNumber }
            ?: _routes.value.find { it.routeFile == routeFile }
        return if (existing != null) {
            loadItinerary(existing)
        } else {
            loadItinerary(
                RouteOption(
                    title = routeFile,
                    routeFile = routeFile,
                    dayNumber = dayNumber,
                    isAsset = false,
                    absolutePath = null
                )
            )
        }
    }

    /**
     * Resolves the active checkpoints for a route option with computed epoch timestamps.
     */
    suspend fun resolveCheckpoints(
        option: RouteOption,
        tripStartTimeMillis: Long = System.currentTimeMillis()
    ): List<Checkpoint> = withContext(ioDispatcher) {
        val itinerary = loadItinerary(option) ?: return@withContext emptyList()
        itinerary.resolveCheckpointsForDay(option.dayNumber, tripStartTimeMillis)
    }

    /**
     * Saves or imports a JSON itinerary string into the primary internal storage directory
     * and refreshes the route list.
     */
    suspend fun saveItinerary(fileName: String, jsonContent: String): RouteOption? = withContext(ioDispatcher) {
        val targetDir = storageDirs.firstOrNull() ?: return@withContext null
        if (!targetDir.exists()) {
            targetDir.mkdirs()
        }
        val targetFile = File(targetDir, fileName)
        targetFile.writeText(jsonContent, Charsets.UTF_8)
        refreshRoutes()
        _routes.value.find { it.routeFile == fileName }
    }

    /**
     * Deletes a custom itinerary from disk and refreshes the route list.
     * Bundled assets cannot be deleted.
     */
    suspend fun deleteItinerary(option: RouteOption): Boolean = withContext(ioDispatcher) {
        if (option.isAsset) {
            logW(TAG, "Cannot delete bundled asset route: ${option.routeFile}")
            return@withContext false
        }
        val file = if (!option.absolutePath.isNullOrBlank()) {
            File(option.absolutePath)
        } else {
            storageDirs.firstNotNullOfOrNull { dir ->
                File(dir, option.routeFile).takeIf { it.exists() }
            }
        }
        if (file != null && file.exists()) {
            val deleted = file.delete()
            if (deleted) {
                refreshRoutes()
            }
            deleted
        } else {
            false
        }
    }

    private fun parseItineraryToRouteOptions(
        itinerary: Itinerary,
        fileName: String,
        absolutePath: String?,
        isAsset: Boolean
    ): List<RouteOption> {
        val results = mutableListOf<RouteOption>()

        if (!itinerary.days.isNullOrEmpty()) {
            val sortedDays = itinerary.days.sortedBy { it.day }
            val tripName = itinerary.tripName.ifBlank {
                fileName.removeSuffix(".json").replace('_', ' ').replace('-', ' ').trim()
            }
            for (day in sortedDays) {
                val dayNum = day.day
                val rawTitle = day.title?.trim()
                val title = when {
                    rawTitle.isNullOrBlank() -> if (itinerary.tripName.isNotBlank()) "${itinerary.tripName} (Day $dayNum)" else "Day $dayNum"
                    rawTitle.startsWith("Day $dayNum", ignoreCase = true) -> rawTitle
                    else -> "Day $dayNum: $rawTitle"
                }
                val subtitle = if (itinerary.tripName.isNotBlank() && itinerary.tripName != title) {
                    itinerary.tripName
                } else {
                    val origin = day.origin
                    val destination = day.destination
                    if (!origin.isNullOrBlank() && !destination.isNullOrBlank()) "$origin → $destination" else null
                }
                results.add(
                    RouteOption(
                        title = title,
                        routeFile = fileName,
                        dayNumber = dayNum,
                        isAsset = isAsset,
                        absolutePath = absolutePath,
                        subtitle = subtitle,
                        tripName = tripName
                    )
                )
            }
        } else if (!itinerary.checkpoints.isNullOrEmpty()) {
            val title = if (itinerary.tripName.isNotBlank()) {
                itinerary.tripName.trim()
            } else {
                fileName.removeSuffix(".json").replace('_', ' ').replace('-', ' ').trim()
            }
            val subtitle = "${itinerary.checkpoints.size} checkpoints"
            results.add(
                RouteOption(
                    title = title,
                    routeFile = fileName,
                    dayNumber = 1,
                    isAsset = isAsset,
                    absolutePath = absolutePath,
                    subtitle = subtitle,
                    tripName = title
                )
            )
        }

        return results
    }

    private fun loadAssetRoutes(): List<RouteOption> {
        return DEFAULT_ASSET_OPTIONS
    }

    private fun logE(tag: String, msg: String, tr: Throwable? = null) {
        logListener?.invoke("ERROR", tag, msg, tr)
        try {
            android.util.Log.e(tag, msg, tr)
        } catch (e: RuntimeException) {
            System.err.println("[$tag] ERROR: $msg ${tr?.message ?: ""}")
        }
    }

    private fun logW(tag: String, msg: String) {
        logListener?.invoke("WARN", tag, msg, null)
        try {
            android.util.Log.w(tag, msg)
        } catch (e: RuntimeException) {
            println("[$tag] WARN: $msg")
        }
    }

    private fun logD(tag: String, msg: String) {
        logListener?.invoke("DEBUG", tag, msg, null)
        try {
            android.util.Log.d(tag, msg)
        } catch (e: RuntimeException) {
            println("[$tag] DEBUG: $msg")
        }
    }

    companion object {
        private const val TAG = "RouteRepository"

        @Volatile
        private var instance: RouteRepository? = null

        /**
         * Singleton accessor for production Android runtime.
         */
        fun getInstance(context: Context): RouteRepository {
            return instance ?: synchronized(this) {
                instance ?: createInstance(context.applicationContext).also { instance = it }
            }
        }

        private fun createInstance(appContext: Context): RouteRepository {
            val internalDir = File(appContext.filesDir, "itineraries")
            val externalDir = appContext.getExternalFilesDir("itineraries")
            val dirs = listOfNotNull(internalDir, externalDir)
            return RouteRepository(
                storageDirs = dirs,
                assetProvider = { fileName ->
                    try {
                        appContext.assets.open(fileName)
                    } catch (e: Exception) {
                        null
                    }
                }
            )
        }

        @VisibleForTesting
        fun setInstanceForTesting(repository: RouteRepository?) {
            instance = repository
        }

        /**
         * The bundled permanent fallback default route options.
         */
        val DEFAULT_ASSET_OPTIONS: List<RouteOption> = listOf(
            RouteOption(
                title = "Scenic Southwest: Phoenix to Flagstaff",
                routeFile = "sample_itinerary.json",
                dayNumber = 1,
                isAsset = true,
                subtitle = "Sample Route • Phoenix → Sedona → Flagstaff",
                tripName = "Scenic Southwest: Phoenix to Flagstaff"
            )
        )
    }
}
