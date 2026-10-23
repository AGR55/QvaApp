package com.qvaapply.sms

import android.content.Context
import android.net.Uri
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class ReceiptUploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val settings = SecureSettings(applicationContext)
        val baseUrl = settings.serverUrl
        val token = settings.deviceToken
        val serverUri = Uri.parse(baseUrl)
        if (!serverUri.scheme.equals("https", ignoreCase = true) || serverUri.host.isNullOrBlank() ||
            !Regex("^[A-Za-z0-9_-]{40,100}$").matches(token)) return Result.failure()
        ReceiptStore(applicationContext).use { store ->
            for (queued in store.pending()) {
                var connection: HttpURLConnection? = null
                try {
                    val r = queued.receipt
                    val payload = JSONObject().apply {
                        ReceiptPayload.toMap(r).forEach { (key, value) -> put(key, value) }
                    }.toString()
                    val activeConnection = (URL("$baseUrl/api/mobile/payment-receipts").openConnection() as HttpURLConnection).apply {
                        requestMethod = "POST"; connectTimeout = 15_000; readTimeout = 15_000
                        instanceFollowRedirects = false
                        setRequestProperty("Authorization", "Bearer $token")
                        setRequestProperty("Content-Type", "application/json; charset=utf-8")
                        doOutput = true
                    }
                    connection = activeConnection
                    activeConnection.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                    val code = activeConnection.responseCode
                    val responseText = (if (code in 200..299) activeConnection.inputStream else activeConnection.errorStream)
                        ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
                    val accepted = if (code == 200 || code == 202) runCatching { JSONObject(responseText).optBoolean("ok") }.getOrDefault(false) else false
                    if (accepted) store.markSent(queued.id)
                    else {
                        store.markError(queued.id, "HTTP $code")
                        if (code == 408 || code == 429) return Result.retry()
                        if (code == 401 || code == 403 || code in 400..499) return Result.failure()
                        return Result.retry()
                    }
                } catch (e: Exception) {
                    store.markError(queued.id, e.javaClass.simpleName)
                    return Result.retry()
                } finally {
                    connection?.disconnect()
                }
            }
            return Result.success()
        }
    }
}
