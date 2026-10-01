package com.qvaapply.sms

import android.Manifest
import android.app.KeyguardManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
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

private enum class Destination(val title: String) { Operations("Operaciones"), Alerts("Avisos"), Settings("Ajustes/SMS") }

class MainActivity : ComponentActivity() {
    private lateinit var settings: SecureSettings

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = SecureSettings(this)
        setContent {
            MaterialTheme(
                colorScheme = lightColorScheme(
                    primary = androidx.compose.ui.graphics.Color(0xFF285E54),
                    onPrimary = androidx.compose.ui.graphics.Color.White,
                    secondary = androidx.compose.ui.graphics.Color(0xFFD69B42),
                    background = androidx.compose.ui.graphics.Color(0xFFF7F7F2),
                    surface = androidx.compose.ui.graphics.Color.White,
                    error = androidx.compose.ui.graphics.Color(0xFFB3261E),
                ),
            ) {
                QvaApplyApp(settings, this)
            }
        }
    }
}

@Composable
private fun QvaApplyApp(settings: SecureSettings, activity: ComponentActivity) {
    var destination by remember { mutableStateOf(Destination.Operations) }
    val cachedOperations = remember { settings.cachedResponse("operations")?.optJSONArray("data")?.let(::parseOperations).orEmpty() }
    val cachedAlerts = remember { settings.cachedResponse("alerts")?.optJSONArray("data")?.let(::parseAlerts).orEmpty() }
    val cachedReceipts = remember { settings.cachedResponse("receipts")?.optJSONArray("data")?.let(::parseJsonObjects).orEmpty() }
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
    var lastFastPollAt by remember { mutableStateOf(0L) }
    var lastReceiptPollAt by remember { mutableStateOf(0L) }
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
            val now = SystemClock.elapsedRealtime()
            val fastDue = now - lastFastPollAt >= 5_000L
            val receiptsDue = now - lastReceiptPollAt >= 30_000L
            if (!fastDue && !receiptsDue) return@withLock
            if (fastDue) lastFastPollAt = now
            if (receiptsDue) lastReceiptPollAt = now
            busy = true
            val result = try {
                withContext(Dispatchers.IO) {
                    coroutineScope {
                        val operationsCall = if (fastDue) async { MobileApi.get(settings.serverUrl, settings.operatorToken, "/api/mobile/operations?limit=100") } else null
                        val alertsCall = if (fastDue) async { MobileApi.get(settings.serverUrl, settings.operatorToken, "/api/mobile/alerts") } else null
                        val receiptsCall = if (receiptsDue) async { MobileApi.get(settings.serverUrl, settings.operatorToken, "/api/mobile/receipt-outcomes") } else null
                        Triple(operationsCall?.await(), alertsCall?.await(), receiptsCall?.await())
                    }
                }
            } catch (cancelled: CancellationException) {
                busy = false
                throw cancelled
            } catch (_: Exception) {
                busy = false
                isStale = true
                connection = "No se pudo actualizar; se conservan los últimos datos recibidos."
                return@withLock
            }
            val opsJson = result.first?.value?.optJSONArray("data")
            var operationsConnected = !isStale
            var alertsConnected = !isStale
            if (fastDue) {
                if (opsJson != null) {
                    settings.saveCachedResponse("operations", result.first!!.value!!)
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
                val alertsResponse = result.second?.value
                if (alertsResponse?.optJSONArray("data") != null) {
                    alerts = parseAlerts(alertsResponse.optJSONArray("data")!!)
                    settings.saveCachedResponse("alerts", alertsResponse)
                    alertsConnected = true
                } else {
                    alertsConnected = false
                }
            }
            if (receiptsDue) {
                val receiptsResponse = result.third?.value
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
                    !operationsConnected -> result.first?.message?.ifBlank { "No se pudieron actualizar las operaciones." } ?: "No se pudieron actualizar las operaciones."
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

    LaunchedEffect(isForeground, settings.serverUrl, settings.operatorToken) {
        if (isForeground) {
            refresh()
            while (isForeground) {
                delay(5_000L)
                if (isForeground) refresh()
            }
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    Scaffold(
        bottomBar = {
            NavigationBar {
                Destination.entries.forEach { item ->
                    NavigationBarItem(
                        selected = destination == item,
                        onClick = { destination = item },
                        icon = { Text(when (item) { Destination.Operations -> "▤"; Destination.Alerts -> "!"; Destination.Settings -> "⚙" }) },
                        label = { Text(item.title) },
                    )
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp)) {
                Text("QvaApply", style = MaterialTheme.typography.headlineSmall)
                Text(connection, style = MaterialTheme.typography.bodySmall, color = if (isStale) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
                if (isStale) Text("Datos guardados · pueden estar desactualizados", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
            }
            when (destination) {
                Destination.Operations -> OperationsScreen(
                    operations, settings, isStale, busy, actionMessage,
                    onRefresh = { scope.launch { refresh() } },
                    onAction = { operation, action ->
                        reference = ""
                        selectedAction = operation to action
                    },
                )
                Destination.Alerts -> AlertsScreen(alerts, receipts, busy, onRefresh = { scope.launch { refresh() } })
                Destination.Settings -> SettingsScreen(
                    settings = settings,
                    context = context,
                    onPermission = { permissionLauncher.launch(Manifest.permission.RECEIVE_SMS) },
                    onSave = {
                        WorkManager.getInstance(context).enqueueUniqueWork(
                            "upload-payment-receipts", ExistingWorkPolicy.KEEP, OneTimeWorkRequestBuilder<ReceiptUploadWorker>().build(),
                        )
                        scope.launch { refresh() }
                    },
                )
            }
        }
    }

    selectedAction?.let { (operation, action) ->
        val label = actionLabel(action)
        AlertDialog(
            onDismissRequest = { if (!busy) selectedAction = null },
            title = { Text("Confirmar: $label") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Operación ${operation.uuid.take(12)} · ${operation.amount} ${operation.currency}. Esta acción se enviará una vez.")
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

@Composable
private fun OperationsScreen(
    operations: List<MobileOperation>, settings: SecureSettings, stale: Boolean, busy: Boolean, message: String,
    onRefresh: () -> Unit, onAction: (MobileOperation, String) -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("${operations.size} operaciones", style = MaterialTheme.typography.titleMedium)
            TextButton(enabled = !busy, onClick = onRefresh) { Text(if (busy) "Actualizando…" else "Actualizar") }
        }
        if (message.isNotBlank()) Text(message, Modifier.padding(horizontal = 16.dp, vertical = 4.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        if (operations.isEmpty()) EmptyState(if (stale) "Sin datos guardados" else "No hay operaciones")
        LazyColumn(contentPadding = PaddingValues(start = 14.dp, end = 14.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(operations, key = { it.uuid }) { operation ->
                ElevatedCard(shape = RoundedCornerShape(18.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(operation.marketLabel.ifBlank { "Mercado" }, style = MaterialTheme.typography.titleMedium)
                            Text(operation.status, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                        }
                        Text("${operation.side} · ${operation.amount} ${operation.currency}  →  ${operation.receive} · tasa ${operation.rate}", style = MaterialTheme.typography.bodyMedium)
                        Text("${operation.uuid.take(12)} · ${operation.createdAt}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (operation.actions.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            operation.actions.filter { it in setOf("paid", "received", "cancel") }.forEach { action ->
                                val uncertain = settings.actionIsUncertain(operation.uuid, action)
                                OutlinedButton(enabled = !uncertain && !stale, onClick = { onAction(operation, action) }, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp)) {
                                    Text(if (uncertain) "Verificar" else actionLabel(action), style = MaterialTheme.typography.labelMedium)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AlertsScreen(alerts: List<MobileAlert>, receipts: List<JSONObject>, busy: Boolean, onRefresh: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("Avisos", style = MaterialTheme.typography.titleMedium)
            TextButton(enabled = !busy, onClick = onRefresh) { Text("Actualizar") }
        }
        LazyColumn(contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (alerts.isEmpty() && receipts.isEmpty()) item { EmptyState("No hay avisos recientes") }
            items(alerts, key = { "alert-${it.id}" }) { alert ->
                ElevatedCard(Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp)) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(alert.type.ifBlank { "Aviso" }, style = MaterialTheme.typography.titleSmall)
                        Text(alert.message, style = MaterialTheme.typography.bodyMedium)
                        Text(alert.createdAt, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            items(receipts, key = { "receipt-${it.optString("id")}" }) { receipt ->
                ElevatedCard(Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp)) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("SMS · ${receipt.optString("status", "recibido")}", style = MaterialTheme.typography.titleSmall)
                        Text(receipt.optString("reason").ifBlank { "Resultado procesado por el servidor." }, style = MaterialTheme.typography.bodyMedium)
                        Text(receipt.optString("receivedAt"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsScreen(settings: SecureSettings, context: Context, onPermission: () -> Unit, onSave: () -> Unit) {
    var serverUrl by remember { mutableStateOf(settings.serverUrl) }
    var deviceToken by remember { mutableStateOf(settings.deviceToken) }
    var operatorToken by remember { mutableStateOf(settings.operatorToken) }
    val allowed = ContextCompat.checkSelfPermission(context, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
    val (pending, sent) = remember { ReceiptStore(context).counts() }
    LazyColumn(contentPadding = PaddingValues(horizontal = 18.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Text("Servidor y seguridad", style = MaterialTheme.typography.titleMedium) }
        item { OutlinedTextField(serverUrl, { serverUrl = it }, Modifier.fillMaxWidth(), label = { Text("URL HTTPS") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri)) }
        item { OutlinedTextField(deviceToken, { deviceToken = it }, Modifier.fillMaxWidth(), label = { Text("Token de recepción SMS") }, singleLine = true, visualTransformation = PasswordVisualTransformation()) }
        item { OutlinedTextField(operatorToken, { operatorToken = it }, Modifier.fillMaxWidth(), label = { Text("Token de operador") }, singleLine = true, visualTransformation = PasswordVisualTransformation()) }
        item { Text("El token de operador es independiente y revocable. Créalo en el portal; nunca uses aquí la contraseña web.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        item {
            ElevatedCard(Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp)) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Recepción SMS", style = MaterialTheme.typography.titleSmall)
                    Text("Remitentes fijos: PAGOxMOVIL y ETECSA", style = MaterialTheme.typography.bodyMedium)
                    Text("Permiso: ${if (allowed) "permitido" else "pendiente"} · pendientes: $pending · aceptados: $sent", style = MaterialTheme.typography.bodySmall)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = onPermission) { Text(if (allowed) "Revisar permiso" else "Permitir SMS") }
                        OutlinedButton(onClick = { WorkManager.getInstance(context).enqueueUniqueWork("upload-payment-receipts", ExistingWorkPolicy.KEEP, OneTimeWorkRequestBuilder<ReceiptUploadWorker>().build()) }) { Text("Reintentar cola") }
                    }
                    Text("El SMS original y los saldos no se guardan ni se transmiten.", style = MaterialTheme.typography.labelSmall)
                }
            }
        }
        item {
            Button(modifier = Modifier.fillMaxWidth(), onClick = {
                settings.serverUrl = serverUrl
                settings.deviceToken = deviceToken
                settings.operatorToken = operatorToken
                onSave()
            }) { Text("Guardar ajustes") }
        }
    }
}

@Composable
private fun EmptyState(message: String) {
    Box(Modifier.fillMaxWidth().padding(vertical = 44.dp), contentAlignment = Alignment.Center) { Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant) }
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

private fun actionLabel(action: String): String = when (action) { "paid" -> "Marcar pagado"; "received" -> "Confirmar recepción"; "cancel" -> "Cancelar"; else -> action }
