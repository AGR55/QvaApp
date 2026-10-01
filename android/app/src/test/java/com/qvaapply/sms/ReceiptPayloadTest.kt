package com.qvaapply.sms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReceiptPayloadTest {
    @Test fun etecsaSendsRequiredEmptyBeneficiaryAndOmitsBankTransactionId() {
        val receipt = ParsedReceipt(
            bank = "ETECSA", sender = "ETECSA", currency = "CUP", amount = 2950.0,
            beneficiaryMasked = "", transactionId = "", receivedAt = 1_760_000_000_000,
            recipientPhone = "51887383", receiptKind = "outgoing", market = "ETECSA",
        )

        val payload = ReceiptPayload.toMap(receipt)

        assertEquals("", payload["beneficiaryMasked"])
        assertFalse(payload.containsKey("transactionId"))
        assertEquals("ETECSA", payload["market"])
        assertEquals("51887383", payload["recipientPhone"])
        assertEquals("outgoing", payload["receiptKind"])
    }

    @Test fun bankSendsBeneficiaryAndRealTransactionId() {
        val receipt = ParsedReceipt(
            bank = "BANDEC", sender = "PAGOxMOVIL", currency = "CUP", amount = 550.0,
            beneficiaryMasked = "9205XXXXXXXX0959", transactionId = "BD123456", receivedAt = 1_760_000_000_000,
        )

        val payload = ReceiptPayload.toMap(receipt)

        assertEquals("9205XXXXXXXX0959", payload["beneficiaryMasked"])
        assertEquals("BD123456", payload["transactionId"])
        assertTrue(payload.containsKey("receivedAt"))
    }
}
