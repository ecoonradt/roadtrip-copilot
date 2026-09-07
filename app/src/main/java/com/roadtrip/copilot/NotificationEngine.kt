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
import androidx.core.app.Person
import androidx.core.app.RemoteInput

class NotificationEngine(private val context: Context) {

    companion object {
        const val CHANNEL_STATUS_ID = "copilot_status_channel"
        const val CHANNEL_ALERT_ID = "copilot_alert_channel_v3"
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
        val soundUri = android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_NOTIFICATION)
        val audioAttr = android.media.AudioAttributes.Builder()
            .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

        val alertChannel = NotificationChannel(
            CHANNEL_ALERT_ID,
            context.getString(R.string.channel_alert_name),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = context.getString(R.string.channel_alert_desc)
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 350, 200, 350)
            setSound(soundUri, audioAttr)
            setShowBadge(true)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
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
        targetTime: String? = null,
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

        val nextPart = buildString {
            append("Next: $nextCheckpoint")
            if (distanceMiles != null) {
                append(" (%.1f mi)".format(distanceMiles))
            }
            if (!targetTime.isNullOrBlank()) {
                append(" • Target: $targetTime")
            }
        }
        val subtext = "$nextPart • Pace: $paceStatus"

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
        val alertId = ALERT_NOTIFICATION_ID_BASE + (alertCounter++ % 50)

        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            alertId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // 1. Android Auto Reply Action (with RemoteInput for voice response)
        val remoteInput = RemoteInput.Builder(NotificationReceiver.KEY_TEXT_REPLY)
            .setLabel("Acknowledge")
            .build()

        val replyIntent = Intent(context, NotificationReceiver::class.java).apply {
            action = NotificationReceiver.ACTION_REPLY
            putExtra(NotificationReceiver.EXTRA_NOTIFICATION_ID, alertId)
        }
        val replyPendingIntent = PendingIntent.getBroadcast(
            context,
            alertId * 10 + 1,
            replyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        )

        val replyAction = NotificationCompat.Action.Builder(
            R.drawable.ic_copilot,
            "Acknowledge",
            replyPendingIntent
        )
            .addRemoteInput(remoteInput)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .build()

        // 2. Android Auto Dismiss / Mark-as-read Action
        val markReadIntent = Intent(context, NotificationReceiver::class.java).apply {
            action = NotificationReceiver.ACTION_MARK_AS_READ
            putExtra(NotificationReceiver.EXTRA_NOTIFICATION_ID, alertId)
        }
        val markReadPendingIntent = PendingIntent.getBroadcast(
            context,
            alertId * 10 + 2,
            markReadIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val markReadAction = NotificationCompat.Action.Builder(
            R.drawable.ic_copilot,
            "Dismiss",
            markReadPendingIntent
        )
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build()

        // 3. MessagingStyle structure required for Android Auto projection
        val driverPerson = Person.Builder()
            .setName("Driver")
            .setKey("driver_user")
            .build()

        val copilotPerson = Person.Builder()
            .setName("Roadtrip Co-Pilot")
            .setKey("copilot_assistant")
            .setBot(true)
            .build()

        val messagingStyle = NotificationCompat.MessagingStyle(driverPerson)
            .setConversationTitle(title)
            .addMessage(
                NotificationCompat.MessagingStyle.Message(
                    message,
                    System.currentTimeMillis(),
                    copilotPerson
                )
            )

        val carExtender = CarExtender()
            .setColor(context.getColor(R.color.accent))

        val notification = NotificationCompat.Builder(context, CHANNEL_ALERT_ID)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(messagingStyle)
            .setSmallIcon(R.drawable.ic_copilot)
            .setContentIntent(pendingIntent)
            .addAction(replyAction)
            .addAction(markReadAction)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setVibrate(longArrayOf(0, 350, 200, 350))
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setTimeoutAfter(15000) // Tucks away after 15 seconds into the AA drawer
            .extend(carExtender)
            .build()

        try {
            notificationManager.notify(alertId, notification)
        } catch (e: SecurityException) {
            // Handled when POST_NOTIFICATIONS permission not yet granted
        }
    }
}
