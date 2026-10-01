package com.qvaapply.sms

import org.junit.Assert.*
import org.junit.Test

class ReceiptParserTest {
    private val bankSms = "PAGOxMOVIL"

    @Test fun parsesBpaCup() {
        val parsed = ReceiptParser.parse(bankSms, "Banco Popular de Ahorro. La Transferencia fue completada. Beneficiario: 9205XXXXXXXX0959 Ordenante: oculto Monto: 52500.00 CUP Nro. Transaccion: BR601ABVZE997 Saldo restante: 99 CUP", 1_760_000_000_000)!!
        assertEquals("BPA", parsed.bank); assertEquals("CUP", parsed.currency); assertEquals(52500.0, parsed.amount, 0.0)
        assertEquals("9205XXXXXXXX0959", parsed.beneficiaryMasked); assertEquals("BR601ABVZE997", parsed.transactionId)
    }

    @Test fun parsesMetropolitanoCup() {
        val parsed = ReceiptParser.parse(bankSms, "Banco Metropolitano. La Transferencia fue completada. Beneficiario: 9205XXXXXXXX0959 Monto: 4700.00 CUP Nro. Transaccion: MM6056AJ77987", 1_760_000_000_001)!!
        assertEquals("BANCO_METROPOLITANO", parsed.bank); assertEquals(4700.0, parsed.amount, 0.0)
        assertEquals("MM6056AJ77987", parsed.transactionId)
    }

    @Test fun parsesBandecCupFromHeader() {
        val parsed = ReceiptParser.parse(bankSms, "BANDEC. La Transferencia fue completada. Beneficiario: 9205XXXXXXXX0959 Monto: 550.00 CUP Nro. Transacción: BD123456", 1_760_000_000_002)!!
        assertEquals("BANDEC", parsed.bank); assertEquals("BD123456", parsed.transactionId)
    }

    @Test fun parsesFincimexUsdWithoutCommission() {
        val parsed = ReceiptParser.parse(bankSms, "FINCIMEX / Clásica. La Transferencia fue completada. Beneficiario: 9760XXXXXXXX3476 Monto: 20.00 USD Comision 0.08 USD Nro. Transaccion: 774529", 1_760_000_000_003)!!
        assertEquals("FINCIMEX", parsed.bank); assertEquals("USD", parsed.currency); assertEquals(20.0, parsed.amount, 0.0)
        assertEquals("774529", parsed.transactionId)
    }

    @Test fun parsesOnlyOutgoingEtecsaPaymentAndLeavesTransactionIdToServer() {
        val parsed = ReceiptParser.parse("ETECSA", "Usted ha realizado una transferencia de 100,00 CUP al teléfono 51234567. Saldo: 400,00 CUP", 1_760_000_000_004)!!
        assertEquals("ETECSA", parsed.bank); assertEquals("CUP", parsed.currency); assertEquals(100.0, parsed.amount, 0.0)
        assertEquals("51234567", parsed.recipientPhone); assertEquals("", parsed.transactionId)
        assertNull(ReceiptParser.parse("ETECSA", "Usted ha recibido una transferencia de 100,00 CUP desde 51234567", 1_760_000_000_004))
        assertNull(ReceiptParser.parse("ETECSA", "Usted ha realizado una transferencia de 100,00 CUP. Saldo principal 0.02 CUP", 1_760_000_000_005))
    }

    @Test fun parsesRealEtecsaTransferTextWithoutReadingTheBalanceAsAmount() {
        val parsed = ReceiptParser.parse("ETECSA", "Usted ha transferido 2950 CUP al numero 51887383. Saldo principal 0.02 CUP, linea activa hasta el 28/02/2027", 1_760_000_000_006)!!
        assertEquals(2950.0, parsed.amount, 0.0)
        assertEquals("51887383", parsed.recipientPhone)
        assertEquals("outgoing", parsed.receiptKind)
        assertNull(ReceiptParser.parse("ETECSA", "Usted ha recibido 2950 CUP del numero 51887383", 1_760_000_000_007))
    }

    @Test fun acceptsOnlyFixedSendersAndKnownBankHeadings() {
        val bpa = "Banco Popular de Ahorro. La Transferencia fue completada. Beneficiario: 9205XXXXXXXX0959 Monto: 10.00 CUP Nro. Transaccion: BR601ABVZE997"
        assertEquals("BPA", ReceiptParser.parse("pagoxmovil", bpa, 1)?.bank)
        assertNull(ReceiptParser.parse("unknown", bpa, 1))
        assertNull(ReceiptParser.parse(bankSms, "La Transferencia fue completada. Beneficiario: 9205XXXXXXXX0959 Monto: 10.00 CUP Nro. Transaccion: BR601ABVZE997", 1))
        assertNull(ReceiptParser.parse("ETECSA", "Usted ha recibido una transferencia de 100,00 CUP desde 51234567", 1))
    }

    @Test fun doesNotStoreUnmaskedBeneficiaryOrGuessMalformedAmount() {
        assertNull(ReceiptParser.parse(bankSms, "BANDEC. Transferencia fue completada. Beneficiario: 12345678 Monto: 12 CUP Nro. Transaccion: ABC123", 1))
        assertNull(ReceiptParser.parse(bankSms, "BANDEC. La Transferencia fue completada. Beneficiario: 9205XXXXXXXX0959 Monto: 0 CUP Nro. Transaccion: ABC123", 1))
    }
}
