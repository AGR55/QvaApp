package com.qvaapply.sms

/** Wire contract for POST /api/mobile/payment-receipts. */
object ReceiptPayload {
    fun toMap(receipt: ParsedReceipt): Map<String, Any> = buildMap {
        put("bank", receipt.bank)
        put("sender", receipt.sender)
        put("currency", receipt.currency)
        put("amount", receipt.amount)
        // Required by the server schema; ETECSA has no bank account beneficiary.
        put("beneficiaryMasked", receipt.beneficiaryMasked)
        put("receivedAt", receipt.receivedAt)
        if (receipt.transactionId.isNotBlank()) put("transactionId", receipt.transactionId)
        receipt.market?.let { put("market", it) }
        receipt.recipientPhone?.let { put("recipientPhone", it) }
        receipt.receiptKind?.let { put("receiptKind", it) }
    }
}
