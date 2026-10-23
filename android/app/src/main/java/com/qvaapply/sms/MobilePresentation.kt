package com.qvaapply.sms

import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

internal fun money(value: String): String = value.toDoubleOrNull()?.takeIf { it.isFinite() }?.let {
    NumberFormat.getNumberInstance(Locale.forLanguageTag("es-CU")).apply { minimumFractionDigits=2;maximumFractionDigits=4 }.format(it)
} ?: "Sin dato"
internal fun dateLabel(value: String): String {
    val at=value.toLongOrNull() ?: return value.ifBlank { "Sin fecha" }
    return if(at>0) SimpleDateFormat("d MMM · HH:mm",Locale.forLanguageTag("es-CU")).format(Date(at)) else "Sin fecha"
}
internal fun statusLabel(status: String): String = when(status) {
    "applied" -> "Pendiente"; "acknowledged" -> "En curso"; "paid" -> "Pago registrado"; "completed" -> "Completada"
    "cancelled", "canceled" -> "Cancelada"; "revision" -> "En revisión"; "disputed" -> "En disputa"; else -> "Estado: $status"
}
internal fun receiptStatus(status: String): String = when(status) {
    "matched", "paid" -> "Pago asociado"; "received", "pending" -> "Comprobante recibido"
    "processing" -> "Comprobando coincidencia"; "duplicate" -> "Comprobante ya registrado"
    "review", "needs_review", "revision" -> "Requiere revisión"
    "rejected" -> "Comprobante rechazado"; "failed" -> "No se pudo procesar"; else -> "SMS · $status"
}
internal fun noticePriority(type: String): Int = when(type) {
    "operation-applied", "own-offer-applied", "recovery-blocked", "reconciliation-required", "rebalance-attention" -> 0
    "system-health" -> 1; else -> 2
}
internal fun noticeTitle(type: String): String = when(type) {
    "operation-applied", "own-offer-applied" -> "Operación pendiente"
    "recovery-blocked", "reconciliation-required" -> "Revisar conciliación"
    "rebalance-attention" -> "Revisar capital"; "system-health" -> "Salud del bot"
    "informational-summary" -> "Resumen informativo"; else -> "Información"
}
internal fun filterOperations(operations: List<MobileOperation>, query: String, filter: String): List<MobileOperation> {
    val needle=query.trim().lowercase(Locale.ROOT)
    return operations.filter { op ->
        val matchesFilter=when(filter) { "Por atender" -> op.actions.isNotEmpty(); "Compras" -> op.side=="sell"; "Ventas" -> op.side=="buy"; else -> true }
        matchesFilter && (needle.isBlank() || listOf(op.uuid,op.marketLabel,op.amount,op.receive,statusLabel(op.status)).any { it.lowercase(Locale.ROOT).contains(needle) })
    }
}
