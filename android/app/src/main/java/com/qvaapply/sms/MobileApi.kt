package com.qvaapply.sms

import android.net.Uri
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.UnknownHostException
import java.net.ConnectException
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.MalformedURLException
import java.net.ProtocolException
import javax.net.ssl.SSLException

data class MobileOperation(
    val uuid: String,
    val side: String,
    val marketLabel: String,
    val currency: String,
    val amount: String,
    val receive: String,
    val rate: String,
    val status: String,
    val createdAt: String,
    val actions: List<String>,
    val orderUuid: String? = null,
    val role: String = "taker",
    val chatAvailable: Boolean = false,
    val market: String = marketLabel,
    val paymentAvailable: Boolean = false,
) {
    val id: String get() = "$uuid:${orderUuid ?: "fixed"}"
}

data class MobileAlert(val id: String, val type: String, val message: String, val createdAt: String, val operationUuid: String?)
data class ApiResponse<T>(val value: T?, val message: String, val uncertain: Boolean = false)

object MobileApi {
    private val uuidPattern = Regex("^[A-Za-z0-9_-]{1,100}$")

    fun get(baseUrl: String, token: String, path: String): ApiResponse<JSONObject> = request(baseUrl, token, path, "GET")
    fun delete(baseUrl: String, token: String, path: String): ApiResponse<JSONObject> = request(baseUrl, token, path, "DELETE")
    fun post(baseUrl: String, token: String, path: String, payload: JSONObject): ApiResponse<JSONObject> = request(baseUrl, token, path, "POST", payload.toString())
    fun sendChatImage(baseUrl: String, token: String, path: String, image: ByteArray, message: String, attemptId: String, progress: (Int) -> Unit): ApiResponse<JSONObject> {
        if (image.size > 1_048_576 || message.length > 599 || !Regex("^[A-Za-z0-9_-]{16,80}$").matches(attemptId)) return ApiResponse(null, "Imagen o envío inválidos.")
        val boundary = "chat-${java.util.UUID.randomUUID()}"
        val payload = ByteArrayOutputStream().apply {
            write("--$boundary\r\nContent-Disposition: form-data; name=\"attemptId\"\r\n\r\n$attemptId\r\n".toByteArray(Charsets.UTF_8))
            write("--$boundary\r\nContent-Disposition: form-data; name=\"message\"\r\n\r\n$message\r\n".toByteArray(Charsets.UTF_8))
            write("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"chat.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".toByteArray(Charsets.UTF_8))
            write(image)
            write("\r\n--$boundary--\r\n".toByteArray(Charsets.UTF_8))
        }.toByteArray()
        return request(baseUrl, token, path, "POST", upload = payload, contentType = "multipart/form-data; boundary=$boundary", progress = progress)
    }

    fun chatImage(baseUrl: String, token: String, path: String): ApiResponse<ByteArray> {
        if (!validChatImagePath(path) || !Uri.parse(baseUrl).scheme.equals("https", true) || !Regex("^[A-Za-z0-9_-]{40,100}$").matches(token)) return ApiResponse(null, "Imagen no disponible.")
        var connection: HttpURLConnection? = null
        return try {
            val active = URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection
            connection = active
            active.instanceFollowRedirects = false
            active.connectTimeout = 10_000
            active.readTimeout = 15_000
            active.setRequestProperty("Authorization", "Bearer $token")
            if (active.responseCode != 200 || active.contentType?.substringBefore(';') !in setOf("image/jpeg", "image/png")) return ApiResponse(null, "Imagen no disponible.")
            val bytes = active.inputStream.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (output.size() + count > 1_048_576) throw MobilePayloadException()
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            ApiResponse(bytes, "")
        } catch (cause: Exception) { ApiResponse(null, mobileRequestFailureMessage(cause,false)) }
        finally { connection?.disconnect() }
    }

    private fun validChatImagePath(path: String) = Regex("^/api/mobile/operations/[A-Za-z0-9_-]+/chat/images/[^/?#]+(?:\\?order=[A-Za-z0-9_-]+)?$").matches(path)
    fun simulate(baseUrl: String, token: String, input: JSONObject): ApiResponse<JSONObject> =
        request(baseUrl, token, "/api/mobile/simulate", "POST", input.toString()).let { it.copy(uncertain = false) }

    internal fun preparePayment(baseUrl: String, token: String, operation: MobileOperation): ApiResponse<AssistedPayment> {
        if(!uuidPattern.matches(operation.uuid) || operation.orderUuid?.let { !uuidPattern.matches(it) }==true)
            return ApiResponse(null,"Operación inválida.")
        val query=operation.orderUuid?.let {"?order=${Uri.encode(it)}"}.orEmpty()
        val response=get(baseUrl,token,"/api/mobile/operations/${Uri.encode(operation.uuid)}/payment-preview$query")
        val plan=response.value?.optJSONObject("data")?.let(AssistedPayment::parse)
        return if(plan!=null && plan.validFor(operation,System.currentTimeMillis())) ApiResponse(plan,"")
        else ApiResponse(null,if(response.value==null) response.message else "Los datos del pago cambiaron o están vencidos. Actualiza la operación.")
    }

    fun action(baseUrl: String, token: String, operationId: String, action: String, reference: String): ApiResponse<Unit> {
        if (!uuidPattern.matches(operationId) || action !in setOf("paid", "received", "cancel")) {
            return ApiResponse(null, "Acción inválida.")
        }
        val payload = JSONObject().apply { if (action == "paid") put("reference", reference) }.toString()
        val startedAt = android.os.SystemClock.elapsedRealtime()
        val response = request(baseUrl, token, "/api/mobile/operations/${Uri.encode(operationId)}/$action", "POST", payload)
        val confirmed = response.value?.optBoolean("ok", false) == true || response.message == "__NO_CONTENT__"
        val outcome = if (confirmed) "confirmed" else if (response.uncertain) "uncertain" else if (response.message == "Sin conexión") "offline" else "rejected"
        android.util.Log.i("QvaActionTiming", "action=$action transportMs=${android.os.SystemClock.elapsedRealtime() - startedAt} outcome=$outcome")
        return if (confirmed) ApiResponse(Unit, "Acción confirmada por el servidor.")
        else ApiResponse(null, response.message, response.uncertain)
    }

    private fun request(baseUrl: String, token: String, path: String, method: String, body: String? = null, upload: ByteArray? = null, contentType: String = "application/json; charset=utf-8", progress: ((Int) -> Unit)? = null): ApiResponse<JSONObject> {
        val uri = Uri.parse(baseUrl)
        if (!uri.scheme.equals("https", true) || uri.host.isNullOrBlank()) return ApiResponse(null, "Configura una URL HTTPS válida.")
        if (!Regex("^[A-Za-z0-9_-]{40,100}$").matches(token)) return ApiResponse(null, "Configura un token de operador válido.")
        var connection: HttpURLConnection? = null
        var dispatched = false
        return try {
            val active = (URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 10_000
                readTimeout = if (method == "POST" && Regex("/api/mobile/operations/[^/]+/(paid|received|cancel)$").matches(path)) 55_000 else if (method == "POST") 45_000 else 12_000
                instanceFollowRedirects = false
                setRequestProperty("Authorization", "Bearer $token")
                setRequestProperty("Accept", "application/json")
                if (body != null || upload != null) {
                    setRequestProperty("Content-Type", contentType)
                    doOutput = true
                    setFixedLengthStreamingMode(upload?.size ?: body!!.toByteArray(Charsets.UTF_8).size)
                }
            }
            connection = active
            active.connect()
            if (body != null || upload != null) {
                val bytes = upload ?: body!!.toByteArray(Charsets.UTF_8)
                active.outputStream.use { output ->
                    var offset = 0
                    while (offset < bytes.size) {
                        dispatched = true
                        val count = minOf(8192, bytes.size - offset)
                        output.write(bytes, offset, count)
                        offset += count
                        progress?.invoke(offset * 100 / bytes.size)
                    }
                }
            }
            val code = active.responseCode
            if (code == 204) return ApiResponse(JSONObject(), "__NO_CONTENT__")
            val responseText = (if (code in 200..299) active.inputStream else active.errorStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { reader ->
                    val bounded = reader.readTextBounded(1_048_576)
                    bounded
                }.orEmpty()
            when {
                code in 200..299 -> ApiResponse(JSONObject(responseText), "")
                code == 401 -> ApiResponse(null, "Token de operador inválido o revocado.")
                code == 429 -> ApiResponse(null, "Límite de solicitudes alcanzado; vuelve a consultar en un momento.")
                code == 409 && method == "POST" -> ApiResponse(
                    null,
                    "Conflicto remoto (HTTP 409). Revisa el estado de la operación antes de volver a intentarlo.",
                    uncertain = true,
                )
                code in 400..499 -> ApiResponse(null,
                    runCatching { JSONObject(responseText).optString("error").take(240) }.getOrNull()
                        ?.takeIf { it.isNotBlank() } ?: "El servidor rechazó la solicitud (HTTP $code).")
                else -> ApiResponse(null, "El servidor respondió HTTP $code.", uncertain = method == "POST")
            }
        } catch (cause: Exception) {
            val uncertain = mobileRequestUncertain(method,dispatched,cause)
            ApiResponse(null, mobileRequestFailureMessage(cause,uncertain), uncertain = uncertain)
        } finally {
            connection?.disconnect()
        }
    }
}

internal fun mobileRequestUncertain(method: String, bodyDispatched: Boolean, cause: Exception): Boolean =
    method == "POST" && (bodyDispatched || cause !is UnknownHostException && cause !is ConnectException)

internal class MobilePayloadException : Exception()

internal fun mobileRequestFailureMessage(cause: Exception, uncertain: Boolean): String {
    val message = when (cause) {
        is SSLException, is SecurityException -> "No se pudo establecer una conexión segura."
        is MalformedURLException, is IllegalArgumentException -> "Configuración o solicitud inválida."
        is org.json.JSONException, is MobilePayloadException, is ProtocolException -> "El servidor devolvió una respuesta inválida o demasiado grande."
        is IOException -> "Sin conexión"
        else -> "No se pudo procesar la solicitud."
    }
    return if (uncertain) "$message No se confirmó la respuesta; comprueba el envío antes de repetirlo." else message
}

private fun java.io.Reader.readTextBounded(limit: Int): String {
    val result = StringBuilder()
    val buffer = CharArray(4096)
    while (true) {
        val count = read(buffer)
        if (count < 0) break
        if (result.length + count > limit) throw MobilePayloadException()
        result.append(buffer, 0, count)
    }
    return result.toString()
}
