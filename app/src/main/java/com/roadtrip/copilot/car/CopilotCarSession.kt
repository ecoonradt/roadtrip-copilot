package com.roadtrip.copilot.car

import android.content.Intent
import androidx.car.app.Screen
import androidx.car.app.Session
import com.roadtrip.copilot.CopilotService
import com.roadtrip.copilot.NotificationEngine

class CopilotCarSession : Session() {
    override fun onCreateScreen(intent: Intent): Screen {
        NotificationEngine.cancelAlerts(carContext, "car_session_created")
        CopilotService.getInstance()?.cancelAlerts("car_session_created")
        return CopilotDashboardScreen(carContext)
    }
}
