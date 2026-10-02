package com.roadtrip.copilot.model

/**
 * Represents an available route or driving leg that can be selected in the co-pilot.
 *
 * @property title The display title (e.g. "Day 1: Red Rock Entry & Oak Creek Canyon Switchbacks").
 * @property routeFile The filename of the itinerary JSON (e.g. "itinerary.json", "custom_trip.json").
 * @property dayNumber The 1-indexed day number for multi-day itineraries, or 1 for single routes.
 * @property isAsset True if the itinerary file is bundled in APK assets, false if stored on filesystem.
 * @property absolutePath The absolute filesystem path if stored on disk, or null if an asset.
 * @property subtitle An optional secondary description (e.g. "PHX Airport → Flagstaff" or "19-mile test").
 */
data class RouteOption(
    val title: String,
    val routeFile: String,
    val dayNumber: Int,
    val isAsset: Boolean = false,
    val absolutePath: String? = null,
    val subtitle: String? = null,
    val tripName: String? = null,
    val googleMapsUrl: String? = null
) {
    override fun toString(): String = title
}
