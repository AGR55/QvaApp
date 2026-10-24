package com.qvaapply.sms

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.work.*
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

internal data class ChatTarget(val uuid: String, val orderUuid: String?) {
    val id: String get() = "$uuid:${orderUuid ?: "fixed"}"
    companion object {
        fun fromIntent(intent: Intent?): ChatTarget? = parse(intent?.getStringExtra("chat_uuid"), intent?.getStringExtra("chat_order"))
        fun parse(uuid: String?, orderValue: String?): ChatTarget? {
            if(uuid==null) return null
            val order = orderValue?.takeIf { it.isNotBlank() }
            val pattern = Regex("^[A-Za-z0-9_-]{1,64}$")
            return if (pattern.matches(uuid) && (order == null || pattern.matches(order))) ChatTarget(uuid, order) else null
        }
    }
}

class ChatMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        SecureSettings(this).pushToken = token
        PushRegistrationWorker.enqueue(this)
    }
    override fun onMessageReceived(message: RemoteMessage) { ChatNotifications.show(this, message.data) }
}

internal object ChatNotifications {
    const val CHANNEL = "operation_chats_v1"
    fun enabled(context: Context): Boolean {
        val manager=context.getSystemService(NotificationManager::class.java)
        return manager.areNotificationsEnabled() && manager.getNotificationChannel(CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE
    }
    fun channel(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Mensajes de operaciones", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Chats normales y cada orden de ofertas por rango"
                lockscreenVisibility = NotificationCompat.VISIBILITY_PRIVATE
            })
    }
    @Synchronized fun show(context: Context, data: Map<String, String>) {
        val settings = SecureSettings(context)
        if (settings.operatorToken.isBlank() || settings.serverUrl.isBlank() || data["operatorId"] != settings.pushOperatorId || settings.pushOperatorId.isBlank()) return
        val uuid = data["uuid"] ?: return
        val order = data["orderUuid"].orEmpty().takeIf { it.isNotBlank() }
        val eventId = data["id"]?.takeIf { Regex("^[a-f0-9]{64}$").matches(it) } ?: return
        val intent = Intent(context, MainActivity::class.java).putExtra("chat_uuid", uuid).putExtra("chat_order", order)
        val target = ChatTarget.fromIntent(intent) ?: return
        val body = data["body"]?.take(1800) ?: return
        if (body.isBlank()) return
        channel(context)
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        if (!context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()) return
        val prefs = context.getSharedPreferences("chat_notification_delivery", Context.MODE_PRIVATE)
        if (prefs.contains(eventId)) return
        // Unique immutable pending intent routes every order to its own conversation.
        intent.data = Uri.parse("qvaapply://chat/${Uri.encode(target.id)}")
        intent.flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        val pending = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val sender = data["sender"]?.take(100) ?: "Contraparte"
        val style = NotificationCompat.MessagingStyle(Person.Builder().setName("Tú").build())
            .setConversationTitle("${data["title"].orEmpty().take(140)} · ${(order ?: uuid).take(8)}")
            .addMessage(body, data["createdAt"]?.toLongOrNull() ?: System.currentTimeMillis(), Person.Builder().setName(sender).build())
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_chat_notification).setContentTitle(sender).setContentText(body).setStyle(style)
            .setContentIntent(pending).setAutoCancel(true).setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE).setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setSubText("${if(order == null) "Operación" else "Orden"} ${(order ?: uuid).take(8)}")
            .build()
        val id = MessageDigest.getInstance("SHA-256").digest(eventId.toByteArray()).take(4).fold(0) { acc, byte -> (acc shl 8) or (byte.toInt() and 255) }
        context.getSystemService(NotificationManager::class.java).notify(eventId, id, notification)
        // Commit after display. A crash can replace the same tagged notification, never create another.
        val edit = prefs.edit().putLong(eventId, System.currentTimeMillis())
        prefs.all.entries.sortedByDescending { (it.value as? Long) ?: 0 }.drop(499).forEach { edit.remove(it.key) }
        edit.commit()
    }
    fun register(context: Context) {
        channel(context)
        FirebaseMessaging.getInstance().token.addOnSuccessListener {
            SecureSettings(context).pushToken = it
            PushRegistrationWorker.enqueue(context)
        }
    }
}

class PushRegistrationWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val settings = SecureSettings(applicationContext)
        if (settings.serverUrl.isBlank() || settings.operatorToken.isBlank() || settings.pushToken.isBlank()) return Result.success()
        val result = MobileApi.post(settings.serverUrl, settings.operatorToken, "/api/mobile/push-device", JSONObject().put("token", settings.pushToken))
        if (result.value?.optBoolean("ok") == true) { settings.pushOperatorId = result.value.optString("operatorId"); settings.pushRegistered = true; return Result.success() }
        settings.pushRegistered = false
        return if (runAttemptCount < 8) Result.retry() else Result.failure()
    }
    companion object {
        fun enqueue(context: Context) {
            WorkManager.getInstance(context).enqueueUniqueWork("chat-push-registration", ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<PushRegistrationWorker>()
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
        }
    }
}
