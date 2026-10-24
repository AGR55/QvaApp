package com.qvaapply.sms

import org.junit.Assert.*
import org.junit.Test

class ChatTargetTest {
    @Test fun differentOrdersNeverShareDestination() {
        val first=ChatTarget.parse("offer","order-one")!!
        val second=ChatTarget.parse("offer","order-two")!!
        assertNotEquals(first.id,second.id)
        assertEquals("offer:order-one",first.id)
        assertEquals("order-one",first.orderUuid)
        assertNotEquals(first.id,ChatTarget.parse("offer",null)!!.id)
    }
    @Test fun invalidNotificationTargetsAreRejected() {
        assertNull(ChatTarget.parse(null,"order"))
        assertNull(ChatTarget.parse("offer/other","order"))
        assertNull(ChatTarget.parse("offer","order?foreign=1"))
        assertNull(ChatTarget.parse("offer","x".repeat(65)))
    }
}
