package com.qvaapply.sms

import org.junit.Assert.*
import org.junit.Test

class MobilePresentationTest {
    private fun operation(id:String, side:String, actions:List<String>) = MobileOperation(id,side,"Clásica","USD","10","11","1.1","applied","1",actions)
    @Test fun filtersFollowTheRealPayerRoleAndCombineWithSearch() {
        val buyer=operation("buyer","sell",listOf("paid","cancel"))
        val seller=operation("seller","buy",listOf("received"))
        val done=operation("done","sell",emptyList())
        val operations=listOf(buyer,seller,done)
        assertEquals(listOf(buyer,done),filterOperations(operations,"","Compras"))
        assertEquals(listOf(seller),filterOperations(operations,"","Ventas"))
        assertEquals(listOf(buyer,seller),filterOperations(operations,"","Por atender"))
        assertEquals(listOf(seller),filterOperations(operations,"SELLER","Por atender"))
        assertTrue(filterOperations(operations,"missing","Todas").isEmpty())
        assertEquals(3,filterOperations(operations,"clásica","Todas").size)
    }
    @Test fun unknownFinancialValuesAreNeverRenderedAsZero() {
        assertEquals("Sin dato",money(""));assertEquals("Sin dato",money("NaN"));assertEquals("Sin dato",money("Infinity"))
        assertNotEquals("Sin dato",money("-0.05"))
        assertEquals("Sin fecha",dateLabel(""))
    }
    @Test fun pendingMoneyHasPriorityOverSummaries() {
        assertTrue(noticePriority("operation-applied")<noticePriority("system-health"))
        assertTrue(noticePriority("reconciliation-required")<noticePriority("informational-summary"))
        assertEquals("Pago registrado",statusLabel("paid"))
        assertEquals("Completada",statusLabel("completed"))
    }
    @Test fun siblingOrdersHaveIndependentIdentityAndSearch() {
        val first=operation("parent","sell",emptyList()).copy(orderUuid="order-one",role="creator",chatAvailable=true)
        val second=first.copy(orderUuid="order-two")
        assertNotEquals(first.id,second.id)
        assertEquals(listOf(second),filterOperations(listOf(first,second),"order-two","Todas"))
    }
}
