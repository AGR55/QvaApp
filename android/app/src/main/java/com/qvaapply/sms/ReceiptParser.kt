package com.qvaapply.sms

import java.util.Locale

data class ParsedReceipt(
    val bank: String,
    val sender: String,
    val currency: String,
    val amount: Double,
    val beneficiaryMasked: String,
    val transactionId: String,
    val receivedAt: Long,
    val recipientPhone: String? = null,
    val receiptKind: String? = null,
    val market: String? = null,
)

/** Extracts only structured facts from the two fixed SMS senders. Never persists raw SMS text. */
object ReceiptParser {
    private val completed = Regex("\\btransferencia\\s+fue\\s+completada\\b", RegexOption.IGNORE_CASE)
    private val beneficiary = Regex("\\bBeneficiario\\s*:\\s*([0-9Xx*•]{6,32})", RegexOption.IGNORE_CASE)
    private val amount = Regex("\\bMonto\\s*:\\s*([0-9]+(?:[.,][0-9]{1,2})?)\\s+(CUP|USD)\\b", RegexOption.IGNORE_CASE)
    private val transaction = Regex("\\bNro\\.?\\s*Transacci[oó]n\\s*:\\s*([A-Z0-9-]{5,40})", RegexOption.IGNORE_CASE)
    private val explicitBanks = listOf(
        Regex("\\bBanco\\s+Popular\\s+de\\s+Ahorro\\b", RegexOption.IGNORE_CASE) to "BPA",
        Regex("\\bBanco\\s+Metropolitano\\b", RegexOption.IGNORE_CASE) to "BANCO_METROPOLITANO",
        Regex("\\bBANDEC\\b|\\bBanco\\s+de\\s+Cr[eé]dito\\s+y\\s+Comercio\\b", RegexOption.IGNORE_CASE) to "BANDEC",
        Regex("\\bFINCIMEX(?:\\s*/?\\s*Cl[aá]sica)?\\b", RegexOption.IGNORE_CASE) to "FINCIMEX",
    )
    private val outgoingEtecsa = Regex(
        "\\b(?:ha\\s+realizado\\s+(?:una\\s+)?transferencia\\s+de|ha\\s+transferido|realiz[oó]\\s+(?:una\\s+)?transferencia\\s+de|transfiri[oó])\\s+([0-9]+(?:[.,][0-9]{1,2})?)\\s+CUP\\s+al\\s+(?:(?:tel[eé]fono|n[uú]mero)\\s+)?(?:\\+?53\\s*)?(5[0-9]{7})\\b",
        RegexOption.IGNORE_CASE,
    )

    fun parse(senderRaw: String, body: String, receivedAt: Long): ParsedReceipt? {
        val sender = senderRaw.trim()
        if (body.isBlank() || receivedAt <= 0L) return null
        return when {
            sender.equals("ETECSA", ignoreCase = true) -> parseEtecsa(sender, body, receivedAt)
            sender.equals("PAGOxMOVIL", ignoreCase = true) -> parseBank(sender, body, receivedAt)
            else -> null
        }
    }

    private fun parseEtecsa(sender: String, body: String, receivedAt: Long): ParsedReceipt? {
        val match = outgoingEtecsa.find(body) ?: return null
        val numericAmount = match.groupValues[1].replace(',', '.').toDoubleOrNull() ?: return null
        if (!numericAmount.isFinite() || numericAmount <= 0.0) return null
        return ParsedReceipt(
            bank = "ETECSA", sender = "ETECSA", currency = "CUP", amount = numericAmount,
            beneficiaryMasked = "", transactionId = "", receivedAt = receivedAt,
            recipientPhone = match.groupValues[2], receiptKind = "outgoing", market = "ETECSA",
        )
    }

    private fun parseBank(sender: String, body: String, receivedAt: Long): ParsedReceipt? {
        if (!completed.containsMatchIn(body)) return null
        val headingEnd = completed.find(body)?.range?.first ?: return null
        val heading = body.substring(0, headingEnd)
        val bank = explicitBanks.firstNotNullOfOrNull { (pattern, name) -> name.takeIf { pattern.containsMatchIn(heading) } } ?: return null
        val beneficiaryValue = beneficiary.find(body)?.groupValues?.get(1) ?: return null
        // An unmasked account number is not accepted or retained as beneficiary data.
        if (beneficiaryValue.count { it == 'X' || it == 'x' || it == '*' || it == '•' } < 4) return null
        val amountMatch = amount.find(body) ?: return null
        val transactionValue = transaction.find(body)?.groupValues?.get(1) ?: return null
        val numericAmount = amountMatch.groupValues[1].replace(',', '.').toDoubleOrNull() ?: return null
        if (!numericAmount.isFinite() || numericAmount <= 0.0) return null
        return ParsedReceipt(
            bank = bank, sender = sender, currency = amountMatch.groupValues[2].uppercase(Locale.ROOT),
            amount = numericAmount, beneficiaryMasked = beneficiaryValue,
            transactionId = transactionValue.uppercase(Locale.ROOT), receivedAt = receivedAt,
        )
    }
}
