package com.roadtrip.copilot

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class NotificationEngineTest {

    private lateinit var context: Context
    private lateinit var notificationEngine: NotificationEngine
    private lateinit var notificationManager: NotificationManager

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.cancelAll()
        notificationEngine = NotificationEngine(context)
    }

    @Test
    fun testPostingTwiceLeavesExactlyOneActiveAlert() {
        notificationEngine.postHeadsUpAlert("Alert 1", "Message 1")
        notificationEngine.postHeadsUpAlert("Alert 2", "Message 2")

        val active = notificationManager.activeNotifications.filter {
            it.id in NotificationEngine.ALERT_NOTIFICATION_ID..NotificationEngine.ALERT_NOTIFICATION_ID_LEGACY_MAX
        }
        assertEquals(1, active.size)
        assertEquals(NotificationEngine.ALERT_NOTIFICATION_ID, active[0].id)
    }

    @Test
    fun testCancelAlertsRemovesLegacyRangeIds() {
        // Post a notification with stable ID
        notificationEngine.postHeadsUpAlert("Current Alert", "Message")

        // Manually simulate legacy notifications in the 2000..2049 range
        val legacyBuilder = NotificationCompat.Builder(context, NotificationEngine.CHANNEL_ALERT_ID)
            .setContentTitle("Legacy Alert")
            .setContentText("Legacy Message")
            .setSmallIcon(R.drawable.ic_copilot)
        notificationManager.notify(2005, legacyBuilder.build())
        notificationManager.notify(2040, legacyBuilder.build())

        // Also post a non-alert notification (e.g. 1001) that should NOT be swept
        val otherBuilder = NotificationCompat.Builder(context, NotificationEngine.CHANNEL_STATUS_ID)
            .setContentTitle("Status")
            .setContentText("Ongoing")
            .setSmallIcon(R.drawable.ic_copilot)
        notificationManager.notify(1001, otherBuilder.build())

        val beforeCancel = notificationManager.activeNotifications
        assertTrue(beforeCancel.any { it.id == NotificationEngine.ALERT_NOTIFICATION_ID })
        assertTrue(beforeCancel.any { it.id == 2005 })
        assertTrue(beforeCancel.any { it.id == 2040 })
        assertTrue(beforeCancel.any { it.id == 1001 })

        notificationEngine.cancelAlerts("test_legacy_sweep")

        val afterCancel = notificationManager.activeNotifications
        val activeAlerts = afterCancel.filter {
            it.id in NotificationEngine.ALERT_NOTIFICATION_ID..NotificationEngine.ALERT_NOTIFICATION_ID_LEGACY_MAX
        }
        assertEquals(0, activeAlerts.size)
        // Ensure other notifications like 1001 are preserved
        assertTrue(afterCancel.any { it.id == 1001 })
    }

    @Test
    fun testNotificationReceiverCancelsAlertOnMarkAsReadAndReply() {
        notificationEngine.postHeadsUpAlert("Test Alert", "Message")
        var active = notificationManager.activeNotifications.filter { it.id == NotificationEngine.ALERT_NOTIFICATION_ID }
        assertEquals(1, active.size)

        // Broadcast ACTION_MARK_AS_READ
        val markReadIntent = Intent(context, NotificationReceiver::class.java).apply {
            action = NotificationReceiver.ACTION_MARK_AS_READ
            putExtra(NotificationReceiver.EXTRA_NOTIFICATION_ID, NotificationEngine.ALERT_NOTIFICATION_ID)
        }
        NotificationReceiver().onReceive(context, markReadIntent)

        active = notificationManager.activeNotifications.filter { it.id == NotificationEngine.ALERT_NOTIFICATION_ID }
        assertEquals(0, active.size)

        // Post again and broadcast ACTION_REPLY
        notificationEngine.postHeadsUpAlert("Test Alert 2", "Message 2")
        active = notificationManager.activeNotifications.filter { it.id == NotificationEngine.ALERT_NOTIFICATION_ID }
        assertEquals(1, active.size)

        val replyIntent = Intent(context, NotificationReceiver::class.java).apply {
            action = NotificationReceiver.ACTION_REPLY
            putExtra(NotificationReceiver.EXTRA_NOTIFICATION_ID, NotificationEngine.ALERT_NOTIFICATION_ID)
        }
        NotificationReceiver().onReceive(context, replyIntent)

        active = notificationManager.activeNotifications.filter { it.id == NotificationEngine.ALERT_NOTIFICATION_ID }
        assertEquals(0, active.size)
    }
}
