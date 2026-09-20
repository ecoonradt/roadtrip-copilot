package com.roadtrip.copilot

import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class CopilotServiceRestartTest {

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        val prefs = context.getSharedPreferences(CopilotService.PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
    }

    @Test
    fun testRestartWithNullIntentRestoresFromPreferences() {
        // Pre-populate preferences as if a multi-day route was selected
        val prefs = context.getSharedPreferences(CopilotService.PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit()
            .putString(CopilotService.PREF_ROUTE_FILE, "custom_albuquerque.json")
            .putInt(CopilotService.PREF_DAY_NUMBER, 3)
            .commit()

        val serviceController = Robolectric.buildService(CopilotService::class.java)
        val service = serviceController.create().get()

        // Simulate OS-initiated restart where intent is null
        service.onStartCommand(null, 0, 1)

        // Verify active route in service matches what was saved in preferences
        assertEquals("custom_albuquerque.json", CopilotService.activeRouteFile.value)
        assertEquals(3, CopilotService.activeDayNumber.value)

        serviceController.destroy()
    }

    @Test
    fun testStartCommandWithIntentPersistsToPreferences() {
        val serviceController = Robolectric.buildService(CopilotService::class.java)
        val service = serviceController.create().get()

        val intent = Intent(context, CopilotService::class.java).apply {
            action = CopilotService.ACTION_START
            putExtra(CopilotService.EXTRA_ROUTE_FILE, "sedona_loop.json")
            putExtra(CopilotService.EXTRA_DAY_NUMBER, 2)
        }

        service.onStartCommand(intent, 0, 1)

        val prefs = context.getSharedPreferences(CopilotService.PREFS_NAME, Context.MODE_PRIVATE)
        assertEquals("sedona_loop.json", prefs.getString(CopilotService.PREF_ROUTE_FILE, null))
        assertEquals(2, prefs.getInt(CopilotService.PREF_DAY_NUMBER, 1))

        // Now simulate OS kill and restart with null intent
        service.onStartCommand(null, 0, 2)
        assertEquals("sedona_loop.json", CopilotService.activeRouteFile.value)
        assertEquals(2, CopilotService.activeDayNumber.value)

        serviceController.destroy()
    }
}
