package com.qvaapply.sms

import android.app.Activity
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceCredentialAuthTest {
    @Test fun canceledCredentialChallengeDoesNotAuthorizeMutation() {
        assertFalse(DeviceCredentialAuth.confirmed(Activity.RESULT_CANCELED))
        assertTrue(DeviceCredentialAuth.confirmed(Activity.RESULT_OK))
    }
}
