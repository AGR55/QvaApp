package com.qvaapply.sms

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

internal fun networkAvailable(context: Context): Boolean {
    if (androidx.core.content.ContextCompat.checkSelfPermission(context,android.Manifest.permission.ACCESS_NETWORK_STATE)
        != android.content.pm.PackageManager.PERMISSION_GRANTED) return false
    val manager = context.getSystemService(ConnectivityManager::class.java)
    val network = manager.activeNetwork ?: return false
    return manager.getNetworkCapabilities(network)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
}
