package com.roadtrip.copilot

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.util.Log
import com.roadtrip.copilot.model.Checkpoint
import com.roadtrip.copilot.model.EvaluationResult
import com.roadtrip.copilot.model.ScheduleDelta
import com.roadtrip.copilot.model.TriggeredAlert
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

class LocationTracker(
    private val context: Context,
    private val onEvaluationResult: (EvaluationResult) -> Unit
) : LocationListener {

    private val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private var activeCheckpoints: List<Checkpoint> = emptyList()
    private val visitedCheckpoints = mutableSetOf<String>()
    private var startTimeMillis: Long? = null
    private var isTracking = false

    companion object {
        private const val TAG = "LocationTracker"
        private const val EARTH_RADIUS_MILES = 3958.8
    }

    fun setCheckpoints(checkpoints: List<Checkpoint>) {
        activeCheckpoints = checkpoints
        visitedCheckpoints.clear()
        startTimeMillis = System.currentTimeMillis()
        Log.i(TAG, "Loaded ${checkpoints.size} checkpoints into LocationTracker.")
    }

    @SuppressLint("MissingPermission")
    fun startTracking() {
        if (isTracking) return

        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER,
                    2000L, // 2 seconds
                    10f,   // 10 meters
                    this
                )
                isTracking = true
                Log.i(TAG, "GPS Provider location tracking started.")
            } else if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER,
                    3000L,
                    15f,
                    this
                )
                isTracking = true
                Log.i(TAG, "Network Provider fallback tracking started.")
            } else {
                Log.e(TAG, "No location provider enabled.")
            }
        } catch (e: SecurityException) {
            Log.e(TAG, "Location permission missing: ${e.message}")
        }
    }

    fun stopTracking() {
        if (!isTracking) return
        locationManager.removeUpdates(this)
        isTracking = false
        Log.i(TAG, "Location tracking stopped.")
    }

    override fun onLocationChanged(location: Location) {
        val speedMph = if (location.hasSpeed()) location.speed * 2.23694 else 0.0
        evaluate(location.latitude, location.longitude, speedMph)
    }

    fun evaluate(currentLat: Double, currentLng: Double, speedMph: Double) {
        val newAlerts = mutableListOf<TriggeredAlert>()
        var closestCheckpoint: Checkpoint? = null
        var closestDist = Double.MAX_VALUE

        for (cp in activeCheckpoints) {
            val dist = haversineMiles(currentLat, currentLng, cp.lat, cp.lng)

            // Check if within geofence trigger radius
            if (dist <= cp.triggerRadiusMiles && cp.id !in visitedCheckpoints) {
                visitedCheckpoints.add(cp.id)
                val notif = cp.notification
                val delta = calculateScheduleDelta(cp)

                val paceSpeech = when {
                    delta == null -> ""
                    delta.deltaMinutes > 1 -> " You are currently ${delta.deltaMinutes} minutes ahead of schedule."
                    delta.deltaMinutes < -1 -> " You are currently ${-delta.deltaMinutes} minutes behind schedule."
                    else -> " You are on schedule."
                }

                val titleText = if (delta != null && delta.statusText.isNotBlank()) {
                    "${notif?.title ?: cp.name} • ${delta.statusText}"
                } else {
                    notif?.title ?: cp.name
                }

                val msgText = if (delta != null && delta.statusText.isNotBlank()) {
                    "${notif?.message ?: "Approaching ${cp.name}"}\nPace: ${delta.statusText}"
                } else {
                    notif?.message ?: "Approaching ${cp.name}"
                }

                val speechText = (notif?.speech ?: "Approaching ${cp.name}") + paceSpeech

                val alert = TriggeredAlert(
                    id = cp.id,
                    name = cp.name,
                    distanceMiles = dist,
                    title = titleText,
                    message = msgText,
                    speech = speechText
                )
                newAlerts.add(alert)
                Log.i(TAG, "Geofence triggered for: ${cp.name} (dist: %.2f mi, pace: $paceSpeech)".format(dist))
            }

            // Track upcoming waypoint (not yet passed)
            if (cp.id !in visitedCheckpoints && dist < closestDist) {
                closestDist = dist
                closestCheckpoint = cp
            }
        }

        val scheduleDelta = calculateScheduleDelta(closestCheckpoint)

        val result = EvaluationResult(
            currentLat = currentLat,
            currentLng = currentLng,
            speedMph = speedMph,
            alerts = newAlerts,
            nextCheckpoint = closestCheckpoint,
            distanceToNextMiles = if (closestCheckpoint != null) closestDist else null,
            scheduleDelta = scheduleDelta
        )

        onEvaluationResult(result)
    }

    private fun calculateScheduleDelta(checkpoint: Checkpoint?): ScheduleDelta? {
        if (checkpoint == null) return null

        // 1. If target_time is present (e.g. "14:30:00")
        val targetStr = checkpoint.targetTime
        if (!targetStr.isNullOrBlank()) {
            try {
                val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.US)
                val targetDate = timeFormat.parse(targetStr)
                val currentStr = timeFormat.format(Date())
                val currentDate = timeFormat.parse(currentStr)

                if (targetDate != null && currentDate != null) {
                    val diffMinutes = ((targetDate.time - currentDate.time) / 60000L).toInt()
                    val isAhead = diffMinutes >= 0
                    val text = when {
                        diffMinutes > 0 -> "$diffMinutes min ahead of schedule"
                        diffMinutes < 0 -> "${-diffMinutes} min behind schedule"
                        else -> "Exactly on schedule"
                    }
                    return ScheduleDelta(diffMinutes, text, isAhead)
                }
            } catch (e: Exception) {
                Log.w(TAG, "Error parsing target time: $targetStr", e)
            }
        }

        // 2. If offset_minutes_from_start is present
        val offsetMinutes = checkpoint.offsetMinutesFromStart
        val start = startTimeMillis
        if (offsetMinutes != null && start != null) {
            val elapsedMinutes = ((System.currentTimeMillis() - start) / 60000L).toInt()
            val delta = offsetMinutes - elapsedMinutes
            val isAhead = delta >= 0
            val text = when {
                delta > 0 -> "$delta min ahead of schedule"
                delta < 0 -> "${-delta} min behind schedule"
                else -> "Exactly on schedule"
            }
            return ScheduleDelta(delta, text, isAhead)
        }

        return null
    }

    private fun haversineMiles(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val a = sin(dLat / 2.0).pow(2.0) +
                cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) *
                sin(dLon / 2.0).pow(2.0)
        val c = 2.0 * atan2(sqrt(a), sqrt(1.0 - a))
        return EARTH_RADIUS_MILES * c
    }

    override fun onProviderEnabled(provider: String) {
        Log.d(TAG, "Provider enabled: $provider")
    }

    override fun onProviderDisabled(provider: String) {
        Log.d(TAG, "Provider disabled: $provider")
    }

    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
}
