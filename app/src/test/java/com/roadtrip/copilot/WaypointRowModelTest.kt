package com.roadtrip.copilot

import com.roadtrip.copilot.model.Checkpoint
import com.roadtrip.copilot.model.WaypointRows
import com.roadtrip.copilot.model.WaypointStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WaypointRowModelTest {

    private fun cp(id: String, arrival: String? = null, dwell: Int? = null) =
        Checkpoint(id = id, name = "Stop $id", dwellMinutes = dwell).also { it.formattedTargetTime = arrival }

    private val stops = listOf(
        cp("a", "2:30 PM", 0),
        cp("b", "4:30 PM", 15),
        cp("c", "Oct 9, 6:00 PM", 90)
    )

    private fun statuses(nextId: String?, hasTelemetry: Boolean = true) =
        WaypointRows.build(stops, nextId, hasTelemetry).map { it.status }

    @Test
    fun beforeAnyTelemetryAllStopsAreUpcoming() {
        assertEquals(List(3) { WaypointStatus.UPCOMING }, statuses(null, hasTelemetry = false))
    }

    @Test
    fun atDepartureFirstStopIsNext() {
        assertEquals(
            listOf(WaypointStatus.NEXT, WaypointStatus.UPCOMING, WaypointStatus.UPCOMING),
            statuses("a")
        )
    }

    @Test
    fun midTripMarksEarlierStopsPassed() {
        assertEquals(
            listOf(WaypointStatus.PASSED, WaypointStatus.NEXT, WaypointStatus.UPCOMING),
            statuses("b")
        )
    }

    @Test
    fun noNextStopMeansTripComplete() {
        assertEquals(List(3) { WaypointStatus.PASSED }, statuses(null))
    }

    @Test
    fun unknownNextIdLeavesEverythingUpcoming() {
        assertEquals(List(3) { WaypointStatus.UPCOMING }, statuses("zzz"))
    }

    @Test
    fun rowsAreNumberedFromOneAndKeepNames() {
        val rows = WaypointRows.build(stops, "a", true)
        assertEquals(listOf(1, 2, 3), rows.map { it.number })
        assertEquals("Stop b", rows[1].name)
    }

    @Test
    fun passedCountCountsOnlyPassedRows() {
        assertEquals(1, WaypointRows.passedCount(WaypointRows.build(stops, "b", true)))
    }

    @Test
    fun detailShowsArriveStayAndDepart() {
        assertEquals("Arrive 4:30 PM · Stay 15 min · Depart 4:45 PM", WaypointRows.detailLine(stops[1]))
    }

    @Test
    fun zeroDwellShowsArrivalOnly() {
        assertEquals("Arrive 2:30 PM", WaypointRows.detailLine(stops[0]))
    }

    @Test
    fun nullDwellShowsArrivalOnly() {
        assertEquals("Arrive 9:05 AM", WaypointRows.detailLine(cp("x", "9:05 AM", null)))
    }

    @Test
    fun datePrefixedArrivalKeepsPrefixAndDeparturesIsTimeOnly() {
        assertEquals("Arrive Oct 9, 6:00 PM · Stay 1 hr 30 min · Depart 7:30 PM", WaypointRows.detailLine(stops[2]))
    }

    @Test
    fun missingArrivalStillShowsStay() {
        assertEquals("Stay 20 min", WaypointRows.detailLine(cp("x", null, 20)))
    }

    @Test
    fun nothingToShowGivesEmptyDetail() {
        assertEquals("", WaypointRows.detailLine(cp("x")))
    }

    @Test
    fun departureCrossingNoonAndMidnight() {
        assertEquals("12:10 PM", WaypointRows.departureText("11:40 AM", 30))
        assertEquals("12:15 AM (+1 day)", WaypointRows.departureText("11:45 PM", 30))
        assertEquals("12:00 AM (+1 day)", WaypointRows.departureText("11:30 PM", 30))
    }

    @Test
    fun unparseableArrivalGivesNoDeparture() {
        assertNull(WaypointRows.departureText("soon", 30))
        assertNull(WaypointRows.departureText(null, 30))
    }

    @Test
    fun dwellFormatting() {
        assertEquals("45 min", WaypointRows.formatDwell(45))
        assertEquals("2 hr", WaypointRows.formatDwell(120))
        assertEquals("1 hr 5 min", WaypointRows.formatDwell(65))
    }
}
