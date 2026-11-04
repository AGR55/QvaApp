package com.qvaapply.sms

import org.junit.Assert.*
import org.junit.Test
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.net.ProtocolException
import java.net.MalformedURLException
import java.io.IOException
import javax.net.ssl.SSLHandshakeException

class MobileApiChatTest {
    @Test fun onlyTransportFailuresShowOfflineAndInvalidResponsesStayConservative() {
        for (cause in listOf(UnknownHostException(), ConnectException(), SocketTimeoutException(), IOException())) {
            assertTrue(mobileRequestFailureMessage(cause,false).startsWith("Sin conexión"))
        }
        for (cause in listOf(MobilePayloadException(), ProtocolException(), MalformedURLException(), IllegalArgumentException(), SecurityException(), SSLHandshakeException("certificate"), IllegalStateException())) {
            assertFalse(mobileRequestFailureMessage(cause,false).contains("Sin conexión"))
            assertFalse(mobileRequestFailureMessage(cause,true).contains("Sin conexión"))
            assertTrue(mobileRequestUncertain("POST",true,cause))
            assertTrue(mobileRequestFailureMessage(cause,true).contains("No se confirmó"))
        }
    }
    @Test fun connectionFailureBeforeBodyIsSafeButNeverAfterDispatch() {
        for (cause in listOf(UnknownHostException(), ConnectException())) {
            assertFalse(mobileRequestUncertain("POST", false, cause))
            assertTrue(mobileRequestUncertain("POST", true, cause))
        }
        assertTrue(mobileRequestUncertain("POST", false, SocketTimeoutException()))
        assertTrue(mobileRequestUncertain("POST", true, SocketTimeoutException()))
        assertFalse(mobileRequestUncertain("GET", false, SocketTimeoutException()))
    }

    @Test fun marketDefaultsToLabelAndAcceptsWireCodeWithoutBreakingExistingConstructor() {
        val original = MobileOperation("offer", "sell", "Banco CUP", "CUP", "1", "100", "100", "applied", "", emptyList())
        assertEquals("Banco CUP", original.market)
        assertEquals("BANK_CUP", original.copy(market = "BANK_CUP").market)
    }
}
