package com.qvaapply.sms

import android.content.Context
import org.json.JSONObject
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class SecureSettings(context: Context, preferencesName: String = "device_settings") {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        preferencesName,
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
    var serverUrl: String get() = prefs.getString("server_url", "") ?: ""; set(v) = prefs.edit().putString("server_url", v.trim().trimEnd('/')).apply()
    var deviceToken: String get() = prefs.getString("device_token", "") ?: ""; set(v) = prefs.edit().putString("device_token", v.trim()).apply()
    var operatorToken: String get() = prefs.getString("operator_token", "") ?: ""; set(v) = prefs.edit().putString("operator_token", v.trim()).apply()
    var theme: String get() = prefs.getString("theme", "system") ?: "system"; set(v) = prefs.edit().putString("theme", v).apply()

    var pushToken: String get() = prefs.getString("push_token", "") ?: ""; set(v) = prefs.edit().putString("push_token", v).apply()
    var pushOperatorId: String get() = prefs.getString("push_operator_id", "") ?: ""; set(v) = prefs.edit().putString("push_operator_id", v).apply()
    var pushRegistered: Boolean get() = prefs.getBoolean("push_registered", false); set(v) = prefs.edit().putBoolean("push_registered", v).apply()

    fun saveConnection(url: String, smsToken: String, operator: String): Boolean {
        val cleanUrl = url.trim().trimEnd('/')
        val changed = cleanUrl != serverUrl || operator.trim() != operatorToken
        val edit = prefs.edit().putString("server_url", cleanUrl)
            .putString("device_token", smsToken.trim()).putString("operator_token", operator.trim())
        if (changed) {
            edit.putBoolean("push_registered", false).remove("push_operator_id")
            prefs.all.keys.filter { it.startsWith("cache_") }.forEach { edit.remove(it) }
        }
        return edit.commit()
    }

    fun cachedResponse(key: String): JSONObject? = prefs.getString("cache_$key", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
    fun saveCachedResponse(key: String, value: JSONObject) {
        val edit=prefs.edit().putString("cache_$key", value.toString())
        if(key.startsWith("tool:") || key.startsWith("chat:") || key.startsWith("chat_draft:")) {
            val family=when {
                key.startsWith("chat_draft:") -> "cache_chat_draft:"
                key.startsWith("chat:") -> "cache_chat:"
                else -> "cache_tool:"
            }
            prefs.all.keys.filter {it.startsWith(family)&&it!="cache_$key"}
                .sortedByDescending {name -> runCatching {JSONObject(prefs.getString(name,"{}")!!).optLong("savedAt")}.getOrDefault(0)}
                .drop(23).forEach {edit.remove(it)}
        }
        edit.apply()
    }
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
