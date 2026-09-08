package com.roadtrip.copilot.car

import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.lifecycle.lifecycleScope
import com.roadtrip.copilot.CopilotService
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class WaypointListScreen(carContext: CarContext) : Screen(carContext) {

    init {
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
            CopilotService.activeCheckpoints.collectLatest {
                invalidate()
            }
        }
    }

    override fun onGetTemplate(): Template {
        val checkpoints = CopilotService.activeCheckpoints.value
        val telemetry = CopilotService.telemetryFlow.value
        val isRunning = CopilotService.isRunning.value

        val nextCpId = telemetry?.nextCheckpoint?.id
        val nextIndex = if (isRunning && nextCpId != null) {
            val idx = checkpoints.indexOfFirst { it.id == nextCpId }
            if (idx >= 0) idx else 0
        } else {
            0
        }

        val listBuilder = ItemList.Builder()

        if (checkpoints.isEmpty()) {
            CopilotService.loadInitialRoute(carContext)
            listBuilder.addItem(
                Row.Builder()
                    .setTitle("Loading Waypoints...")
                    .addText("Loading route itinerary...")
                    .build()
            )
        } else {
            // Android Auto driver safety limits lists to 6 items when driving
            // Focus on showing upcoming checkpoints first
            val displayList = if (checkpoints.size > 6 && nextIndex > 1) {
                checkpoints.drop(nextIndex - 1).take(6)
            } else {
                checkpoints.take(6)
            }

            for (cp in displayList) {
                val cpIndex = checkpoints.indexOf(cp)
                val rowBuilder = Row.Builder()

                val timeStr = if (!cp.formattedTargetTime.isNullOrBlank()) "Target: ${cp.formattedTargetTime}" else "Target: --"

                when {
                    cpIndex < nextIndex -> {
                        rowBuilder.setTitle("✓ ${cp.name}")
                        rowBuilder.addText("$timeStr • Passed")
                    }
                    cpIndex == nextIndex -> {
                        val distStr = telemetry?.distanceToNextMiles?.let { " • %.1f mi away".format(it) } ?: ""
                        rowBuilder.setTitle("▶ ${cp.name} (NEXT)")
                        rowBuilder.addText("$timeStr$distStr")
                    }
                    else -> {
                        rowBuilder.setTitle(cp.name)
                        rowBuilder.addText(timeStr)
                    }
                }

                listBuilder.addItem(rowBuilder.build())
            }
        }

        return ListTemplate.Builder()
            .setSingleList(listBuilder.build())
            .setTitle("Waypoints Itinerary")
            .setHeaderAction(Action.BACK)
            .build()
    }
}
