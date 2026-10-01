package com.qvaapply.sms

import android.content.Context
import org.json.JSONObject
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class SecureSettings(context: Context) {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "device_settings",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
    var serverUrl: String get() = prefs.getString("server_url", "") ?: ""; set(v) = prefs.edit().putString("server_url", v.trim().trimEnd('/')).apply()
    var deviceToken: String get() = prefs.getString("device_token", "") ?: ""; set(v) = prefs.edit().putString("device_token", v.trim()).apply()
    var operatorToken: String get() = prefs.getString("operator_token", "") ?: ""; set(v) = prefs.edit().putString("operator_token", v.trim()).apply()

    fun cachedResponse(key: String): JSONObject? = prefs.getString("cache_$key", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
    fun saveCachedResponse(key: String, value: JSONObject) { prefs.edit().putString("cache_$key", value.toString()).apply() }
    fun cachedAt(): Long = prefs.getLong("cache_at", 0L)
    fun setCachedAt(value: Long) { prefs.edit().putLong("cache_at", value).apply() }

    fun actionIsUncertain(operationId: String, action: String): Boolean =
        prefs.getStringSet("uncertain_actions", emptySet()).orEmpty().contains("$operationId:$action")

    /** Synchronous durability barrier. Callers must not dispatch a monetary mutation on false. */
    fun markActionUncertain(operationId: String, action: String): Boolean = runCatching {
        val current = prefs.getStringSet("uncertain_actions", emptySet()).orEmpty().toMutableSet()
        current += "$operationId:$action"
        prefs.edit().putStringSet("uncertain_actions", current).commit()
    }.getOrDefault(false)

    fun clearActionUncertain(operationId: String, action: String) {
        val current = prefs.getStringSet("uncertain_actions", emptySet()).orEmpty().toMutableSet()
        current -= "$operationId:$action"
        prefs.edit().putStringSet("uncertain_actions", current).apply()
    }
}
