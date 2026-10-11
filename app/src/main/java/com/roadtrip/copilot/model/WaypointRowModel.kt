package com.roadtrip.copilot.model

import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale

enum class WaypointStatus { PASSED, NEXT, UPCOMING }

/**
 * Presentation-only row for the phone dashboard itinerary list.
 * [detail] is a ready-to-display line such as "Arrive 4:30 PM · Stay 15 min · Depart 4:45 PM".
 */
data class WaypointRowModel(
    val number: Int,
    val name: String,
    val status: WaypointStatus,
    val detail: String
)

/**
 * Pure, read-only formatting of already-loaded [Checkpoint] data. Never mutates checkpoints
 * and has no Android or service dependencies.
 */
object WaypointRows {

    private val timeFormatter = DateTimeFormatter.ofPattern("h:mm a", Locale.US)
    private const val MINUTES_PER_DAY = 24 * 60

    /**
     * @param nextId id of the next unvisited checkpoint reported by telemetry (null if none remain).
     * @param hasTelemetry false before any telemetry has been published; all stops are then upcoming.
     */
    fun build(
        checkpoints: List<Checkpoint>,
        nextId: String?,
        hasTelemetry: Boolean
    ): List<WaypointRowModel> {
        val nextIndex = when {
            !hasTelemetry -> -1
            nextId == null -> checkpoints.size // every stop has been passed
            else -> checkpoints.indexOfFirst { it.id == nextId }
        }
        return checkpoints.mapIndexed { index, cp ->
            val status = when {
                nextIndex < 0 -> WaypointStatus.UPCOMING
                index < nextIndex -> WaypointStatus.PASSED
                index == nextIndex -> WaypointStatus.NEXT
                else -> WaypointStatus.UPCOMING
            }
            WaypointRowModel(index + 1, cp.name, status, detailLine(cp))
        }
    }

    fun passedCount(rows: List<WaypointRowModel>): Int = rows.count { it.status == WaypointStatus.PASSED }

    fun detailLine(cp: Checkpoint): String {
        val arrival = cp.formattedTargetTime?.takeIf { it.isNotBlank() }
        val dwell = cp.dwellMinutes?.takeIf { it > 0 }
        val parts = mutableListOf<String>()
        if (arrival != null) parts += "Arrive $arrival"
        if (dwell != null) {
            parts += "Stay ${formatDwell(dwell)}"
            departureText(arrival, dwell)?.let { parts += "Depart $it" }
        }
        return parts.joinToString(" · ")
    }

    fun formatDwell(minutes: Int): String {
        val hours = minutes / 60
        val mins = minutes % 60
        return when {
            hours == 0 -> "$mins min"
            mins == 0 -> "$hours hr"
            else -> "$hours hr $mins min"
        }
    }

    /**
     * Adds [dwellMinutes] to the wall-clock time in [formattedArrival] ("4:30 PM" or "Oct 9, 4:30 PM").
     * The arrival text is already local to the stop, so no timezone is needed.
     * Returns null when the arrival cannot be parsed.
     */
    fun departureText(formattedArrival: String?, dwellMinutes: Int): String? {
        if (formattedArrival.isNullOrBlank()) return null
        val arrivalTime = try {
            LocalTime.parse(formattedArrival.substringAfterLast(", ").trim(), timeFormatter)
        } catch (e: Exception) {
            return null
        }
        val totalMinutes = arrivalTime.hour * 60 + arrivalTime.minute + dwellMinutes
        val days = totalMinutes / MINUTES_PER_DAY
        val text = arrivalTime.plusMinutes(dwellMinutes.toLong()).format(timeFormatter)
        return when (days) {
            0 -> text
            1 -> "$text (+1 day)"
            else -> "$text (+$days days)"
        }
    }
}
