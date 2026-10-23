package com.qvaapply.sms

import android.net.Uri
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

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
)

data class MobileAlert(val id: String, val type: String, val message: String, val createdAt: String, val operationUuid: String?)
data class ApiResponse<T>(val value: T?, val message: String, val uncertain: Boolean = false)

object MobileApi {
    private val uuidPattern = Regex("^[A-Za-z0-9_-]{1,100}$")

    fun get(baseUrl: String, token: String, path: String): ApiResponse<JSONObject> = request(baseUrl, token, path, "GET")
    fun simulate(baseUrl: String, token: String, input: JSONObject): ApiResponse<JSONObject> =
        request(baseUrl, token, "/api/mobile/simulate", "POST", input.toString()).let { it.copy(uncertain = false) }

    fun action(baseUrl: String, token: String, operationId: String, action: String, reference: String): ApiResponse<Unit> {
        if (!uuidPattern.matches(operationId) || action !in setOf("paid", "received", "cancel")) {
            return ApiResponse(null, "Acción inválida.")
        }
        val payload = JSONObject().apply { if (action == "paid") put("reference", reference) }.toString()
        val response = request(baseUrl, token, "/api/mobile/operations/${Uri.encode(operationId)}/$action", "POST", payload)
        val confirmed = response.value?.optBoolean("ok", false) == true || response.message == "__NO_CONTENT__"
        return if (confirmed) ApiResponse(Unit, "Acción confirmada por el servidor.")
        else ApiResponse(null, response.message, response.uncertain)
    }

    private fun request(baseUrl: String, token: String, path: String, method: String, body: String? = null): ApiResponse<JSONObject> {
        val uri = Uri.parse(baseUrl)
        if (!uri.scheme.equals("https", true) || uri.host.isNullOrBlank()) return ApiResponse(null, "Configura una URL HTTPS válida.")
        if (!Regex("^[A-Za-z0-9_-]{40,100}$").matches(token)) return ApiResponse(null, "Configura un token de operador válido.")
        var connection: HttpURLConnection? = null
        return try {
            val active = (URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 12_000
                readTimeout = 12_000
                instanceFollowRedirects = false
                setRequestProperty("Authorization", "Bearer $token")
                setRequestProperty("Accept", "application/json")
                if (body != null) {
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    doOutput = true
                }
            }
            connection = active
            if (body != null) active.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
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
        } catch (_: Exception) {
            ApiResponse(null, if (method == "POST") "No se confirmó la respuesta. Revisa la operación antes de intentar otra vez." else "No se pudo contactar el servidor.", uncertain = method == "POST")
        } finally {
            connection?.disconnect()
        }
    }
}

private fun java.io.Reader.readTextBounded(limit: Int): String {
    val result = StringBuilder()
    val buffer = CharArray(4096)
    while (true) {
        val count = read(buffer)
        if (count < 0) break
        if (result.length + count > limit) throw java.io.IOException("Respuesta demasiado grande")
        result.append(buffer, 0, count)
    }
    return result.toString()
}
