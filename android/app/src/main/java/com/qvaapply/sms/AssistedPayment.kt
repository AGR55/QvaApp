package com.qvaapply.sms

import org.json.JSONObject

internal const val TRANSFERMOVIL_PACKAGE = "cu.etecsa.cubacel.tr.tm"
internal const val TRANSFERMOVIL_SUPPORTED_VERSION = "1.260416"

internal enum class PaymentSource(val label: String) {
    BPA("BPA"), BANDEC("BANDEC"), METRO("Metropolitano"), CLASICA("Clásica · MiTransfer"), ETECSA("ETECSA");
    val menuLabel: String get() = when(this) {CLASICA->"MiTransfer";ETECSA->"Operaciones";else->label}
}

internal data class AssistedPayment(
    val uuid: String, val orderUuid: String?, val market: String, val amount: String, val currency: String,
    val kind: String, val destination: String, val confirmationPhone: String?, val fingerprint: String,
    val checkedAt: Long, val expiresAt: Long,
) {
    val id: String get() = "$uuid:${orderUuid ?: "fixed"}"
    val sources: List<PaymentSource> get() = when(market) {
        "BANK_CUP"->listOf(PaymentSource.BPA,PaymentSource.BANDEC,PaymentSource.METRO)
        "CLASICA"->listOf(PaymentSource.CLASICA)
        "ETECSA"->listOf(PaymentSource.ETECSA)
        else->emptyList()
    }
    fun validFor(operation: MobileOperation, now: Long): Boolean {
        val numeric=amount.toBigDecimalOrNull()
        val expected=operation.receive.toBigDecimalOrNull() ?: return false
        return uuid==operation.uuid && orderUuid==operation.orderUuid && market==operation.market && currency==operation.currency &&
            operation.side=="sell" && operation.role=="taker" && operation.status in listOf("applied","acknowledged","processing") &&
            numeric!=null && numeric>java.math.BigDecimal.ZERO && numeric.compareTo(expected)==0 &&
            Regex("^[0-9]{1,10}\\.[0-9]{2}$").matches(amount) &&
            Regex("^[a-f0-9]{64}$").matches(fingerprint) && checkedAt>0 && now>=checkedAt-30_000 &&
            expiresAt>now && expiresAt-checkedAt in 1..120_000 && sources.isNotEmpty() &&
            when(market) {
                "BANK_CUP"->currency=="CUP" && kind=="card" && Regex("^[0-9]{16}$").matches(destination)
                "CLASICA"->currency=="USD" && kind=="card" && Regex("^[0-9]{16}$").matches(destination)
                "ETECSA"->currency=="CUP" && kind=="phone" && Regex("^5[0-9]{7}$").matches(destination)
                else->false
            } && (confirmationPhone==null || Regex("^5[0-9]{7}$").matches(confirmationPhone))
    }
    fun toJson() = JSONObject().put("uuid",uuid).put("orderUuid",orderUuid ?: JSONObject.NULL).put("market",market)
        .put("amount",amount).put("currency",currency).put("kind",kind).put("destination",destination)
        .put("confirmationPhone",confirmationPhone ?: JSONObject.NULL).put("fingerprint",fingerprint)
        .put("checkedAt",checkedAt).put("expiresAt",expiresAt).put("execution","form_review")
    companion object {
        fun parse(value: JSONObject): AssistedPayment? = runCatching {
            require(value.getString("execution")=="form_review")
            AssistedPayment(value.getString("uuid"),value.optString("orderUuid").takeIf {it.isNotBlank()&&it!="null"},
                value.getString("market"),value.getString("amount"),value.getString("currency"),value.getString("kind"),
                value.getString("destination"),value.optString("confirmationPhone").takeIf {it.isNotBlank()&&it!="null"},
                value.getString("fingerprint"),value.getLong("checkedAt"),value.getLong("expiresAt"))
        }.getOrNull()
    }
}

/** The helper has a closed list of navigation labels; confirmation is never an action. */
internal fun safePaymentNavigation(label: String): Boolean = label in listOf(
    "BPA","BANDEC","Metropolitano","MiTransfer","Operaciones","OPERACIONES",
    "Transferencia","Transferir Efectivo","Transferir Efectivo Clásica","Transferir tu Saldo","CUP","USD",
)

/** Exact editable fields only. Origin account and PIN are intentionally absent. */
internal fun paymentFormValues(plan: AssistedPayment, source: PaymentSource): Map<String,String>? {
    if(plan.currency != when(plan.market) {"CLASICA"->"USD";"BANK_CUP","ETECSA"->"CUP";else->return null}) return null
    if(source !in plan.sources || !Regex("^[0-9]{1,10}\\.[0-9]{2}$").matches(plan.amount) ||
        plan.amount.toBigDecimalOrNull()?.let {it>java.math.BigDecimal.ZERO}!=true) return null
    if(plan.confirmationPhone!=null && !Regex("^5[0-9]{7}$").matches(plan.confirmationPhone)) return null
    return if(source==PaymentSource.ETECSA) {
        if(plan.kind!="phone" || !Regex("^5[0-9]{7}$").matches(plan.destination)) null
        else linkedMapOf("input_gnumero" to plan.destination,"input_gmonto" to plan.amount)
    } else {
        if(plan.kind!="card" || !Regex("^[0-9]{16}$").matches(plan.destination)) null
        else linkedMapOf("input_cuenta" to plan.destination,"input_monto" to plan.amount,"input_phone_confirm" to plan.confirmationPhone.orEmpty())
    }
}

/** Operator verified a separate confirmation after the first bank-form ACEPTAR.
 * ETECSA is excluded until that same boundary is verified for its own form. */
internal fun mayRequestNativePaymentReview(source: PaymentSource, title: String?, reviewRequested: Boolean,
    expiresAt: Long, now: Long): Boolean = !reviewRequested && now<expiresAt && source!=PaymentSource.ETECSA &&
    title==if(source==PaymentSource.CLASICA) "Transferencia de Efectivo Clásica" else "Transferir Efectivo"
