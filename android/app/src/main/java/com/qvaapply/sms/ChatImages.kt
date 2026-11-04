package com.qvaapply.sms

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal object ChatImages {
    private fun digest(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun folder(context: Context, settings: SecureSettings): File = File(context.cacheDir, "chat-images/${digest(settings.serverUrl + "\u0000" + settings.operatorToken)}").apply { mkdirs() }
    private fun file(context: Context, settings: SecureSettings, key: String) = File(folder(context, settings), digest(key))
    @Synchronized private fun secret(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val alias = "qva-chat-images-v1"
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    fun read(context: Context, settings: SecureSettings, key: String): ByteArray? = runCatching {
        val target = file(context, settings, key)
        if (target.length() !in 29..1_048_700) return null
        val bytes = target.readBytes()
        Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            doFinal(bytes, 12, bytes.size - 12)
        }
    }.getOrNull()
    @Synchronized fun save(context: Context, settings: SecureSettings, key: String, bytes: ByteArray) {
        require(bytes.size <= 1_048_576)
        val target = file(context, settings, key)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, secret()) }
        val temporary = File(target.path + ".tmp")
        try {
            temporary.outputStream().use { output -> output.write(cipher.iv); output.write(cipher.doFinal(bytes)); output.fd.sync() }
            check(temporary.renameTo(target))
            val files = File(context.cacheDir, "chat-images").walkTopDown().filter { it.isFile && !it.name.endsWith(".tmp") }.sortedByDescending { it.lastModified() }.toList()
            var total = 0L
            files.forEachIndexed { index, entry ->
                total += entry.length()
                if (index >= 48 || total > 24L * 1_048_576 || entry.lastModified() < System.currentTimeMillis() - 30L * 86400_000) entry.delete()
            }
        } finally { temporary.delete() }
    }
    fun remove(context: Context, settings: SecureSettings, key: String) { file(context, settings, key).delete() }

    fun bitmap(bytes: ByteArray): Bitmap {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        require(bounds.outWidth in 1..1000 && bounds.outHeight in 1..1000) { "Imagen no compatible" }
        return requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
    }

    fun prepare(context: Context, uri: Uri): ByteArray {
        val source = context.contentResolver.openInputStream(uri)?.use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                require(output.size() + count <= 16 * 1_048_576) { "El original supera 16 MiB" }
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        } ?: error("No se puede abrir la imagen")
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(source, 0, source.size, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0 && bounds.outWidth.toLong() * bounds.outHeight <= 80_000_000) { "Imagen inválida o demasiado grande" }
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 2000) sample *= 2
        val decoded = requireNotNull(BitmapFactory.decodeByteArray(source, 0, source.size, BitmapFactory.Options().apply { inSampleSize = sample }))
        val orientation = runCatching { source.inputStream().use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) } }.getOrDefault(1)
        val matrix = Matrix().apply {
            when (orientation) {
                2 -> setScale(-1f, 1f)
                3 -> setRotate(180f)
                4 -> setScale(1f, -1f)
                5 -> { setRotate(90f); postScale(-1f, 1f) }
                6 -> setRotate(90f)
                7 -> { setRotate(270f); postScale(-1f, 1f) }
                8 -> setRotate(270f)
            }
        }
        val oriented = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
        if (oriented !== decoded) decoded.recycle()
        val scale = minOf(1f, 1000f / maxOf(oriented.width, oriented.height))
        val resized = Bitmap.createScaledBitmap(oriented, maxOf(1, (oriented.width * scale).toInt()), maxOf(1, (oriented.height * scale).toInt()), true)
        if (resized !== oriented) oriented.recycle()
        try {
            for (quality in listOf(85, 75, 65, 55, 45)) {
                val output = ByteArrayOutputStream()
                check(resized.compress(Bitmap.CompressFormat.JPEG, quality, output))
                if (output.size() <= 524_288 || quality == 45 && output.size() <= 1_048_576) return output.toByteArray()
            }
            error("No se pudo reducir la imagen a 1 MiB")
        } finally { resized.recycle() }
    }
}
