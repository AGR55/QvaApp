package com.qvaapply.sms

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager

class MainActivity : AppCompatActivity() {
    private lateinit var settings: SecureSettings
    private lateinit var server: EditText
    private lateinit var token: EditText
    private lateinit var bpa: EditText
    private lateinit var metropolitan: EditText
    private lateinit var fincimex: EditText
    private lateinit var status: TextView
    private val smsPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { updateStatus() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = SecureSettings(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 28, 24, 24)
        }
        root.addView(TextView(this).apply { text = "QvaApply · recibos SMS"; textSize = 24f })
        root.addView(TextView(this).apply {
            text = "Introduce la URL HTTPS de tu instalación y el token de dispositivo emitido desde el panel. Configura exactamente los emisores de SMS de tus bancos; no se conoce ni se preconfigura ningún remitente."
            textSize = 15f; setPadding(0, 12, 0, 14)
        })
        server = field("URL del servidor HTTPS", settings.serverUrl).also(root::addView)
        token = field("Token de dispositivo", settings.deviceToken, password = true).also(root::addView)
        bpa = field("Emisor BPA (vacío para desactivar)", settings.bpaSender).also(root::addView)
        metropolitan = field("Emisor Banco Metropolitano", settings.metropolitanSender).also(root::addView)
        fincimex = field("Emisor FINCIMEX / Clásica", settings.fincimexSender).also(root::addView)
        root.addView(Button(this).apply {
            text = "Guardar configuración"
            setOnClickListener {
                settings.serverUrl = server.text.toString(); settings.deviceToken = token.text.toString()
                settings.bpaSender = bpa.text.toString(); settings.metropolitanSender = metropolitan.text.toString()
                settings.fincimexSender = fincimex.text.toString()
                val serverUri = Uri.parse(settings.serverUrl)
                val validServer = serverUri.scheme.equals("https", ignoreCase = true) && !serverUri.host.isNullOrBlank()
                val validToken = Regex("^[A-Za-z0-9_-]{40,100}$").matches(settings.deviceToken)
                if (validServer && validToken) {
                    WorkManager.getInstance(this@MainActivity).enqueueUniqueWork(
                        "upload-payment-receipts", ExistingWorkPolicy.REPLACE, OneTimeWorkRequestBuilder<ReceiptUploadWorker>().build(),
                    )
                }
                updateStatus()
            }
        })
        root.addView(Button(this).apply {
            text = "Permitir recepción de SMS"
            setOnClickListener {
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECEIVE_SMS) != PackageManager.PERMISSION_GRANTED) {
                    smsPermission.launch(Manifest.permission.RECEIVE_SMS)
                } else updateStatus()
            }
        })
        root.addView(Button(this).apply {
            text = "Reintentar envíos pendientes"
            setOnClickListener {
                WorkManager.getInstance(this@MainActivity).enqueueUniqueWork(
                    "upload-payment-receipts", ExistingWorkPolicy.REPLACE, OneTimeWorkRequestBuilder<ReceiptUploadWorker>().build(),
                )
            }
        })
        status = TextView(this).apply { textSize = 16f; setPadding(0, 16, 0, 0) }
        root.addView(status)
        setContentView(ScrollView(this).apply {
            isFillViewport = true
            addView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        })
        updateStatus()
    }

    override fun onResume() {
        super.onResume()
        if (::status.isInitialized) updateStatus()
    }

    private fun field(label: String, value: String, password: Boolean = false): EditText = EditText(this).apply {
        hint = label; setText(value); textSize = 16f
        if (password) inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    private fun updateStatus() {
        val (pending, sent) = ReceiptStore(this).counts()
        val permission = ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
        status.text = "Recepción SMS: ${if (permission) "permitida" else "sin permiso"}\nPendientes de envío: $pending\nAceptados por el servidor: $sent\nEl SMS original y el saldo no se guardan ni se transmiten."
    }
}
