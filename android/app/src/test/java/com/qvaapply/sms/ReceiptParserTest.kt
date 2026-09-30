package com.qvaapply.sms

import org.junit.Assert.*
import org.junit.Test

class ReceiptParserTest {
    private val senders = mapOf("BPA-SYNTHETIC" to "BPA", "BM-SYNTHETIC" to "BANCO_METROPOLITANO", "FIN-SYNTHETIC" to "FINCIMEX")

    @Test fun parsesBpaCup() {
        val parsed = ReceiptParser.parse("BPA-SYNTHETIC", "La Transferencia fue completada. Beneficiario: 9205XXXXXXXX0959 Ordenante: oculto Monto: 52500.00 CUP Nro. Transaccion: BR601ABVZE997 Saldo restante: 99 CUP", 1_760_000_000_000, senders)!!
        assertEquals("BPA", parsed.bank); assertEquals("CUP", parsed.currency); assertEquals(52500.0, parsed.amount, 0.0)
        assertEquals("9205XXXXXXXX0959", parsed.beneficiaryMasked); assertEquals("BR601ABVZE997", parsed.transactionId)
    }

    @Test fun parsesMetropolitanoCup() {
        val parsed = ReceiptParser.parse("BM-SYNTHETIC", "La Transferencia fue completada. Beneficiario: 9205XXXXXXXX0959 Monto: 4700.00 CUP Nro. Transaccion: MM6056AJ77987", 1_760_000_000_001, senders)!!
        assertEquals("BANCO_METROPOLITANO", parsed.bank); assertEquals(4700.0, parsed.amount, 0.0)
        assertEquals("MM6056AJ77987", parsed.transactionId)
    }

    @Test fun parsesFincimexUsdWithoutCommission() {
        val parsed = ReceiptParser.parse("FIN-SYNTHETIC", "La Transferencia fue completada. Beneficiario: 9760XXXXXXXX3476 Monto: 20.00 USD Comision 0.08 USD Nro. Transaccion: 774529", 1_760_000_000_002, senders)!!
        assertEquals("FINCIMEX", parsed.bank); assertEquals("USD", parsed.currency); assertEquals(20.0, parsed.amount, 0.0)
        assertEquals("774529", parsed.transactionId)
    }

    @Test fun ignoresUnknownSenderAndUncompletedMessage() {
        val body = "La Transferencia fue completada. Beneficiario: 9205XXXXXXXX0959 Monto: 10.00 CUP Nro. Transaccion: BR601ABVZE997"
        assertNull(ReceiptParser.parse("unknown", body, 1, senders))
        assertNull(ReceiptParser.parse("BPA-SYNTHETIC", body.replace("fue completada", "fue iniciada"), 1, senders))
    }
}
