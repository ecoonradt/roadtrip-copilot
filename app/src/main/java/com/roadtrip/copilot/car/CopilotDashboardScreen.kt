package com.roadtrip.copilot.car

import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarColor
import androidx.car.app.model.CarText
import androidx.car.app.model.Pane
import androidx.car.app.model.PaneTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.lifecycle.lifecycleScope
import com.roadtrip.copilot.CopilotService
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class CopilotDashboardScreen(carContext: CarContext) : Screen(carContext) {

    init {
        CopilotService.loadInitialRoute(carContext)
        lifecycleScope.launch {
            CopilotService.isRunning.collectLatest {
                invalidate()
            }
        }
        lifecycleScope.launch {
            CopilotService.telemetryFlow.collectLatest {
                invalidate()
            }
        }
        lifecycleScope.launch {
            CopilotService.activeRouteTitle.collectLatest {
                invalidate()
            }
        }
    }

    override fun onGetTemplate(): Template {
        val isRunning = CopilotService.isRunning.value
        val telemetry = CopilotService.telemetryFlow.value
        val activeRoute = CopilotService.activeRouteTitle.value
        val activeFile = CopilotService.activeRouteFile.value
        val hasRoute = activeFile.isNotBlank()

        val paneBuilder = Pane.Builder()

        // Row 1: Next Milestone / Waypoint
        val nextCp = telemetry?.nextCheckpoint
        val distMiles = telemetry?.distanceToNextMiles
        val targetTime = nextCp?.formattedTargetTime

        val row1Builder = Row.Builder()
        if (!hasRoute) {
            row1Builder.setTitle("No Route Loaded")
            row1Builder.addText("Open phone app to scan or import an itinerary.")
        } else if (!isRunning) {
            row1Builder.setTitle("Co-Pilot Standby")
            val targetStr = if (!targetTime.isNullOrBlank()) " • Target: $targetTime" else ""
            val nextDesc = if (nextCp != null) "Next: ${nextCp.name}$targetStr" else "Tap 'Start Trip' below to begin tracking."
            row1Builder.addText(nextDesc)
        } else if (nextCp != null) {
            row1Builder.setTitle("Next: ${nextCp.name}")
            val targetStr = if (!targetTime.isNullOrBlank()) " • Target: $targetTime" else ""
            val distStr = if (distMiles != null) "%.1f mi away".format(distMiles) else "Calculating distance..."
            row1Builder.addText("$distStr$targetStr")
        } else {
            row1Builder.setTitle("All Checkpoints Visited")
            row1Builder.addText("Completed scheduled itinerary milestones for this leg.")
        }
        paneBuilder.addRow(row1Builder.build())

        // Row 2: Pace Telemetry & GPS Speed
        val speedMph = if (isRunning) (telemetry?.speedMph ?: 0.0) else 0.0
        val scheduleDelta = telemetry?.scheduleDelta
        val paceStatus = if (isRunning) (scheduleDelta?.statusText ?: "On Schedule") else "Standby"

        val row2Builder = Row.Builder()
            .setTitle("Pace: $paceStatus")
            .addText(if (isRunning) "GPS Speed: %.0f mph".format(speedMph) else "GPS Speed: --")
        paneBuilder.addRow(row2Builder.build())

        // Row 3: Active Route & Day
        val row3Builder = Row.Builder()
            .setTitle(if (hasRoute) activeRoute else "No Active Route")
            .addText(if (isRunning) "Trip Active • Tracking milestones" else if (hasRoute) "Standby • Tap 'Start Trip' below" else "Awaiting route selection on phone")
        paneBuilder.addRow(row3Builder.build())

        // Actions in the pane
        if (isRunning) {
            paneBuilder.addAction(
                Action.Builder()
                    .setTitle("End Trip")
                    .setBackgroundColor(CarColor.RED)
                    .setOnClickListener {
                        CopilotService.stopRoute(carContext)
                    }
                    .build()
            )
        } else if (hasRoute) {
            paneBuilder.addAction(
                Action.Builder()
                    .setTitle("Start Trip")
                    .setBackgroundColor(CarColor.GREEN)
                    .setOnClickListener {
                        val routeFile = CopilotService.activeRouteFile.value
                        val dayNum = CopilotService.activeDayNumber.value
                        CopilotService.startRoute(carContext, routeFile, dayNum)
                    }
                    .build()
            )
        } else {
            paneBuilder.addAction(
                Action.Builder()
                    .setTitle("Select Route")
                    .setOnClickListener {
                        screenManager.push(RouteListScreen(carContext))
                    }
                    .build()
            )
        }

        paneBuilder.addAction(
            Action.Builder()
                .setTitle("Waypoints")
                .setOnClickListener {
                    screenManager.push(WaypointListScreen(carContext))
                }
                .build()
        )

        val actionStrip = ActionStrip.Builder()
            .addAction(
                Action.Builder()
                    .setTitle("Settings")
                    .setOnClickListener {
                        screenManager.push(SettingsScreen(carContext))
                    }
                    .build()
            )
            .build()

        return PaneTemplate.Builder(paneBuilder.build())
            .setTitle("Roadtrip Co-Pilot")
            .setHeaderAction(Action.APP_ICON)
            .setActionStrip(actionStrip)
            .build()
    }
}
