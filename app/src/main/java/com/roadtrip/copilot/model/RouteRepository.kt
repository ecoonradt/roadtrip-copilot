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

    private val _routes = MutableStateFlow<List<RouteOption>>(emptyList())
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
     * route options, and updates [routes].
     *
     * Corrupted or malformed files are logged and skipped without throwing.
     */
    suspend fun refreshRoutes(): List<RouteOption> = withContext(ioDispatcher) {
        val customRoutes = mutableListOf<RouteOption>()
        val allFiles = mutableListOf<File>()

        for (dir in storageDirs) {
            if (!dir.exists()) {
                dir.mkdirs()
            }
            if (!dir.isDirectory) continue

            val jsonFiles = dir.listFiles { file ->
                file.isFile && file.name.endsWith(".json", ignoreCase = true)
            } ?: emptyArray()

            allFiles.addAll(jsonFiles)
        }

        // Group by filename across internal and external storage dirs; pick newest copy (Finding 6)
        val candidateFiles = allFiles.groupBy { it.name }
            .values
            .map { filesGroup -> filesGroup.maxByOrNull { it.lastModified() }!! }
            .sortedBy { it.name }

        for (file in candidateFiles) {
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

        _routes.value = customRoutes
        customRoutes
    }

    /**
     * Loads the full [Itinerary] object for a given [RouteOption].
     * Handles storage filesystem paths and asset fallbacks if available.
     */
    suspend fun loadItinerary(option: RouteOption): Itinerary? = withContext(ioDispatcher) {
        try {
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
            // Fallback: check asset provider if present
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
     * Deletes an itinerary from disk and refreshes the route list.
     */
    suspend fun deleteItinerary(option: RouteOption): Boolean = withContext(ioDispatcher) {
        var anyDeleted = false
        // Delete the file across all storage dirs to prevent shadowed copies from resurrecting (Finding 6)
        for (dir in storageDirs) {
            val file = File(dir, option.routeFile)
            if (file.exists() && file.delete()) {
                anyDeleted = true
            }
        }
        if (!option.absolutePath.isNullOrBlank()) {
            val specificFile = File(option.absolutePath)
            if (specificFile.exists() && specificFile.delete()) {
                anyDeleted = true
            }
        }
        if (anyDeleted) {
            refreshRoutes()
        }
        anyDeleted
    }

    suspend fun deleteItineraryFile(fileName: String): Boolean = withContext(ioDispatcher) {
        var anyDeleted = false
        // Delete the file across all storage dirs to prevent shadowed copies from resurrecting (Finding 6)
        for (dir in storageDirs) {
            val file = File(dir, fileName)
            if (file.exists() && file.delete()) {
                anyDeleted = true
            }
        }
        if (anyDeleted) {
            refreshRoutes()
        }
        anyDeleted
    }

    internal fun parseItineraryToRouteOptions(
        itinerary: Itinerary,
        fileName: String,
        absolutePath: String? = null,
        isAsset: Boolean = false
    ): List<RouteOption> {
        val results = mutableListOf<RouteOption>()

        val rawTripName = itinerary.tripName
        val fallbackTripName = fileName.removeSuffix(".json").replace('_', ' ').replace('-', ' ').trim()
        val tripName = rawTripName.ifBlank { fallbackTripName }

        if (!itinerary.days.isNullOrEmpty()) {
            val sortedDays = itinerary.days.sortedBy { it.day }
            for (day in sortedDays) {
                val dayNum = day.day
                val rawTitle = day.title?.trim()
                val title = when {
                    rawTitle.isNullOrBlank() -> if (tripName.isNotBlank()) "$tripName (Day $dayNum)" else "Day $dayNum"
                    rawTitle.startsWith("Day $dayNum", ignoreCase = true) -> rawTitle
                    else -> "Day $dayNum: $rawTitle"
                }
                val subtitle = if (tripName.isNotBlank() && tripName != title) {
                    tripName
                } else {
                    val origin = day.origin
                    val destination = day.destination
                    if (!origin.isNullOrBlank() && !destination.isNullOrBlank()) "$origin → $destination" else null
                }
                val gmapsUrl = day.googleMapsUrl ?: itinerary.googleMapsUrl
                results.add(
                    RouteOption(
                        title = title,
                        routeFile = fileName,
                        dayNumber = dayNum,
                        isAsset = isAsset,
                        absolutePath = absolutePath,
                        subtitle = subtitle,
                        tripName = tripName,
                        googleMapsUrl = gmapsUrl,
                        date = day.date.takeIf { it.isNotBlank() } ?: itinerary.date
                    )
                )
            }
        } else if (!itinerary.checkpoints.isNullOrEmpty()) {
            val title = if (tripName.isNotBlank()) tripName else fallbackTripName
            val subtitle = "${itinerary.checkpoints.size} checkpoints"
            val gmapsUrl = itinerary.googleMapsUrl
            results.add(
                RouteOption(
                    title = title,
                    routeFile = fileName,
                    dayNumber = 1,
                    isAsset = isAsset,
                    absolutePath = absolutePath,
                    subtitle = subtitle,
                    tripName = title,
                    googleMapsUrl = gmapsUrl,
                    date = itinerary.date
                )
            )
        }

        return results
    }

    private fun loadAssetRoutes(): List<RouteOption> {
        return emptyList()
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
         * Permanent default route options (empty list when no assets bundled).
         */
        val DEFAULT_ASSET_OPTIONS: List<RouteOption> = emptyList()
    }
}
