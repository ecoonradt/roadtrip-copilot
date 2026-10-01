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
    val notification: CheckpointNotification? = null,
    val type: String? = null,
    @SerializedName("dwell_minutes")
    val dwellMinutes: Int? = null,
    @SerializedName("place_name")
    val placeName: String? = null,
    @SerializedName("google_place_id")
    val googlePlaceId: String? = null,
    @SerializedName("address")
    val address: String? = null,
    @SerializedName("is_route_anchor")
    val isRouteAnchor: Boolean? = null,
    var targetEpochMillis: Long? = null,
    var formattedTargetTime: String? = null
) {
    val isSilentStop: Boolean
        get() = type.equals("stop", ignoreCase = true) || type.equals("general_stop", ignoreCase = true)

    val shouldAlert: Boolean
        get() = !isSilentStop
}

data class Day(
    val day: Int,
    val date: String,
    val timezone: String? = null,
    val title: String? = null,
    val origin: String? = null,
    val destination: String? = null,
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

    /**
     * Resolves the list of active checkpoints with computed target epoch millisecond timestamps.
     * For ad-hoc routes (e.g. test drives), targets are computed dynamically from [tripStartTimeMillis]
     * plus [Checkpoint.offsetMinutesFromStart].
     * For fixed itineraries (e.g. PHX -> ABQ), targets are resolved using the Day's ISO date,
     * route timezone, and [Checkpoint.targetTime].
     */
    fun resolveCheckpointsForDay(dayNumber: Int, tripStartTimeMillis: Long): List<Checkpoint> {
        val rawCheckpoints = getCheckpointsForDay(dayNumber)
        val day = days?.find { it.day == dayNumber }
        val dateStr = day?.date ?: this.date
        val tzStr = day?.timezone ?: this.timezone ?: "America/Phoenix"
        val zoneId = try {
            java.time.ZoneId.of(tzStr)
        } catch (e: Exception) {
            java.time.ZoneId.systemDefault()
        }

        val timeFormatter = java.time.format.DateTimeFormatter.ofPattern("h:mm a", java.util.Locale.US)
        val monthDayTimeFormatter = java.time.format.DateTimeFormatter.ofPattern("MMM d, h:mm a", java.util.Locale.US)

        return rawCheckpoints.map { cp ->
            val resolved = cp.copy()
            if (!cp.targetTime.isNullOrBlank() && !dateStr.isNullOrBlank()) {
                // Fixed Itinerary: Parse ISO date + target_time + timezone
                try {
                    val localDate = java.time.LocalDate.parse(dateStr)
                    val timeStr = if (cp.targetTime.length == 5) "${cp.targetTime}:00" else cp.targetTime
                    val localTime = java.time.LocalTime.parse(timeStr)
                    val zdt = java.time.ZonedDateTime.of(localDate, localTime, zoneId)
                    val epoch = zdt.toInstant().toEpochMilli()
                    resolved.targetEpochMillis = epoch

                    // Format target: if date is today, show "4:30 PM", else show "Oct 9, 4:30 PM"
                    val todayInZone = java.time.LocalDate.now(zoneId)
                    resolved.formattedTargetTime = if (localDate == todayInZone) {
                        zdt.format(timeFormatter)
                    } else {
                        zdt.format(monthDayTimeFormatter)
                    }
                } catch (e: Exception) {
                    // Fallback to null if parsing fails
                }
            } else if (cp.offsetMinutesFromStart != null) {
                // Ad-hoc Trip: Dynamic target from trip start time
                val epoch = tripStartTimeMillis + (cp.offsetMinutesFromStart * 60_000L)
                resolved.targetEpochMillis = epoch
                val targetInstant = java.time.Instant.ofEpochMilli(epoch)
                val targetZoned = targetInstant.atZone(java.time.ZoneId.systemDefault())
                resolved.formattedTargetTime = targetZoned.format(timeFormatter)
            }
            resolved
        }
    }
}

data class ScheduleDelta(
    val deltaMinutes: Int,
    val statusText: String,
    val isAhead: Boolean
) {
    companion object {
        fun fromDeltaMillis(deltaMillis: Long): ScheduleDelta {
            val deltaMinutes = (deltaMillis / 60000L).toInt()
            val isAhead = deltaMillis >= 0
            val absMinutes = kotlin.math.abs(deltaMinutes)

            val text = when {
                absMinutes <= 1 -> "On schedule"
                absMinutes < 60 -> {
                    if (isAhead) "$absMinutes min ahead of schedule" else "$absMinutes min behind schedule"
                }
                absMinutes < 1440 -> {
                    val hours = absMinutes / 60
                    val mins = absMinutes % 60
                    val timePart = if (mins == 0) "$hours hr" else "$hours hr $mins min"
                    if (isAhead) "$timePart ahead of schedule" else "$timePart behind schedule"
                }
                else -> {
                    val days = absMinutes / 1440
                    val hours = (absMinutes % 1440) / 60
                    val timePart = if (hours == 0) "$days days" else "$days days, $hours hr"
                    if (isAhead) "$timePart ahead of schedule" else "$timePart behind schedule"
                }
            }
            return ScheduleDelta(deltaMinutes, text, isAhead)
        }
    }

    fun formatForSpeech(): String {
        if (statusText == "Awaiting Departure" || statusText == "Trip Date Passed") {
            return ""
        }
        val absMinutes = kotlin.math.abs(deltaMinutes)
        if (absMinutes <= 1) {
            return " You are on schedule."
        }
        val timePhrase = when {
            absMinutes < 60 -> "$absMinutes minutes"
            absMinutes < 1440 -> {
                val hours = absMinutes / 60
                val mins = absMinutes % 60
                if (mins == 0) "$hours hours" else "$hours hours and $mins minutes"
            }
            else -> {
                val days = absMinutes / 1440
                if (days == 1) "1 day" else "$days days"
            }
        }
        return if (isAhead) {
            " You are currently $timePhrase ahead of schedule."
        } else {
            " You are currently $timePhrase behind schedule."
        }
    }
}

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
