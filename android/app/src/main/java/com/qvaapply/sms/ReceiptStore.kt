package com.qvaapply.sms

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.content.ContentValues

class ReceiptStore(context: Context) : SQLiteOpenHelper(context, "receipts.db", null, 2) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("""CREATE TABLE receipts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bank TEXT NOT NULL, sender TEXT NOT NULL, currency TEXT NOT NULL,
            amount REAL NOT NULL, beneficiary_masked TEXT NOT NULL, transaction_id TEXT NOT NULL,
            received_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', last_error TEXT,
            recipient_phone TEXT, receipt_kind TEXT, market TEXT
        )""".trimIndent())
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE receipts ADD COLUMN recipient_phone TEXT")
            db.execSQL("ALTER TABLE receipts ADD COLUMN receipt_kind TEXT")
            db.execSQL("ALTER TABLE receipts ADD COLUMN market TEXT")
        }
    }

    fun add(receipt: ParsedReceipt): Long {
        val values = ContentValues().apply {
            put("bank", receipt.bank); put("sender", receipt.sender); put("currency", receipt.currency)
            put("amount", receipt.amount); put("beneficiary_masked", receipt.beneficiaryMasked)
            put("transaction_id", receipt.transactionId); put("received_at", receipt.receivedAt)
            put("recipient_phone", receipt.recipientPhone); put("receipt_kind", receipt.receiptKind); put("market", receipt.market)
        }
        return writableDatabase.insertOrThrow("receipts", null, values)
    }

    fun pending(): List<QueuedReceipt> {
        val result = mutableListOf<QueuedReceipt>()
        readableDatabase.rawQuery("SELECT * FROM receipts WHERE state='pending' ORDER BY id", null).use { c ->
            while (c.moveToNext()) result += QueuedReceipt(
                c.getLong(c.getColumnIndexOrThrow("id")),
                ParsedReceipt(
                    c.getString(1), c.getString(2), c.getString(3), c.getDouble(4), c.getString(5), c.getString(6), c.getLong(7),
                    recipientPhone = c.getString(c.getColumnIndexOrThrow("recipient_phone")),
                    receiptKind = c.getString(c.getColumnIndexOrThrow("receipt_kind")),
                    market = c.getString(c.getColumnIndexOrThrow("market")),
                ),
            )
        }
        return result
    }

    fun markSent(id: Long) { writableDatabase.execSQL("UPDATE receipts SET state='sent', last_error=NULL WHERE id=?", arrayOf(id)) }
    fun markError(id: Long, error: String) { writableDatabase.execSQL("UPDATE receipts SET last_error=? WHERE id=?", arrayOf<Any>(error.take(300), id)) }
    fun counts(): Pair<Int, Int> {
        readableDatabase.rawQuery("SELECT SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END), SUM(CASE WHEN state='sent' THEN 1 ELSE 0 END) FROM receipts", null).use {
            if (it.moveToFirst()) return (if (it.isNull(0)) 0 else it.getInt(0)) to (if (it.isNull(1)) 0 else it.getInt(1))
        }
        return 0 to 0
    }
}

data class QueuedReceipt(val id: Long, val receipt: ParsedReceipt)
