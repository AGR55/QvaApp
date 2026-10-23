package com.qvaapply.sms

import android.Manifest
import android.app.KeyguardManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal enum class Destination(val title: String) { Home("Inicio"), Operations("Operaciones"), Alerts("Avisos"), Settings("Ajustes"), Tools("Herramientas") }

class MainActivity : ComponentActivity() {
    private lateinit var settings: SecureSettings

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = SecureSettings(this)
        setContent {
            var theme by remember { mutableStateOf(settings.theme) }
            PrecisoTheme(theme) {
                QvaApplyApp(settings, this, theme) { theme = it; settings.theme = it }
            }
        }
    }
}

@Composable
private fun QvaApplyApp(settings: SecureSettings, activity: ComponentActivity, theme: String, onTheme: (String) -> Unit) {
    var destination by rememberSaveable { mutableStateOf(Destination.Home) }
    BackHandler(enabled=destination==Destination.Tools) { destination=Destination.Home }
    val cachedOperations = remember { settings.cachedResponse("operations")?.optJSONArray("data")?.let(::parseOperations).orEmpty() }
    val cachedAlerts = remember { settings.cachedResponse("alerts")?.optJSONArray("data")?.let(::parseAlerts).orEmpty() }
    val cachedReceipts = remember { settings.cachedResponse("receipts")?.optJSONArray("data")?.let(::parseJsonObjects).orEmpty() }
    var bindingVersion by remember { mutableIntStateOf(0) }
    var overview by remember { mutableStateOf(settings.cachedResponse("overview")?.optJSONObject("data")) }
    var overviewStale by remember { mutableStateOf(true) }
    var operations by remember { mutableStateOf(cachedOperations) }
    var alerts by remember { mutableStateOf(cachedAlerts) }
    var receipts by remember { mutableStateOf(cachedReceipts) }
    var lastUpdated by remember { mutableStateOf(if (settings.cachedAt() > 0) java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(java.util.Date(settings.cachedAt())) else "") }
    var connection by remember { mutableStateOf("Configura el servidor y el token de operador en Ajustes.") }
    var isStale by remember { mutableStateOf(true) }
    var receiptOutcomesConnected by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var actionMessage by remember { mutableStateOf("") }
    var selectedAction by remember { mutableStateOf<Pair<MobileOperation, String>?>(null) }
    var pendingAuthenticatedAction by remember { mutableStateOf<Pair<MobileOperation, String>?>(null) }
    var reference by remember { mutableStateOf("") }
    val context = activity
    val scope = rememberCoroutineScope()
    val refreshMutex = remember { Mutex() }
    var lastFastPollAt by remember { mutableLongStateOf(0L) }
    var lastOverviewPollAt by remember { mutableLongStateOf(0L) }
    var lastReceiptPollAt by remember { mutableLongStateOf(0L) }
    var isForeground by remember { mutableStateOf(activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }

    DisposableEffect(activity.lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> isForeground = true
                Lifecycle.Event.ON_PAUSE, Lifecycle.Event.ON_STOP, Lifecycle.Event.ON_DESTROY -> isForeground = false
                else -> Unit
            }
        }
        activity.lifecycle.addObserver(observer)
        onDispose { activity.lifecycle.removeObserver(observer) }
    }

    suspend fun refresh() {
        refreshMutex.withLock {
            if (settings.serverUrl.isBlank() || settings.operatorToken.isBlank()) return@withLock
            val requestBinding = bindingVersion
            val requestUrl = settings.serverUrl
            val requestToken = settings.operatorToken
            val now = SystemClock.elapsedRealtime()
            val fastDue = now - lastFastPollAt >= 5_000L
            val overviewDue = now - lastOverviewPollAt >= 30_000L
            val receiptsDue = now - lastReceiptPollAt >= 30_000L
            if (!fastDue && !receiptsDue) return@withLock
            if (fastDue) lastFastPollAt = now
            if (receiptsDue) lastReceiptPollAt = now
            if (overviewDue) lastOverviewPollAt = now
            busy = true
            val result = try {
                withContext(Dispatchers.IO) {
                    coroutineScope {
                        val operationsCall = if (fastDue) async { MobileApi.get(requestUrl, requestToken, "/api/mobile/operations?limit=100") } else null
                        val alertsCall = if (fastDue) async { MobileApi.get(requestUrl, requestToken, "/api/mobile/alerts") } else null
                        val receiptsCall = if (receiptsDue) async { MobileApi.get(requestUrl, requestToken, "/api/mobile/receipt-outcomes") } else null
                        val overviewCall = if (overviewDue) async { MobileApi.get(requestUrl, requestToken, "/api/mobile/overview") } else null
                        listOf(operationsCall?.await(), alertsCall?.await(), receiptsCall?.await(), overviewCall?.await())
                    }
                }
            } catch (cancelled: CancellationException) {
                busy = false
                throw cancelled
            } catch (_: Exception) {
                busy = false
                isStale = true
                overviewStale = true
                connection = "No se pudo actualizar; se conservan los últimos datos recibidos."
                return@withLock
            }
            if (requestBinding != bindingVersion) { busy = false; return@withLock }
            if (overviewDue) {
                val value = result[3]?.value
                overviewStale = value?.optJSONObject("data") == null
                if (!overviewStale) { overview = value!!.optJSONObject("data"); settings.saveCachedResponse("overview", value) }
            }
            val opsJson = result[0]?.value?.optJSONArray("data")
            var operationsConnected = !isStale
            var alertsConnected = !isStale
            if (fastDue) {
                if (opsJson != null) {
                    settings.saveCachedResponse("operations", result[0]!!.value!!)
                    operations = parseOperations(opsJson)
                    settings.setCachedAt(System.currentTimeMillis())
                    lastUpdated = java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(java.util.Date(settings.cachedAt()))
                    operationsConnected = true
                    // Clear a persisted uncertain intent only once the server no longer offers that action.
                    for (op in operations) listOf("paid", "received", "cancel").forEach { action ->
                        if (action !in op.actions) settings.clearActionUncertain(op.uuid, action)
                    }
                } else {
                    operationsConnected = false
                }
                val alertsResponse = result[1]?.value
                if (alertsResponse?.optJSONArray("data") != null) {
                    alerts = parseAlerts(alertsResponse.optJSONArray("data")!!)
                    settings.saveCachedResponse("alerts", alertsResponse)
                    alertsConnected = true
                } else {
                    alertsConnected = false
                }
            }
            if (receiptsDue) {
                val receiptsResponse = result[2]?.value
                if (receiptsResponse?.optJSONArray("data") != null) {
                    receipts = parseJsonObjects(receiptsResponse.optJSONArray("data")!!)
                    settings.saveCachedResponse("receipts", receiptsResponse)
                    receiptOutcomesConnected = true
                } else {
                    receiptOutcomesConnected = false
                }
            }
            isStale = !operationsConnected || !alertsConnected || !receiptOutcomesConnected
            if (fastDue) {
                connection = when {
                    !operationsConnected -> result[0]?.message?.ifBlank { "No se pudieron actualizar las operaciones." } ?: "No se pudieron actualizar las operaciones."
                    !alertsConnected -> "Operaciones actualizadas; no se pudieron cargar los avisos."
                    !receiptOutcomesConnected -> "Operaciones y avisos actualizados; resultados SMS desactualizados."
                    else -> "Conectado · actualizado $lastUpdated"
                }
            } else if (receiptsDue && !receiptOutcomesConnected) {
                connection = "Resultados SMS desactualizados; se conservan los últimos datos recibidos."
            }
            busy = false
        }
    }

    suspend fun submitAction(operation: MobileOperation, action: String) {
        if (settings.actionIsUncertain(operation.uuid, action)) {
            actionMessage = "Esta acción ya tiene un resultado incierto. Verifica la operación en el portal."
            busy = false
            selectedAction = null
            return
        }
        // Persist the intent only after the device credential challenge succeeds, but before network I/O.
        if (!settings.markActionUncertain(operation.uuid, action)) {
            actionMessage = "No se pudo guardar la intención de forma segura. La acción no se envió."
            busy = false
            selectedAction = null
            return
        }
        val result = withContext(Dispatchers.IO) {
            MobileApi.action(settings.serverUrl, settings.operatorToken, operation.uuid, action, reference.trim())
        }
        if (!result.uncertain && result.message != "Acción confirmada por el servidor.") {
            settings.clearActionUncertain(operation.uuid, action)
        }
        actionMessage = result.message
        selectedAction = null
        busy = false
        refresh()
    }

    val credentialLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val pending = pendingAuthenticatedAction
        pendingAuthenticatedAction = null
        if (pending == null) {
            busy = false
        } else if (DeviceCredentialAuth.confirmed(result.resultCode)) {
            scope.launch { submitAction(pending.first, pending.second) }
        } else {
            actionMessage = "Autenticación cancelada o fallida. La acción no se envió."
            selectedAction = null
            busy = false
        }
    }

    LaunchedEffect(isForeground, bindingVersion) {
        if (isForeground) {
            refresh()
            while (isForeground) {
                delay(5_000L)
                if (isForeground) refresh()
            }
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val refreshNow: () -> Unit = { scope.launch { lastFastPollAt = 0; lastReceiptPollAt = 0; lastOverviewPollAt = 0; refresh() } }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = { PrecisoNavigation(destination) { destination = it } },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            ConnectionHeader(connection, isStale, busy)
            when (destination) {
                Destination.Home -> HomeScreen(operations, alerts, overview, overviewStale,
                    onOperations = { destination = Destination.Operations },
                    onTools = { destination = Destination.Tools }, onSettings = { destination = Destination.Settings },
                    configured = settings.operatorToken.isNotBlank(), onRefresh = refreshNow, busy = busy)
                Destination.Operations -> OperationsScreen(operations, settings, isStale, busy, actionMessage,
                    onRefresh = refreshNow, onAction = { operation, action -> reference = ""; selectedAction = operation to action })
                Destination.Alerts -> AlertsScreen(alerts, receipts, busy, refreshNow)
                Destination.Tools -> ToolsScreen(settings, overview, overviewStale, bindingVersion)
                Destination.Settings -> SettingsScreen(settings, context, theme, onTheme, busy,
                    onPermission = {
                        if(ContextCompat.checkSelfPermission(context,Manifest.permission.RECEIVE_SMS)==PackageManager.PERMISSION_GRANTED)
                            activity.startActivity(android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,android.net.Uri.parse("package:${activity.packageName}")))
                        else permissionLauncher.launch(Manifest.permission.RECEIVE_SMS)
                    },
                    onSave = {
                        operations = emptyList(); alerts = emptyList(); receipts = emptyList()
                        overview = null; overviewStale = true; isStale = true; receiptOutcomesConnected = false
                        connection = "Comprobando vinculación…"; actionMessage = ""
                        lastFastPollAt = 0; lastReceiptPollAt = 0; lastOverviewPollAt = 0; bindingVersion++
                        WorkManager.getInstance(context).enqueueUniqueWork("upload-payment-receipts", ExistingWorkPolicy.KEEP,
                            OneTimeWorkRequestBuilder<ReceiptUploadWorker>().build())
                    })
            }
        }
    }

    selectedAction?.let { (operation, action) ->
        val label = actionLabel(action)
        AlertDialog(
            onDismissRequest = { if (!busy) selectedAction = null },
            title = { Text("Confirmar: $label") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Operación ${operation.uuid.take(12)} · ${money(operation.amount)} QUSD · ${money(operation.receive)} ${operation.currency}. Esta acción se enviará una vez.")
                    Text("Android pedirá confirmar tu identidad con las credenciales del dispositivo antes de enviarla.", style = MaterialTheme.typography.bodySmall)
                    if (action == "paid") OutlinedTextField(
                        value = reference, onValueChange = { reference = it }, label = { Text("Referencia del pago") },
                        singleLine = true, modifier = Modifier.fillMaxWidth(),
                    )
                    Text("Si no llega una respuesta clara, la acción quedará pendiente de verificación y no se repetirá automáticamente.", style = MaterialTheme.typography.bodySmall)
                }
            },
            confirmButton = {
                TextButton(enabled = !busy && (action != "paid" || reference.isNotBlank()), onClick = {
                    val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
                    if (!keyguard.isDeviceSecure) {
                        actionMessage = "Configura un bloqueo de pantalla para autorizar acciones sensibles."
                        selectedAction = null
                        return@TextButton
                    }
                    if (settings.actionIsUncertain(operation.uuid, action)) {
                        actionMessage = "Esta acción ya tiene un resultado incierto. Verifica la operación en el portal."
                        selectedAction = null
                        return@TextButton
                    }
                    val confirmationIntent = keyguard.createConfirmDeviceCredentialIntent(
                        "Autorizar acción de QvaApply",
                        "Confirma tu identidad para ${actionLabel(action).lowercase()}",
                    )
                    if (confirmationIntent == null) {
                        actionMessage = "Android no pudo abrir la confirmación de credenciales. La acción no se envió."
                        selectedAction = null
                        return@TextButton
                    }
                    busy = true
                    pendingAuthenticatedAction = operation to action
                    runCatching { credentialLauncher.launch(confirmationIntent) }.onFailure {
                        pendingAuthenticatedAction = null
                        actionMessage = "No se pudo abrir la confirmación de credenciales. La acción no se envió."
                        selectedAction = null
                        busy = false
                    }
                }) { Text("Confirmar") }
            },
            dismissButton = { TextButton(enabled = !busy, onClick = { selectedAction = null }) { Text("Volver") } },
        )
    }
}

private fun parseOperations(array: JSONArray): List<MobileOperation> = (0 until array.length()).mapNotNull { index ->
    val item = array.optJSONObject(index) ?: return@mapNotNull null
    val actionArray = item.optJSONArray("actions") ?: JSONArray()
    MobileOperation(
        uuid = item.optString("uuid"), side = item.optString("side"), marketLabel = item.optString("marketLabel"),
        currency = item.optString("currency"), amount = item.optString("amount"), receive = item.optString("receive"),
        rate = item.optString("rate"), status = item.optString("status"), createdAt = item.optString("createdAt"),
        actions = (0 until actionArray.length()).map { actionArray.optString(it) },
    )
}

private fun parseAlerts(array: JSONArray): List<MobileAlert> = (0 until array.length()).mapNotNull { index ->
    val item = array.optJSONObject(index) ?: return@mapNotNull null
    MobileAlert(item.optString("id"), item.optString("type"), item.optString("message"), item.optString("createdAt"), item.optString("operationUuid").ifBlank { null })
}

private fun parseJsonObjects(array: JSONArray): List<JSONObject> = (0 until array.length()).mapNotNull { array.optJSONObject(it) }

internal fun actionLabel(action: String): String = when (action) { "paid" -> "Marcar pagado"; "received" -> "Confirmar recepción"; "cancel" -> "Cancelar"; else -> action }
