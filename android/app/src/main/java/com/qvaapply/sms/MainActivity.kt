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
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : AppCompatActivity() {
    private lateinit var settings: SecureSettings
    private lateinit var server: EditText
    private lateinit var token: EditText
    private lateinit var bpa: EditText
    private lateinit var metropolitan: EditText
    private lateinit var fincimex: EditText
    private lateinit var status: TextView
    private var connectionCheckMessage = ""
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
        root.addView(Button(this).apply {
            text = "Comprobar conexión"
            setOnClickListener { checkConnection(this) }
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
        status.text = "Recepción SMS: ${if (permission) "permitida" else "sin permiso"}\nPendientes de envío: $pending\nAceptados por el servidor: $sent\n$connectionCheckMessage\nEl SMS original y el saldo no se guardan ni se transmiten."
    }

    private fun checkConnection(button: Button) {
        // Use the saved credentials, matching the configuration the receiver/worker will use.
        val baseUrl = settings.serverUrl
        val deviceToken = settings.deviceToken
        val serverUri = Uri.parse(baseUrl)
        if (!serverUri.scheme.equals("https", ignoreCase = true) || serverUri.host.isNullOrBlank()) {
            connectionCheckMessage = "Conexión: guarda una URL HTTPS válida primero."
            updateStatus()
            return
        }
        if (!Regex("^[A-Za-z0-9_-]{40,100}$").matches(deviceToken)) {
            connectionCheckMessage = "Conexión: guarda un token de dispositivo válido primero."
            updateStatus()
            return
        }

        button.isEnabled = false
        connectionCheckMessage = "Conexión: comprobando…"
        updateStatus()
        Thread {
            var connection: HttpURLConnection? = null
            val result = try {
                val activeConnection = (URL("$baseUrl/api/mobile/device-check").openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 10_000
                    readTimeout = 10_000
                    instanceFollowRedirects = false
                    setRequestProperty("Authorization", "Bearer $deviceToken")
                    setRequestProperty("Accept", "application/json")
                }
                connection = activeConnection
                val code = activeConnection.responseCode
                val body = (if (code in 200..299) activeConnection.inputStream else activeConnection.errorStream)
                    ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
                when {
                    code == 200 && runCatching { JSONObject(body).optBoolean("ok") }.getOrDefault(false) ->
                        "Conexión: correcta; el servidor aceptó la credencial."
                    code == 401 -> "Conexión: credencial inválida, revocada o limitada."
                    code == 429 -> "Conexión: demasiados intentos; espera un momento y vuelve a probar."
                    code in 300..399 -> "Conexión: el servidor redirigió la solicitud; usa la URL HTTPS final."
                    else -> "Conexión: el servidor respondió HTTP $code."
                }
            } catch (_: Exception) {
                "Conexión: no se pudo contactar el servidor."
            } finally {
                connection?.disconnect()
            }
            runOnUiThread {
                connectionCheckMessage = result
                button.isEnabled = true
                updateStatus()
            }
        }.apply { name = "qvaapply-device-check" }.start()
    }
}
