package com.roadtrip.copilot.model

import com.google.gson.annotations.SerializedName

data class CheckpointNotification(
    val title: String = "Upcoming Waypoint",
    val message: String = "",
    val speech: String = ""
)

data class Checkpoint(
    val id: String,
    val name: String,
    val lat: Double,
    val lng: Double,
    @SerializedName("trigger_radius_miles")
    val triggerRadiusMiles: Double = 0.5,
    @SerializedName("target_time")
    val targetTime: String? = null,
    @SerializedName("offset_minutes_from_start")
    val offsetMinutesFromStart: Int? = null,
    val notification: CheckpointNotification? = null
)

data class Day(
    val day: Int,
    val date: String,
    val timezone: String? = null,
    val title: String? = null,
    val checkpoints: List<Checkpoint> = emptyList()
)

data class Itinerary(
    @SerializedName("trip_name")
    val tripName: String,
    val date: String? = null,
    val timezone: String? = null,
    val days: List<Day>? = null,
    val checkpoints: List<Checkpoint>? = null
) {
    /**
     * Resolves the list of active checkpoints depending on whether this is
     * a multi-day itinerary (e.g. PHX -> ABQ) or a single-route itinerary (e.g. NY Test).
     */
    fun getCheckpointsForDay(dayNumber: Int): List<Checkpoint> {
        if (!checkpoints.isNullOrEmpty()) {
            return checkpoints
        }
        val day = days?.find { it.day == dayNumber }
        return day?.checkpoints ?: emptyList()
    }
}

data class ScheduleDelta(
    val deltaMinutes: Int,
    val statusText: String,
    val isAhead: Boolean
)

data class TriggeredAlert(
    val id: String,
    val name: String,
    val distanceMiles: Double,
    val title: String,
    val message: String,
    val speech: String
)

data class EvaluationResult(
    val currentLat: Double,
    val currentLng: Double,
    val speedMph: Double,
    val alerts: List<TriggeredAlert>,
    val nextCheckpoint: Checkpoint?,
    val distanceToNextMiles: Double?,
    val scheduleDelta: ScheduleDelta?
)
