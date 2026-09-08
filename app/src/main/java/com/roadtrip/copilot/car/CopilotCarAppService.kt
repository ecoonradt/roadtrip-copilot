package com.roadtrip.copilot.car

import androidx.car.app.CarAppService
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator

class CopilotCarAppService : CarAppService() {
    override fun createHostValidator(): HostValidator {
        // Permits connections from Android Auto host in developer/sideload environments
        return HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
    }

    override fun onCreateSession(): Session {
        com.roadtrip.copilot.CopilotService.loadInitialRoute(this)
        return CopilotCarSession()
    }
}
