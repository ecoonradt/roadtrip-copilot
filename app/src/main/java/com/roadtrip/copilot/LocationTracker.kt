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
    private var lastVisitedPace: ScheduleDelta = ScheduleDelta(0, "On schedule", true)

    companion object {
        private const val TAG = "LocationTracker"
        private const val EARTH_RADIUS_MILES = 3958.8
    }

    fun setCheckpoints(checkpoints: List<Checkpoint>, initialStartTimeMillis: Long? = null) {
        activeCheckpoints = checkpoints
        visitedCheckpoints.clear()
        val start = initialStartTimeMillis ?: System.currentTimeMillis()
        startTimeMillis = start

        // Initial pace is always Awaiting Departure before departure point is reached
        lastVisitedPace = ScheduleDelta(0, "Awaiting Departure", true)

        Log.i(TAG, "Loaded ${checkpoints.size} checkpoints into LocationTracker. Initial pace: ${lastVisitedPace.statusText}")

        // Immediately evaluate against last known position so UI doesn't retain previous route data
        val lastKnown = try {
            locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                ?: locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
        } catch (e: SecurityException) {
            null
        }

        if (lastKnown != null) {
            val speedMph = if (lastKnown.hasSpeed()) lastKnown.speed * 2.23694 else 0.0
            evaluate(lastKnown.latitude, lastKnown.longitude, speedMph)
        } else {
            val firstCp = checkpoints.firstOrNull()
            onEvaluationResult(
                EvaluationResult(
                    currentLat = 0.0,
                    currentLng = 0.0,
                    speedMph = 0.0,
                    alerts = emptyList(),
                    nextCheckpoint = firstCp,
                    distanceToNextMiles = null,
                    scheduleDelta = lastVisitedPace
                )
            )
        }
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

    fun evaluate(currentLat: Double, currentLng: Double, speedMph: Double, evalTimeMillis: Long = System.currentTimeMillis()) {
        if (currentLat == 0.0 && currentLng == 0.0) {
            val firstUnvisited = activeCheckpoints.firstOrNull { it.id !in visitedCheckpoints }
            onEvaluationResult(
                EvaluationResult(
                    currentLat = 0.0,
                    currentLng = 0.0,
                    speedMph = 0.0,
                    alerts = emptyList(),
                    nextCheckpoint = firstUnvisited,
                    distanceToNextMiles = null,
                    scheduleDelta = lastVisitedPace
                )
            )
            return
        }

        val newAlerts = mutableListOf<TriggeredAlert>()

        // 1. Process geofences sequentially along the itinerary
        for (i in activeCheckpoints.indices) {
            val cp = activeCheckpoints[i]
            if (cp.id !in visitedCheckpoints) {
                val dist = haversineMiles(currentLat, currentLng, cp.lat, cp.lng)

                // Only trigger if entering checkpoint trigger radius
                if (dist <= cp.triggerRadiusMiles) {
                    // Mark this checkpoint and all previous checkpoints in the route as visited
                    for (prevIdx in 0..i) {
                        visitedCheckpoints.add(activeCheckpoints[prevIdx].id)
                    }

                    val notif = cp.notification
                    val delta = calculateScheduleDelta(cp, evalTimeMillis)
                    if (delta != null) {
                        lastVisitedPace = delta
                    }

                    val paceSpeech = delta?.formatForSpeech() ?: ""

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
            }
        }

        // 2. Determine next upcoming milestone: strictly the FIRST unvisited milestone in order.
        // Never jump ahead to a distant milestone just because Euclidean distance happens to be slightly closer!
        val nextCheckpoint = activeCheckpoints.firstOrNull { it.id !in visitedCheckpoints }
        val distToNext = nextCheckpoint?.let { haversineMiles(currentLat, currentLng, it.lat, it.lng) }

        val result = EvaluationResult(
            currentLat = currentLat,
            currentLng = currentLng,
            speedMph = speedMph,
            alerts = newAlerts,
            nextCheckpoint = nextCheckpoint,
            distanceToNextMiles = distToNext,
            scheduleDelta = lastVisitedPace
        )

        onEvaluationResult(result)
    }

    fun calculateScheduleDelta(checkpoint: Checkpoint?, currentTimeMillis: Long = System.currentTimeMillis()): ScheduleDelta? {
        if (checkpoint == null) return null

        // 1. Unified targetEpochMillis from pre-resolution (Fixed or Ad-hoc)
        val targetEpoch = checkpoint.targetEpochMillis
        if (targetEpoch != null) {
            val deltaMillis = targetEpoch - currentTimeMillis
            val deltaMinutes = (deltaMillis / 60000L).toInt()

            // If scheduled more than 24 hours in the future (e.g. testing in September for Oct 9 trip)
            if (deltaMinutes > 1440) {
                return ScheduleDelta(deltaMinutes, "Awaiting Departure", true)
            }
            if (deltaMinutes < -1440) {
                return ScheduleDelta(deltaMinutes, "Trip Date Passed", false)
            }
            return ScheduleDelta.fromDeltaMillis(deltaMillis)
        }

        // 2. Fallback if not pre-resolved:
        val offsetMinutes = checkpoint.offsetMinutesFromStart
        val start = startTimeMillis
        if (offsetMinutes != null && start != null) {
            val targetMillis = start + (offsetMinutes * 60_000L)
            val deltaMillis = targetMillis - currentTimeMillis
            return ScheduleDelta.fromDeltaMillis(deltaMillis)
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
