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
        const val EXTRA_ROUTE_FILE = "extra_route_file"
        const val EXTRA_DAY_NUMBER = "extra_day_number"

        private val _isRunning = MutableStateFlow(false)
        val isRunning = _isRunning.asStateFlow()

        private val _telemetryFlow = MutableStateFlow<EvaluationResult?>(null)
        val telemetryFlow = _telemetryFlow.asStateFlow()

        private val _eventLogFlow = MutableSharedFlow<String>(replay = 5)
        val eventLogFlow = _eventLogFlow.asSharedFlow()
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
        Log.i(TAG, "Creating CopilotService...")

        notificationEngine = NotificationEngine(this)
        audioDuckEngine = AudioDuckEngine(this) { isSpeaking, text ->
            if (isSpeaking) {
                emitLog("Speaking: \"$text\"")
            }
        }

        val prefs = getSharedPreferences("copilot_prefs", Context.MODE_PRIVATE)
        audioDuckEngine.pauseMusicInsteadOfDuck = prefs.getBoolean("pref_pause_music", false)

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

        val routeFile = intent?.getStringExtra(EXTRA_ROUTE_FILE) ?: "itinerary.json"
        val dayNumber = intent?.getIntExtra(EXTRA_DAY_NUMBER, 1) ?: 1

        startForegroundServiceWithNotification()
        loadItineraryAndStart(routeFile, dayNumber)

        return START_STICKY
    }

    private fun startForegroundServiceWithNotification() {
        val initialNotification = notificationEngine.buildForegroundNotification(
            nextCheckpoint = "Initializing Route...",
            distanceMiles = null,
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
        serviceScope.launch {
            try {
                val itinerary = withContext(Dispatchers.IO) {
                    assets.open(routeFile).use { stream ->
                        InputStreamReader(stream).use { reader ->
                            Gson().fromJson(reader, Itinerary::class.java)
                        }
                    }
                }

                val checkpoints = itinerary.getCheckpointsForDay(dayNumber)
                locationTracker.setCheckpoints(checkpoints)
                locationTracker.startTracking()

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
        val pace = result.scheduleDelta?.statusText ?: "On Schedule"

        val updatedNotification = notificationEngine.buildForegroundNotification(
            nextCheckpoint = nextCpName,
            distanceMiles = dist,
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
        emitLog("Testing car audio ducking...")
        audioDuckEngine.speakWithDucking("Roadtrip co-pilot audio test. Navigation guidance channel connected and ducking is operational.")
    }

    fun testAlert() {
        emitLog("Posting test heads-up card and speaking...")
        notificationEngine.postHeadsUpAlert(
            "Test Checkpoint • 14 min ahead",
            "Approaching Scenic Vista pull-off. Audio pause and heads-up banner test."
        )
        audioDuckEngine.speakWithDucking("Approaching Scenic Vista. You are currently fourteen minutes ahead of schedule.")
    }

    private fun stopCopilot() {
        locationTracker.stopTracking()
        _isRunning.value = false
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
        locationTracker.stopTracking()
        audioDuckEngine.shutdown()
        serviceScope.cancel()
        _isRunning.value = false
        Log.i(TAG, "CopilotService destroyed.")
    }
}
