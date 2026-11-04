package com.qvaapply.sms

import org.junit.Assert.*
import org.junit.Test

class AssistedPaymentTest {
    private val operation=MobileOperation("offer","sell","CUP","CUP","10","1000","100","applied","1",listOf("paid"),market="BANK_CUP",paymentAvailable=true)
    private val plan=AssistedPayment("offer",null,"BANK_CUP","1000.00","CUP","card","9204123412345678","51234567","a".repeat(64),1000,121000)

    @Test fun exactOfferOrderCurrencyAndFiatAmountAreMandatory() {
        assertTrue(plan.validFor(operation,2000))
        listOf(operation.copy(uuid="foreign"),operation.copy(orderUuid="child"),operation.copy(side="buy"),
            operation.copy(currency="USD"),operation.copy(receive="1001"),operation.copy(market="CLASICA"),
            operation.copy(role="creator"),operation.copy(receive="invalid"),operation.copy(status="paid"),
            operation.copy(status="cancelled"),operation.copy(status="revision")).forEach {assertFalse(plan.validFor(it,2000))}
    }

    @Test fun expiredFutureAndMalformedPreparationsCannotHandoff() {
        assertFalse(plan.validFor(operation,121000))
        assertFalse(plan.copy(checkedAt=40000,expiresAt=160000).validFor(operation,2000))
        assertFalse(plan.copy(expiresAt=500000).validFor(operation,2000))
        assertFalse(plan.copy(destination="9204123412345678*1#").validFor(operation,2000))
        assertFalse(plan.copy(confirmationPhone="51234567#").validFor(operation,2000))
        assertFalse(plan.copy(fingerprint="invalid").validFor(operation,2000))
        assertFalse(plan.copy(amount="1000.001").validFor(operation.copy(receive="1000.001"),2000))
    }

    @Test fun destinationBankDoesNotSelectAnOriginBankAndSourceFieldsAreNeverEdited() {
        assertEquals(listOf(PaymentSource.BPA,PaymentSource.BANDEC,PaymentSource.METRO),plan.sources)
        assertNull(paymentFormValues(plan,PaymentSource.CLASICA))
        assertNull(paymentFormValues(plan.copy(currency="USD"),PaymentSource.BPA))
        assertNull(paymentFormValues(plan.copy(amount="0.00"),PaymentSource.BPA))
        for(source in plan.sources) {
            val fields=paymentFormValues(plan,source)!!
            assertEquals(setOf("input_cuenta","input_monto","input_phone_confirm"),fields.keys)
            assertEquals(plan.destination,fields["input_cuenta"])
            assertFalse(fields.keys.any {it.contains("clave") || it.contains("origen") || it.contains("aceptar")})
        }
    }

    @Test fun missingConfirmationPhoneClearsTheOldFormValueRatherThanReusingIt() {
        assertEquals("",paymentFormValues(plan.copy(confirmationPhone=null),PaymentSource.BPA)!!["input_phone_confirm"])
    }

    @Test fun etecsaAndClasicaHaveSeparateRoutesAndNeverWritePin() {
        val etecsa=plan.copy(market="ETECSA",kind="phone",destination="51234567",confirmationPhone=null)
        assertEquals(listOf(PaymentSource.ETECSA),etecsa.sources)
        assertEquals(setOf("input_gnumero","input_gmonto"),paymentFormValues(etecsa,PaymentSource.ETECSA)!!.keys)
        assertNull(paymentFormValues(etecsa,PaymentSource.BPA))
        val clasica=plan.copy(market="CLASICA",currency="USD")
        assertEquals(listOf(PaymentSource.CLASICA),clasica.sources)
        assertNotNull(paymentFormValues(clasica,PaymentSource.CLASICA))
    }

    @Test fun finalConfirmationAuthenticationAndDisconnectAreOutsideTheNavigationAllowlist() {
        listOf("ACEPTAR","ENVIAR","Aceptar","Confirmar","Pagar","Autenticarse","Desconectar","1","*444*70#").forEach {
            assertFalse("label=$it",safePaymentNavigation(it))
        }
        assertTrue(safePaymentNavigation("Transferencia"))
        assertTrue(safePaymentNavigation("Transferir Efectivo Clásica"))
    }

    @Test fun onlyTheFirstKnownBankFormMayRequestReviewAndNeverAfterExpiryOrOnEtecsa() {
        assertTrue(mayRequestNativePaymentReview(PaymentSource.BPA,"Transferir Efectivo",false,3000,2000))
        assertTrue(mayRequestNativePaymentReview(PaymentSource.CLASICA,"Transferencia de Efectivo Clásica",false,3000,2000))
        assertFalse(mayRequestNativePaymentReview(PaymentSource.BPA,"Confirme",false,3000,2000))
        assertFalse(mayRequestNativePaymentReview(PaymentSource.BPA,"Transferir Efectivo",true,3000,2000))
        assertFalse(mayRequestNativePaymentReview(PaymentSource.BPA,"Transferir Efectivo",false,2000,2000))
        assertFalse(mayRequestNativePaymentReview(PaymentSource.ETECSA,"Transferir Saldo",false,3000,2000))
    }
}
