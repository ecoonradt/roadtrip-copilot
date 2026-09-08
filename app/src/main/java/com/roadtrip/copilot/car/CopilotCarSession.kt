package com.roadtrip.copilot.car

import android.content.Intent
import androidx.car.app.Screen
import androidx.car.app.Session

class CopilotCarSession : Session() {
    override fun onCreateScreen(intent: Intent): Screen {
        return CopilotDashboardScreen(carContext)
    }
}
