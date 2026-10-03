package com.roadtrip.copilot

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.google.gson.Gson
import com.roadtrip.copilot.model.EvaluationResult
import com.roadtrip.copilot.model.Itinerary
import com.roadtrip.copilot.model.RouteRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.InputStreamReader

class CopilotService : Service() {

    companion object {
        const val TAG = "CopilotService"
        const val ACTION_START = "com.roadtrip.copilot.ACTION_START"
        const val ACTION_STOP = "com.roadtrip.copilot.ACTION_STOP"
        const val ACTION_TEST_ALERT = "com.roadtrip.copilot.ACTION_TEST_ALERT"
        const val ACTION_TEST_AUDIO = "com.roadtrip.copilot.ACTION_TEST_AUDIO"
        const val ACTION_CALIBRATE_AUDIO = "com.roadtrip.copilot.ACTION_CALIBRATE_AUDIO"
        const val EXTRA_ROUTE_FILE = "extra_route_file"
        const val EXTRA_DAY_NUMBER = "extra_day_number"

        private val _isRunning = MutableStateFlow(false)
        val isRunning = _isRunning.asStateFlow()

        private val _telemetryFlow = MutableStateFlow<EvaluationResult?>(null)
        val telemetryFlow = _telemetryFlow.asStateFlow()

        private val _eventLogFlow = MutableSharedFlow<String>(replay = 5)
        val eventLogFlow = _eventLogFlow.asSharedFlow()

        private val _activeRouteTitle = MutableStateFlow("Scenic Southwest: Phoenix to Flagstaff")
        val activeRouteTitle = _activeRouteTitle.asStateFlow()

        private val _activeRouteFile = MutableStateFlow("sample_itinerary.json")
        val activeRouteFile = _activeRouteFile.asStateFlow()

        private val _activeDayNumber = MutableStateFlow(1)
        val activeDayNumber = _activeDayNumber.asStateFlow()

        private val _activeCheckpoints = MutableStateFlow<List<com.roadtrip.copilot.model.Checkpoint>>(emptyList())
        val activeCheckpoints = _activeCheckpoints.asStateFlow()

        private val _activeGoogleMapsUrl = MutableStateFlow<String?>(null)
        val activeGoogleMapsUrl = _activeGoogleMapsUrl.asStateFlow()

        const val PREFS_NAME = "copilot_prefs"
        const val PREF_ROUTE_FILE = "pref_route_file"
        const val PREF_DAY_NUMBER = "pref_day_number"

        private var instance: CopilotService? = null
        fun getInstance(): CopilotService? = instance

        private val companionScope = CoroutineScope(Dispatchers.Default + SupervisorJob())

        fun loadInitialRoute(context: Context) {
            companionScope.launch {
                RouteRepository.getInstance(context).refreshRoutes()
            }
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val routeFile = prefs.getString(PREF_ROUTE_FILE, "sample_itinerary.json") ?: "sample_itinerary.json"
            val dayNum = prefs.getInt(PREF_DAY_NUMBER, 1)
            setSelectedRoute(context, routeFile, dayNum, autoRestartIfRunning = false)
        }

        fun setSelectedRoute(
            context: Context,
            routeFile: String,
            dayNumber: Int,
            autoRestartIfRunning: Boolean = false
        ) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            prefs.edit()
                .putString(PREF_ROUTE_FILE, routeFile)
                .putInt(PREF_DAY_NUMBER, dayNumber)
                .apply()

            _activeRouteFile.value = routeFile
            _activeDayNumber.value = dayNumber

            companionScope.launch {
                try {
                    val repo = RouteRepository.getInstance(context)
                    val itinerary = repo.loadItinerary(routeFile, dayNumber)
                        ?: repo.loadItinerary(routeFile)

                    if (itinerary == null) {
                        Log.e(TAG, "Failed to load itinerary for $routeFile (day $dayNumber)")
                        return@launch
                    }

                    val startTime = System.currentTimeMillis()
                    val checkpoints = itinerary.resolveCheckpointsForDay(dayNumber, startTime)
                    val dayTitle = itinerary.days?.find { it.day == dayNumber }?.title
                    val title = if (!dayTitle.isNullOrBlank()) "Day $dayNumber: $dayTitle" else itinerary.tripName.ifBlank { "Day $dayNumber" }

                    val googleMapsUrl = itinerary.getGoogleMapsUrlForDay(dayNumber)

                    withContext(Dispatchers.Main) {
                        _activeRouteTitle.value = title
                        _activeCheckpoints.value = checkpoints
                        _activeGoogleMapsUrl.value = googleMapsUrl

                        val service = instance
                        if (_isRunning.value && service != null && autoRestartIfRunning) {
                            service.reloadCheckpoints(checkpoints, startTime)
                        } else if (!_isRunning.value) {
                            val firstCp = checkpoints.firstOrNull()
                            _telemetryFlow.value = EvaluationResult(
                                currentLat = 0.0,
                                currentLng = 0.0,
                                speedMph = 0.0,
                                alerts = emptyList(),
                                nextCheckpoint = firstCp,
                                distanceToNextMiles = null,
                                scheduleDelta = com.roadtrip.copilot.model.ScheduleDelta(0, "Awaiting Departure", true)
                            )
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error loading route $routeFile: ${e.message}", e)
                }
            }
        }

        fun startRoute(context: Context, routeFile: String? = null, dayNumber: Int? = null) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val file = routeFile ?: prefs.getString(PREF_ROUTE_FILE, "sample_itinerary.json") ?: "sample_itinerary.json"
            val day = dayNumber ?: prefs.getInt(PREF_DAY_NUMBER, 1)

            prefs.edit()
                .putString(PREF_ROUTE_FILE, file)
                .putInt(PREF_DAY_NUMBER, day)
                .apply()

            val intent = Intent(context, CopilotService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_ROUTE_FILE, file)
                putExtra(EXTRA_DAY_NUMBER, day)
            }
            androidx.core.content.ContextCompat.startForegroundService(context, intent)
        }

        fun stopRoute(context: Context) {
            val intent = Intent(context, CopilotService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }

        fun testAlert(context: Context) {
            val intent = Intent(context, CopilotService::class.java).apply {
                action = ACTION_TEST_ALERT
            }
            context.startService(intent)
        }

        fun testAudio(context: Context) {
            val intent = Intent(context, CopilotService::class.java).apply {
                action = ACTION_TEST_AUDIO
            }
            context.startService(intent)
        }

        fun calibrateAudio(context: Context) {
            val intent = Intent(context, CopilotService::class.java).apply {
                action = ACTION_CALIBRATE_AUDIO
            }
            context.startService(intent)
        }
    }

    private val binder = LocalBinder()
    private val serviceScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private lateinit var notificationEngine: NotificationEngine
    private lateinit var audioDuckEngine: AudioDuckEngine
    private lateinit var locationTracker: LocationTracker

    inner class LocalBinder : Binder() {
        fun getService(): CopilotService = this@CopilotService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        instance = this
        Log.i(TAG, "Creating CopilotService...")

        notificationEngine = NotificationEngine(this)
        audioDuckEngine = AudioDuckEngine(this) { isSpeaking, text ->
            if (isSpeaking) {
                emitLog("Speaking: \"$text\"")
            }
        }

        val prefs = getSharedPreferences("copilot_prefs", Context.MODE_PRIVATE)
        audioDuckEngine.pauseMusicInsteadOfDuck = prefs.getBoolean("pref_pause_music", true)

        locationTracker = LocationTracker(this) { evalResult ->
            handleEvaluationResult(evalResult)
        }
    }

    fun setPauseMusicInsteadOfDuck(pause: Boolean) {
        audioDuckEngine.pauseMusicInsteadOfDuck = pause
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        Log.i(TAG, "onStartCommand action: $action")

        if (action == ACTION_STOP) {
            stopCopilot()
            return START_NOT_STICKY
        }

        if (action == ACTION_TEST_ALERT) {
            testAlert()
            return START_NOT_STICKY
        }

        if (action == ACTION_TEST_AUDIO) {
            testAudio()
            return START_NOT_STICKY
        }

        if (action == ACTION_CALIBRATE_AUDIO) {
            calibrateAudio()
            return START_NOT_STICKY
        }

        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val defaultRoute = prefs.getString(PREF_ROUTE_FILE, "sample_itinerary.json") ?: "sample_itinerary.json"
        val defaultDay = prefs.getInt(PREF_DAY_NUMBER, 1)

        val routeFile = intent?.getStringExtra(EXTRA_ROUTE_FILE) ?: defaultRoute
        val dayNumber = intent?.getIntExtra(EXTRA_DAY_NUMBER, defaultDay) ?: defaultDay

        prefs.edit()
            .putString(PREF_ROUTE_FILE, routeFile)
            .putInt(PREF_DAY_NUMBER, dayNumber)
            .apply()

        startForegroundServiceWithNotification()
        loadItineraryAndStart(routeFile, dayNumber)

        return START_STICKY
    }

    private fun startForegroundServiceWithNotification() {
        val initialNotification = notificationEngine.buildForegroundNotification(
            nextCheckpoint = "Initializing Route...",
            distanceMiles = null,
            targetTime = null,
            paceStatus = "Standby"
        )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NotificationEngine.FOREGROUND_NOTIFICATION_ID,
                initialNotification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            )
        } else {
            startForeground(NotificationEngine.FOREGROUND_NOTIFICATION_ID, initialNotification)
        }

        _isRunning.value = true
        emitLog("Co-Pilot foreground service started.")
    }

    private fun loadItineraryAndStart(routeFile: String, dayNumber: Int) {
        _activeRouteFile.value = routeFile
        _activeDayNumber.value = dayNumber
        serviceScope.launch {
            try {
                val repo = RouteRepository.getInstance(applicationContext)
                val (itinerary, checkpoints, startTime) = withContext(Dispatchers.IO) {
                    val loaded = repo.loadItinerary(routeFile, dayNumber) ?: repo.loadItinerary(routeFile)
                        ?: throw IllegalStateException("Failed to load itinerary: $routeFile (day $dayNumber)")
                    val time = System.currentTimeMillis()
                    val cps = loaded.resolveCheckpointsForDay(dayNumber, time)
                    Triple(loaded, cps, time)
                }

                locationTracker.setCheckpoints(checkpoints, startTime)
                locationTracker.startTracking()

                val dayTitle = itinerary.days?.find { it.day == dayNumber }?.title
                _activeRouteTitle.value = if (!dayTitle.isNullOrBlank()) "Day $dayNumber: $dayTitle" else itinerary.tripName.ifBlank { "Day $dayNumber" }
                _activeCheckpoints.value = checkpoints
                _activeGoogleMapsUrl.value = itinerary.getGoogleMapsUrlForDay(dayNumber)

                emitLog("Loaded ${checkpoints.size} waypoints for ${itinerary.tripName} (Day $dayNumber).")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load itinerary $routeFile: ${e.message}", e)
                emitLog("Error loading route: ${e.message}")
            }
        }
    }

    private fun handleEvaluationResult(result: EvaluationResult) {
        _telemetryFlow.value = result

        // Update persistent status notification
        val nextCpName = result.nextCheckpoint?.name ?: "All Waypoints Passed"
        val dist = result.distanceToNextMiles
        val targetTime = result.nextCheckpoint?.formattedTargetTime
        val pace = result.scheduleDelta?.statusText ?: "On Schedule"

        val updatedNotification = notificationEngine.buildForegroundNotification(
            nextCheckpoint = nextCpName,
            distanceMiles = dist,
            targetTime = targetTime,
            paceStatus = pace
        )

        val notificationManager = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
        notificationManager.notify(NotificationEngine.FOREGROUND_NOTIFICATION_ID, updatedNotification)

        // Process triggered geofence alerts
        for (alert in result.alerts) {
            emitLog("Alert: ${alert.title} — ${alert.message}")
            // 1. Android Auto heads-up card
            notificationEngine.postHeadsUpAlert(alert.title, alert.message)
            // 2. Audio Duck speech over car speakers
            audioDuckEngine.speakWithDucking(alert.speech)
        }
    }

    fun testAudio() {
        val mode = if (audioDuckEngine.pauseMusicInsteadOfDuck) "pause music" else "duck music"
        emitLog("Testing car audio via navigation guidance channel ($mode)...")
        audioDuckEngine.speakWithDucking("Roadtrip co-pilot audio test. Navigation guidance channel connected and ducking is operational.")
    }

    fun calibrateAudio() {
        emitLog("Starting audio calibration speech loop on navigation guidance stream...")
        audioDuckEngine.startContinuousCalibrationSpeech()
    }

    fun testAlert() {
        val currentPace = _telemetryFlow.value?.scheduleDelta?.statusText ?: "On schedule"
        emitLog("Posting Android Auto heads-up card and speaking...")
        notificationEngine.postHeadsUpAlert(
            "Scenic Vista • $currentPace",
            "Approaching Oak Creek Vista pull-off. Android Auto heads-up alert and audio ducking operational."
        )
        audioDuckEngine.speakWithDucking("Approaching Scenic Vista. Roadtrip co-pilot alert and audio ducking operational.")
    }

    fun reloadCheckpoints(checkpoints: List<com.roadtrip.copilot.model.Checkpoint>, startTime: Long) {
        locationTracker.setCheckpoints(checkpoints, startTime)
        val firstCp = checkpoints.firstOrNull()
        val updatedNotification = notificationEngine.buildForegroundNotification(
            nextCheckpoint = firstCp?.name ?: "All Waypoints Passed",
            distanceMiles = null,
            targetTime = firstCp?.formattedTargetTime,
            paceStatus = "Standby"
        )
        val notificationManager = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
        notificationManager.notify(NotificationEngine.FOREGROUND_NOTIFICATION_ID, updatedNotification)
        emitLog("Reloaded ${checkpoints.size} waypoints for active route.")
    }

    private fun stopCopilot() {
        locationTracker.stopTracking()
        _isRunning.value = false
        val firstCp = _activeCheckpoints.value.firstOrNull()
        _telemetryFlow.value = EvaluationResult(
            currentLat = 0.0,
            currentLng = 0.0,
            speedMph = 0.0,
            alerts = emptyList(),
            nextCheckpoint = firstCp,
            distanceToNextMiles = null,
            scheduleDelta = com.roadtrip.copilot.model.ScheduleDelta(0, "Awaiting Departure", true)
        )
        emitLog("Co-Pilot service stopped.")
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun emitLog(message: String) {
        serviceScope.launch {
            _eventLogFlow.emit(message)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        instance = null
        locationTracker.stopTracking()
        audioDuckEngine.shutdown()
        serviceScope.cancel()
        _isRunning.value = false
        val firstCp = _activeCheckpoints.value.firstOrNull()
        _telemetryFlow.value = EvaluationResult(
            currentLat = 0.0,
            currentLng = 0.0,
            speedMph = 0.0,
            alerts = emptyList(),
            nextCheckpoint = firstCp,
            distanceToNextMiles = null,
            scheduleDelta = com.roadtrip.copilot.model.ScheduleDelta(0, "Awaiting Departure", true)
        )
        Log.i(TAG, "CopilotService destroyed.")
    }
}
