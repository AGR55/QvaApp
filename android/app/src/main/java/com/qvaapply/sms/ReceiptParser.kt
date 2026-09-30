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
)

/** Parses only completed transfer notices from senders explicitly configured by the owner. */
object ReceiptParser {
    private val completed = Regex("\\btransferencia\\s+fue\\s+completada\\b", RegexOption.IGNORE_CASE)
    private val beneficiary = Regex("\\bBeneficiario\\s*:\\s*([0-9Xx*•]{6,32})", RegexOption.IGNORE_CASE)
    private val amount = Regex("\\bMonto\\s*:\\s*([0-9]+(?:[.,][0-9]{1,2})?)\\s+(CUP|USD)\\b", RegexOption.IGNORE_CASE)
    private val transaction = Regex("\\bNro\\.?\\s*Transacci[oó]n\\s*:\\s*([A-Z0-9-]{5,40})", RegexOption.IGNORE_CASE)
    private val explicitBanks = listOf(
        Regex("\\bBanco\\s+Popular\\s+de\\s+Ahorro\\b", RegexOption.IGNORE_CASE) to "BPA",
        Regex("\\bBanco\\s+Metropolitano\\b", RegexOption.IGNORE_CASE) to "BANCO_METROPOLITANO",
        Regex("\\bFINCIMEX(?:\\s*/?\\s*Cl[aá]sica)?\\b", RegexOption.IGNORE_CASE) to "FINCIMEX",
    )

    fun parse(senderRaw: String, body: String, receivedAt: Long, configuredSenders: Map<String, String>): ParsedReceipt? {
        val sender = senderRaw.trim()
        if (sender.isEmpty() || body.isBlank()) return null
        val configuredBank = configuredSenders.entries.firstOrNull { (configured, _) ->
            configured.trim().equals(sender, ignoreCase = true)
        }?.value ?: return null
        val headingEnd = completed.find(body)?.range?.first ?: minOf(body.length, 160)
        val heading = body.substring(0, headingEnd)
        val bank = explicitBanks.firstNotNullOfOrNull { (pattern, name) ->
            name.takeIf { pattern.containsMatchIn(heading) }
        } ?: configuredBank.takeIf { it.isNotBlank() } ?: return null
        if (!completed.containsMatchIn(body)) return null

        val beneficiaryValue = beneficiary.find(body)?.groupValues?.get(1) ?: return null
        val amountMatch = amount.find(body) ?: return null
        val transactionValue = transaction.find(body)?.groupValues?.get(1) ?: return null
        val numericAmount = amountMatch.groupValues[1].replace(',', '.').toDoubleOrNull() ?: return null
        val currencyValue = amountMatch.groupValues[2].uppercase(Locale.ROOT)
        if (!numericAmount.isFinite() || numericAmount <= 0.0 || receivedAt <= 0L) return null

        return ParsedReceipt(
            bank = bank,
            sender = sender,
            currency = currencyValue,
            amount = numericAmount,
            beneficiaryMasked = beneficiaryValue,
            transactionId = transactionValue.uppercase(Locale.ROOT),
            receivedAt = receivedAt,
        )
    }
}
