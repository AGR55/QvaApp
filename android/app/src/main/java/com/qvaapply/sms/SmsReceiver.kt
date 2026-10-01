package com.qvaapply.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        // Use device receipt time for matching against the operation creation time; SMS timestamps are sender-declared.
        val receivedAt = System.currentTimeMillis()
        var inserted = false
        Telephony.Sms.Intents.getMessagesFromIntent(intent).groupBy { it.originatingAddress.orEmpty() }.forEach { (sender, parts) ->
            val body = parts.joinToString("") { it.messageBody.orEmpty() }
            val receipt = ReceiptParser.parse(sender, body, receivedAt) ?: return@forEach
            ReceiptStore(context).add(receipt)
            inserted = true
        }
        if (!inserted) return
        WorkManager.getInstance(context).enqueueUniqueWork(
            "upload-payment-receipts", ExistingWorkPolicy.KEEP, OneTimeWorkRequestBuilder<ReceiptUploadWorker>().build(),
        )
    }
}
