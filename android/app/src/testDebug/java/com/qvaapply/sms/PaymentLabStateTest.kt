package com.qvaapply.sms

import org.junit.Assert.*
import org.junit.Test
import java.io.*

class PaymentLabStateTest {
    private fun connected(provider: LabProvider = LabProvider.BPA): PaymentLabState {
        val waiting=PaymentLabState().select(provider).authenticate(1000)
        return waiting.sessionResponse(waiting.session.requestId,6000,true)
    }

    @Test fun oneBankMustDisconnectBeforeAnotherCanAuthenticate() {
        val bpa=connected().select(LabProvider.BANDEC)
        assertFalse(bpa.sessionReady)
        assertFalse(bpa.canPrepare)
        assertEquals(bpa,bpa.authenticate(7000))
        val disconnecting=bpa.disconnect(7000)
        assertEquals(LabProvider.BPA,disconnecting.session.provider)
        assertEquals(disconnecting,disconnecting.authenticate(8000))
        val disconnected=disconnecting.sessionResponse(disconnecting.session.requestId,12000,true)
        val bandec=disconnected.authenticate(13000)
        assertEquals(LabProvider.BANDEC,bandec.session.provider)
        assertEquals(LabSessionPhase.AUTHENTICATING,bandec.session.phase)
    }

    @Test fun congestionDoesNotRetryOrCreateAnotherSession() {
        val waiting=PaymentLabState().authenticate(1000)
        assertEquals(waiting,waiting.authenticate(400_000))
        assertEquals(waiting,waiting.select(LabProvider.BANDEC))
        assertEquals(waiting,waiting.prepare())
        assertEquals(LabSessionPhase.CONNECTED,waiting.sessionResponse(waiting.session.requestId,400_000,true).session.phase)
    }

    @Test fun earlyAndLateResponsesCannotCompleteADifferentRequest() {
        val waiting=PaymentLabState().authenticate(1000)
        assertEquals(waiting,waiting.sessionResponse(waiting.session.requestId,5999,true))
        val disconnecting=waiting.sessionResponse(waiting.session.requestId,6000,true).disconnect(7000)
        assertEquals(disconnecting,disconnecting.sessionResponse(waiting.session.requestId,15000,true))
    }

    @Test fun anUnknownSessionBlocksBothBanksAndEtecsaUntilExplicitObservation() {
        val waiting=PaymentLabState().authenticate(1000)
        val unknown=waiting.sessionResponse(waiting.session.requestId,61000,false)
        assertEquals(LabSessionPhase.UNKNOWN,unknown.session.phase)
        assertEquals(unknown,unknown.select(LabProvider.ETECSA))
        assertEquals(unknown,unknown.authenticate(90000))
        assertEquals(unknown,unknown.disconnect(90000))
        assertFalse(unknown.canPrepare)
        assertEquals(LabSessionPhase.NONE,unknown.observeDisconnected().session.phase)
    }

    @Test fun allProvidersUseTheirOwnSyntheticDestinationsAndCurrency() {
        LabProvider.entries.forEach { provider ->
            val state=PaymentLabState().select(provider)
            assertEquals("DEMO-${provider.name}-0001",state.destination)
            assertEquals(if(provider==LabProvider.CLASICA) "USD" else "CUP",provider.currency)
            assertTrue(state.valid)
            val ready=if(provider.needsSession) connected(provider) else state
            assertTrue(ready.canPrepare)
            assertEquals(LabPaymentPhase.SIMULATED,ready.prepare().confirm().payment)
        }
    }

    @Test fun invalidAmountsAndRealOrInjectedDestinationsNeverPrepare() {
        val state=connected()
        listOf("0","-1","1.001","NaN","Infinity","1e3","1,25","100001","", "1*2#").forEach {
            assertFalse("amount=$it",state.edit(amount=it).canPrepare)
        }
        listOf("1234567890123456","+5355555555","DEMO-BPA-0001*1#","DEMO-BANDEC-0001").forEach {
            assertFalse(state.edit(destination=it).canPrepare)
        }
        assertTrue(state.edit(amount="0.01").canPrepare)
        assertTrue(state.edit(amount="100000.00").canPrepare)
    }

    @Test fun confirmIsIdempotentAndDraftCannotSkipTheReview() {
        val state=connected()
        assertEquals(state,state.confirm())
        val review=state.prepare()
        assertEquals(review,review.prepare())
        assertEquals(review,review.edit(amount="999"))
        assertEquals(review,review.select(LabProvider.BANDEC))
        val confirmed=review.confirm()
        assertEquals(1,confirmed.attempt)
        assertEquals(confirmed,confirmed.confirm())
        assertEquals(confirmed,confirmed.prepare())
    }

    @Test fun cancellationNeedsAnotherExplicitReview() {
        val cancelled=connected().prepare().cancel()
        assertEquals(LabPaymentPhase.CANCELLED,cancelled.payment)
        assertEquals(cancelled,cancelled.confirm())
        assertEquals(2,cancelled.prepare().attempt)
    }

    @Test fun uncertainPaymentBlocksRetryAndBankSwitchUntilSyntheticReceipt() {
        val uncertain=connected().prepare().interrupt()
        assertEquals(uncertain,uncertain.prepare())
        assertEquals(uncertain,uncertain.confirm())
        assertEquals(uncertain,uncertain.select(LabProvider.ETECSA))
        assertEquals(uncertain,uncertain.disconnect(10000))
        assertEquals(uncertain,uncertain.edit(amount="1"))
        assertEquals(LabPaymentPhase.SIMULATED,uncertain.reconcileSyntheticReceipt().payment)
    }

    @Test fun savedInstanceStatePreservesUncertainAttemptsAndSessionExclusivity() {
        val original=connected().prepare().interrupt()
        val bytes=ByteArrayOutputStream().apply {ObjectOutputStream(this).use {it.writeObject(original)}}.toByteArray()
        val restored=ObjectInputStream(ByteArrayInputStream(bytes)).use {it.readObject() as PaymentLabState}
        assertEquals(original,restored)
        assertEquals(restored,restored.prepare())
        assertEquals(restored,restored.select(LabProvider.BANDEC))
    }
}
