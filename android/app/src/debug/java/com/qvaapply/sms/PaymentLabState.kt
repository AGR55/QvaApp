package com.qvaapply.sms

import java.io.Serializable
import java.math.BigDecimal

/** No Android, credentials, network, dialer or USSD dependency. Synthetic data only. */
internal enum class LabProvider(val label: String, val currency: String) {
    BPA("BPA", "CUP"), BANDEC("BANDEC", "CUP"), METRO("Metropolitano", "CUP"),
    CLASICA("Clásica · MiTransfer", "USD"), ETECSA("Saldo ETECSA", "CUP");
    val needsSession: Boolean get() = this != ETECSA
    val destination: String get() = "DEMO-$name-0001"
}
internal enum class LabSessionPhase { NONE, AUTHENTICATING, CONNECTED, DISCONNECTING, UNKNOWN }
internal enum class LabPaymentPhase { DRAFT, REVIEW, CANCELLED, UNCERTAIN, SIMULATED }
internal data class LabSession(
    val provider: LabProvider? = null,
    val phase: LabSessionPhase = LabSessionPhase.NONE,
    val requestId: Int = 0,
    val startedAt: Long = 0,
) : Serializable
internal data class PaymentLabState(
    val provider: LabProvider = LabProvider.BPA,
    val amount: String = "125.00",
    val destination: String = LabProvider.BPA.destination,
    val session: LabSession = LabSession(),
    val payment: LabPaymentPhase = LabPaymentPhase.DRAFT,
    val attempt: Int = 0,
) : Serializable {
    val sessionBusy: Boolean get() = session.phase in listOf(LabSessionPhase.AUTHENTICATING, LabSessionPhase.DISCONNECTING, LabSessionPhase.UNKNOWN)
    val locked: Boolean get() = sessionBusy || payment == LabPaymentPhase.UNCERTAIN
    val amountValue: BigDecimal? get() = if (Regex("^[0-9]{1,6}(\\.[0-9]{1,2})?$").matches(amount))
        amount.toBigDecimalOrNull()?.takeIf { it > BigDecimal.ZERO && it <= BigDecimal("100000") } else null
    val valid: Boolean get() = amountValue != null && destination == provider.destination
    val sessionReady: Boolean get() = if (provider.needsSession)
        session.phase == LabSessionPhase.CONNECTED && session.provider == provider
        else session.phase in listOf(LabSessionPhase.NONE, LabSessionPhase.CONNECTED)
    val canPrepare: Boolean get() = !locked && valid && sessionReady && payment in listOf(LabPaymentPhase.DRAFT, LabPaymentPhase.CANCELLED)

    fun select(next: LabProvider): PaymentLabState = if (locked || payment == LabPaymentPhase.REVIEW) this else
        copy(provider=next, amount=if(next==LabProvider.CLASICA) "12.50" else "125.00", destination=next.destination, payment=LabPaymentPhase.DRAFT)
    fun edit(amount: String = this.amount, destination: String = this.destination): PaymentLabState =
        if (locked || payment == LabPaymentPhase.REVIEW || payment == LabPaymentPhase.SIMULATED) this
        else copy(amount=amount, destination=destination, payment=LabPaymentPhase.DRAFT)
    fun authenticate(now: Long): PaymentLabState = if (session.phase != LabSessionPhase.NONE || !provider.needsSession || payment == LabPaymentPhase.REVIEW || locked) this
        else copy(session=LabSession(provider,LabSessionPhase.AUTHENTICATING,session.requestId+1,now))
    fun disconnect(now: Long): PaymentLabState = if (session.phase != LabSessionPhase.CONNECTED || payment == LabPaymentPhase.REVIEW || locked) this
        else copy(session=session.copy(phase=LabSessionPhase.DISCONNECTING, requestId=session.requestId+1, startedAt=now))
    fun sessionResponse(requestId: Int, now: Long, certain: Boolean): PaymentLabState {
        if (requestId != session.requestId || now-session.startedAt < 5_000 ||
            session.phase !in listOf(LabSessionPhase.AUTHENTICATING,LabSessionPhase.DISCONNECTING)) return this
        if (!certain) return copy(session=session.copy(phase=LabSessionPhase.UNKNOWN))
        return copy(session=if(session.phase==LabSessionPhase.AUTHENTICATING) session.copy(phase=LabSessionPhase.CONNECTED)
            else LabSession(requestId=session.requestId))
    }
    // Explicit synthetic observation, never an automatic retry after a timeout.
    fun observeDisconnected(): PaymentLabState = if(session.phase!=LabSessionPhase.UNKNOWN) this
        else copy(session=LabSession(requestId=session.requestId))
    fun prepare(): PaymentLabState = if(!canPrepare) this else copy(payment=LabPaymentPhase.REVIEW,attempt=attempt+1)
    fun cancel(): PaymentLabState = if(payment!=LabPaymentPhase.REVIEW) this else copy(payment=LabPaymentPhase.CANCELLED)
    fun confirm(): PaymentLabState = if(payment!=LabPaymentPhase.REVIEW || !valid || !sessionReady || locked) this else copy(payment=LabPaymentPhase.SIMULATED)
    fun interrupt(): PaymentLabState = if(payment!=LabPaymentPhase.REVIEW) this else copy(payment=LabPaymentPhase.UNCERTAIN)
    fun reconcileSyntheticReceipt(): PaymentLabState = if(payment!=LabPaymentPhase.UNCERTAIN) this else copy(payment=LabPaymentPhase.SIMULATED)
}
