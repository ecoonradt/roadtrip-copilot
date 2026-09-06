package com.roadtrip.copilot

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationCompat.CarExtender
import androidx.core.app.NotificationManagerCompat

class NotificationEngine(private val context: Context) {

    companion object {
        const val CHANNEL_STATUS_ID = "copilot_status_channel"
        const val CHANNEL_ALERT_ID = "copilot_alert_channel"
        const val FOREGROUND_NOTIFICATION_ID = 1001
        private const val ALERT_NOTIFICATION_ID_BASE = 2000
    }

    private val notificationManager = NotificationManagerCompat.from(context)
    private var alertCounter = 0

    init {
        createNotificationChannels()
    }

    private fun createNotificationChannels() {
        val sysManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        // Persistent foreground status channel
        val statusChannel = NotificationChannel(
            CHANNEL_STATUS_ID,
            context.getString(R.string.channel_status_name),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = context.getString(R.string.channel_status_desc)
            setShowBadge(false)
        }

        // Heads-up alert channel for upcoming waypoints
        val alertChannel = NotificationChannel(
            CHANNEL_ALERT_ID,
            context.getString(R.string.channel_alert_name),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = context.getString(R.string.channel_alert_desc)
            enableVibration(true)
            setShowBadge(true)
        }

        sysManager.createNotificationChannel(statusChannel)
        sysManager.createNotificationChannel(alertChannel)
    }

    /**
     * Builds the unkillable foreground service notification displaying upcoming milestone & pace.
     */
    fun buildForegroundNotification(
        nextCheckpoint: String = "Monitoring Route",
        distanceMiles: Double? = null,
        paceStatus: String = "On Schedule"
    ): Notification {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val subtext = if (distanceMiles != null) {
            "Next: $nextCheckpoint (%.1f mi) • %s".format(distanceMiles, paceStatus)
        } else {
            "Next: $nextCheckpoint • $paceStatus"
        }

        return NotificationCompat.Builder(context, CHANNEL_STATUS_ID)
            .setContentTitle("Roadtrip Co-Pilot Active")
            .setContentText(subtext)
            .setSmallIcon(R.drawable.ic_copilot)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    /**
     * Posts a high-priority heads-up card over Google Maps in Android Auto.
     */
    fun postHeadsUpAlert(title: String, message: String) {
        val carExtender = CarExtender()
            .setColor(context.getColor(R.color.accent))

        val notification = NotificationCompat.Builder(context, CHANNEL_ALERT_ID)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setSmallIcon(R.drawable.ic_copilot)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setAutoCancel(true)
            .setTimeoutAfter(8000) // Tucks away after 8 seconds into the drawer
            .extend(carExtender)
            .build()

        val alertId = ALERT_NOTIFICATION_ID_BASE + (alertCounter++ % 50)
        try {
            notificationManager.notify(alertId, notification)
        } catch (e: SecurityException) {
            // Handled when POST_NOTIFICATIONS permission not yet granted
        }
    }
}
