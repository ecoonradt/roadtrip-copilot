package com.roadtrip.copilot.car

import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import com.roadtrip.copilot.CopilotService

class RouteListScreen(carContext: CarContext) : Screen(carContext) {

    data class CarRouteOption(
        val title: String,
        val subtitle: String,
        val routeFile: String,
        val dayNumber: Int
    )

    private val availableRoutes = listOf(
        CarRouteOption(
            title = "Test Run: Albany to Nassau (NY)",
            subtitle = "19-mile outbound test route",
            routeFile = "test_itinerary.json",
            dayNumber = 1
        ),
        CarRouteOption(
            title = "Return Run: Nassau to Albany (NY)",
            subtitle = "19-mile return test route",
            routeFile = "test_itinerary_return.json",
            dayNumber = 1
        ),
        CarRouteOption(
            title = "Day 1: Phoenix to Sedona & Flagstaff",
            subtitle = "Oct 9 • PHX Airport → Oak Creek Canyon → Flagstaff",
            routeFile = "itinerary.json",
            dayNumber = 1
        ),
        CarRouteOption(
            title = "Day 2: Flagstaff to Shiprock & Chama",
            subtitle = "Oct 10 • Navajo Nation → Shiprock → Chama, NM",
            routeFile = "itinerary.json",
            dayNumber = 2
        ),
        CarRouteOption(
            title = "Day 3: Chama to Brazos Pass & Taos",
            subtitle = "Oct 11 • Brazos Cliffs → Rio Grande Gorge → Taos",
            routeFile = "itinerary.json",
            dayNumber = 3
        ),
        CarRouteOption(
            title = "Day 4: Taos to High Road to Santa Fe & ABQ",
            subtitle = "Oct 12 • High Road villages → Santa Fe Plaza → ABQ Airport",
            routeFile = "itinerary.json",
            dayNumber = 4
        )
    )

    override fun onGetTemplate(): Template {
        val currentFile = CopilotService.activeRouteFile.value
        val currentDay = CopilotService.activeDayNumber.value

        val listBuilder = ItemList.Builder()

        for (route in availableRoutes) {
            val isSelected = route.routeFile == currentFile && route.dayNumber == currentDay
            val titlePrefix = if (isSelected) "✓ " else ""

            listBuilder.addItem(
                Row.Builder()
                    .setTitle("$titlePrefix${route.title}")
                    .addText(route.subtitle)
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

        return ListTemplate.Builder()
            .setSingleList(listBuilder.build())
            .setTitle("Select Itinerary Route")
            .setHeaderAction(Action.BACK)
            .build()
    }
}
