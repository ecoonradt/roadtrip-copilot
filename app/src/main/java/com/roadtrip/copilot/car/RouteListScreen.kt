package com.roadtrip.copilot.car

import androidx.annotation.VisibleForTesting
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.lifecycle.lifecycleScope
import com.roadtrip.copilot.CopilotService
import com.roadtrip.copilot.model.RouteOption
import com.roadtrip.copilot.model.RouteRepository
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * Android Auto Screen displaying available routes and driving legs for selection.
 *
 * Conforms to Car App Library driving distraction guidelines by strictly enforcing
 * the 6-item list constraint ([MAX_ITEMS_PER_PAGE]) via deterministic pagination.
 */
class RouteListScreen(
    carContext: CarContext,
    private val repository: RouteRepository = RouteRepository.getInstance(carContext)
) : Screen(carContext) {

    private var currentPage: Int = 0
    private var hasUserNavigated: Boolean = false

    init {
        // Initialize page to the active route's page if present
        syncCurrentPageToActiveRoute()

        lifecycleScope.launch {
            repository.routes.collectLatest {
                invalidate()
            }
        }
        lifecycleScope.launch {
            CopilotService.activeRouteFile.collectLatest {
                if (!hasUserNavigated) {
                    syncCurrentPageToActiveRoute()
                }
                invalidate()
            }
        }
        lifecycleScope.launch {
            CopilotService.activeDayNumber.collectLatest {
                if (!hasUserNavigated) {
                    syncCurrentPageToActiveRoute()
                }
                invalidate()
            }
        }
    }

    private fun syncCurrentPageToActiveRoute() {
        val currentFile = CopilotService.activeRouteFile.value
        val currentDay = CopilotService.activeDayNumber.value
        val routes = repository.getRouteOptions()
        val activeIndex = routes.indexOfFirst {
            it.routeFile == currentFile && it.dayNumber == currentDay
        }
        if (activeIndex >= 0) {
            currentPage = activeIndex / MAX_ITEMS_PER_PAGE
        }
    }

    override fun onGetTemplate(): Template {
        val routes = repository.getRouteOptions()
        val currentFile = CopilotService.activeRouteFile.value
        val currentDay = CopilotService.activeDayNumber.value

        val totalPages = if (routes.isEmpty()) 1 else (routes.size + MAX_ITEMS_PER_PAGE - 1) / MAX_ITEMS_PER_PAGE

        // Clamp currentPage within [0, totalPages - 1]
        if (currentPage >= totalPages) {
            currentPage = maxOf(0, totalPages - 1)
        }
        if (currentPage < 0) {
            currentPage = 0
        }

        val listBuilder = ItemList.Builder()

        if (routes.isEmpty()) {
            listBuilder.addItem(
                Row.Builder()
                    .setTitle("No routes available")
                    .addText("Import a route in phone app")
                    .build()
            )
        } else {
            val startIndex = currentPage * MAX_ITEMS_PER_PAGE
            val endIndex = minOf(startIndex + MAX_ITEMS_PER_PAGE, routes.size)
            val pageRoutes = routes.subList(startIndex, endIndex)

            for (route in pageRoutes) {
                val isSelected = route.routeFile == currentFile && route.dayNumber == currentDay
                val titlePrefix = if (isSelected) "✓ " else ""

                val displayTitle = when {
                    route.title.isNotBlank() -> route.title
                    route.dayNumber > 0 -> "Day ${route.dayNumber}"
                    else -> "Custom Route"
                }

                val displaySubtitle = when {
                    !route.subtitle.isNullOrBlank() -> route.subtitle
                    route.dayNumber > 0 -> "Day ${route.dayNumber}"
                    else -> "Custom Route"
                }

                listBuilder.addItem(
                    Row.Builder()
                        .setTitle("$titlePrefix$displayTitle")
                        .addText(displaySubtitle)
                        .setOnClickListener {
                            val running = CopilotService.isRunning.value
                            CopilotService.setSelectedRoute(
                                carContext,
                                route.routeFile,
                                route.dayNumber,
                                autoRestartIfRunning = running
                            )
                            screenManager.pop()
                        }
                        .build()
                )
            }
        }

        val templateTitle = if (totalPages > 1) {
            "Select Route (${currentPage + 1}/$totalPages)"
        } else {
            "Select Itinerary Route"
        }

        val templateBuilder = ListTemplate.Builder()
            .setSingleList(listBuilder.build())
            .setTitle(templateTitle)
            .setHeaderAction(Action.BACK)

        if (totalPages > 1) {
            val actionStripBuilder = ActionStrip.Builder()
            if (currentPage > 0) {
                actionStripBuilder.addAction(
                    Action.Builder()
                        .setTitle("◀ Prev")
                        .setOnClickListener {
                            currentPage--
                            hasUserNavigated = true
                            invalidate()
                        }
                        .build()
                )
            }
            if (currentPage < totalPages - 1) {
                actionStripBuilder.addAction(
                    Action.Builder()
                        .setTitle("Next ▶")
                        .setOnClickListener {
                            currentPage++
                            hasUserNavigated = true
                            invalidate()
                        }
                        .build()
                )
            }
            templateBuilder.setActionStrip(actionStripBuilder.build())
        }

        return templateBuilder.build()
    }

    @VisibleForTesting
    internal fun getCurrentPage(): Int = currentPage

    @VisibleForTesting
    internal fun setCurrentPage(page: Int) {
        currentPage = page
        hasUserNavigated = true
    }

    @VisibleForTesting
    internal fun getTotalPages(): Int {
        val count = repository.getRouteOptions().size
        return if (count == 0) 1 else (count + MAX_ITEMS_PER_PAGE - 1) / MAX_ITEMS_PER_PAGE
    }

    companion object {
        const val MAX_ITEMS_PER_PAGE = 6
    }
}
