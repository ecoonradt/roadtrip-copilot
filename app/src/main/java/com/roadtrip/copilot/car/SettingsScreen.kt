package com.roadtrip.copilot.car

import android.content.Context
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.car.app.model.Toggle
import com.roadtrip.copilot.CopilotService

class SettingsScreen(carContext: CarContext) : Screen(carContext) {

    override fun onGetTemplate(): Template {
        val prefs = carContext.getSharedPreferences("copilot_prefs", Context.MODE_PRIVATE)
        val pauseMusic = prefs.getBoolean("pref_pause_music", true)

        val listBuilder = ItemList.Builder()

        // 1. Pause Music Completely Toggle
        val pauseToggle = Toggle.Builder { isChecked ->
            prefs.edit().putBoolean("pref_pause_music", isChecked).apply()
            CopilotService.getInstance()?.setPauseMusicInsteadOfDuck(isChecked)
            invalidate()
        }.setChecked(pauseMusic).build()

        listBuilder.addItem(
            Row.Builder()
                .setTitle("Pause Music During Alerts")
                .addText(
                    if (pauseMusic)
                        "ON: Pauses media cleanly during speech (Recommended)"
                    else
                        "OFF: Subtle volume dip (-14 dB ducking)"
                )
                .setToggle(pauseToggle)
                .build()
        )

        // 3. Audio Calibration Speech Loop
        listBuilder.addItem(
            Row.Builder()
                .setTitle("Calibrate Car Volume (12s Loop)")
                .addText("Speaks continuously so you can adjust the volume knob")
                .setOnClickListener {
                    CopilotService.calibrateAudio(carContext)
                }
                .build()
        )

        // 4. Test Audio Speech
        listBuilder.addItem(
            Row.Builder()
                .setTitle("Test Audio Speech")
                .addText("Speaks a sample waypoint announcement over car speakers")
                .setOnClickListener {
                    CopilotService.testAudio(carContext)
                }
                .build()
        )

        // 5. Test Alert & Ducking
        listBuilder.addItem(
            Row.Builder()
                .setTitle("Test Heads-Up Card & Alert")
                .addText("Posts a high-priority heads-up card and ducking test")
                .setOnClickListener {
                    CopilotService.testAlert(carContext)
                }
                .build()
        )

        // 6. Select Route / Day
        listBuilder.addItem(
            Row.Builder()
                .setTitle("Select Route / Day")
                .addText("Switch itinerary leg or choose test route")
                .setOnClickListener {
                    screenManager.push(RouteListScreen(carContext))
                }
                .build()
        )

        return ListTemplate.Builder()
            .setSingleList(listBuilder.build())
            .setTitle("Audio & System Settings")
            .setHeaderAction(Action.BACK)
            .build()
    }
}
