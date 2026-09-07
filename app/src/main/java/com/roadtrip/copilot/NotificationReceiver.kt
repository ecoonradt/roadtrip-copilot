package com.roadtrip.copilot

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput

class NotificationReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "NotificationReceiver"
        const val ACTION_REPLY = "com.roadtrip.copilot.ACTION_REPLY"
        const val ACTION_MARK_AS_READ = "com.roadtrip.copilot.ACTION_MARK_AS_READ"
        const val KEY_TEXT_REPLY = "key_text_reply"
        const val EXTRA_NOTIFICATION_ID = "extra_notification_id"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        val notifId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, -1)
        Log.i(TAG, "Notification action received: $action for notification id: $notifId")

        when (action) {
            ACTION_MARK_AS_READ -> {
                if (notifId != -1) {
                    NotificationManagerCompat.from(context).cancel(notifId)
                }
            }
            ACTION_REPLY -> {
                val remoteInput = RemoteInput.getResultsFromIntent(intent)
                val replyText = remoteInput?.getCharSequence(KEY_TEXT_REPLY)?.toString()
                Log.i(TAG, "Android Auto voice reply received: $replyText")
                if (notifId != -1) {
                    NotificationManagerCompat.from(context).cancel(notifId)
                }
            }
        }
    }
}
