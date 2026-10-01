package com.qvaapply.sms

import android.app.Activity

internal object DeviceCredentialAuth {
    fun confirmed(resultCode: Int): Boolean = resultCode == Activity.RESULT_OK
}
