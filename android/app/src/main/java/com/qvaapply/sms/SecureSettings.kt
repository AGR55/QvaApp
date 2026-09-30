package com.qvaapply.sms

import android.content.Context
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
    var bpaSender: String get() = prefs.getString("bpa_sender", "") ?: ""; set(v) = prefs.edit().putString("bpa_sender", v.trim()).apply()
    var metropolitanSender: String get() = prefs.getString("metropolitan_sender", "") ?: ""; set(v) = prefs.edit().putString("metropolitan_sender", v.trim()).apply()
    var fincimexSender: String get() = prefs.getString("fincimex_sender", "") ?: ""; set(v) = prefs.edit().putString("fincimex_sender", v.trim()).apply()
}
