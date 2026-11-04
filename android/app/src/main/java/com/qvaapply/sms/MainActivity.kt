package com.qvaapply.sms

import android.Manifest
import android.app.KeyguardManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.enableEdgeToEdge
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
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
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

internal enum class Destination(val title: String) { Home("Inicio"), Operations("Operaciones"), Alerts("Avisos"), Settings("Ajustes"), Tools("Herramientas"), Chats("Mensajes") }

class MainActivity : ComponentActivity() {
    private lateinit var settings: SecureSettings
    private var chatIntent by mutableStateOf<ChatTarget?>(null)
    private var chatIntentVersion by mutableIntStateOf(0)

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        chatIntent = ChatTarget.fromIntent(intent)
        chatIntentVersion++
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        settings = SecureSettings(this)
        chatIntent = ChatTarget.fromIntent(intent)
        ChatNotifications.register(this)
        setContent {
            var theme by remember { mutableStateOf(settings.theme) }
            PrecisoTheme(theme) {
                QvaApplyApp(settings, this, theme, { theme = it; settings.theme = it }, chatIntent, chatIntentVersion)
            }
        }
    }
}

@Composable
private fun QvaApplyApp(settings: SecureSettings, activity: ComponentActivity, theme: String, onTheme: (String) -> Unit, chatIntent: ChatTarget?, chatIntentVersion: Int) {
    var destination by rememberSaveable { mutableStateOf(Destination.Home) }
    var chatTarget by remember { mutableStateOf<ChatTarget?>(null) }
    var operationDetailId by rememberSaveable { mutableStateOf<String?>(null) }
    var paymentOperation by remember {mutableStateOf<MobileOperation?>(null)}
    var search by rememberSaveable { mutableStateOf("") }
    val operationState = rememberSaveableStateHolder()
    LaunchedEffect(destination) { if (destination == Destination.Chats) destination = Destination.Operations }
    LaunchedEffect(chatIntentVersion) { if(chatIntent!=null) {chatTarget=chatIntent; operationDetailId=chatIntent.id; destination=Destination.Operations} }
    BackHandler(enabled=destination==Destination.Tools || destination==Destination.Chats) { destination=Destination.Home }
    val cachedOperations = remember { settings.cachedResponse("operations")?.optJSONArray("data")?.let(::parseOperations).orEmpty() }
    val cachedAlerts = remember { settings.cachedResponse("alerts")?.optJSONArray("data")?.let(::parseAlerts).orEmpty() }
    val cachedReceipts = remember { settings.cachedResponse("receipts")?.optJSONArray("data")?.let(::parseJsonObjects).orEmpty() }
    var bindingVersion by remember { mutableIntStateOf(0) }
    var hiddenAlertIds by remember(bindingVersion) {
        val stored = settings.cachedResponse("hidden_alerts")?.optJSONArray("data")
        mutableStateOf((0 until (stored?.length() ?: 0)).mapNotNull { stored?.optString(it) }.toSet())
    }
    var overview by remember { mutableStateOf(settings.cachedResponse("overview")?.optJSONObject("data")) }
    var overviewStale by remember { mutableStateOf(true) }
    var operations by remember { mutableStateOf(cachedOperations) }
    var alerts by remember { mutableStateOf(cachedAlerts) }
    val displayedAlerts = alerts.filterNot { it.id in hiddenAlertIds }
    var receipts by remember { mutableStateOf(cachedReceipts) }
    var isStale by remember { mutableStateOf(true) }
    var receiptOutcomesConnected by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var actionBusy by remember { mutableStateOf(false) }
    val actionStates = remember { mutableStateMapOf<String, String>() }
    val snackbar = remember { SnackbarHostState() }
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
    var failedRefreshes by remember { mutableIntStateOf(0) }
    LaunchedEffect(actionMessage) {
        if (actionMessage.isNotBlank()) snackbar.showSnackbar(actionMessage, duration = SnackbarDuration.Short)
    }

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
            if (settings.serverUrl.isBlank() || settings.operatorToken.isBlank()) {
                return@withLock
            }
            if (!networkAvailable(context)) {
                return@withLock
            }
            val requestBinding = bindingVersion
            val requestUrl = settings.serverUrl
            val requestToken = settings.operatorToken
            val now = SystemClock.elapsedRealtime()
            val fastInterval = if (chatTarget != null) 15_000L else 5_000L
            val fastDue = now - lastFastPollAt >= fastInterval
            val overviewDue = now - lastOverviewPollAt >= 30_000L
            val receiptsDue = now - lastReceiptPollAt >= 30_000L
            if (!fastDue && !receiptsDue) return@withLock
            if (fastDue) lastFastPollAt = now
            if (receiptsDue) lastReceiptPollAt = now
            if (overviewDue) lastOverviewPollAt = now
            busy = true
            val result = try {
                coroutineScope {
                    val operationsCall = if (fastDue) async(Dispatchers.IO) { MobileApi.get(requestUrl, requestToken, "/api/mobile/operations?limit=100") } else null
                    val alertsCall = if (fastDue) async(Dispatchers.IO) { MobileApi.get(requestUrl, requestToken, "/api/mobile/alerts") } else null
                    val receiptsCall = if (receiptsDue) async(Dispatchers.IO) { MobileApi.get(requestUrl, requestToken, "/api/mobile/receipt-outcomes") } else null
                    val overviewCall = if (overviewDue) async(Dispatchers.IO) { MobileApi.get(requestUrl, requestToken, "/api/mobile/overview") } else null
                    val operationsResponse = operationsCall?.await()
                    if (requestBinding == bindingVersion) operationsResponse?.value?.let { response ->
                        response.optJSONArray("data")?.let { data ->
                            operations = parseOperations(data)
                            settings.saveCachedResponse("operations", response)
                            settings.setCachedAt(System.currentTimeMillis())
                            for (operation in operations) listOf("paid", "received", "cancel").forEach { action ->
                                if (action !in operation.actions) settings.clearActionUncertain(operation.uuid, action)
                            }
                        }
                    }
                    listOf(operationsResponse, alertsCall?.await(), receiptsCall?.await(), overviewCall?.await())
                }
            } catch (cancelled: CancellationException) {
                busy = false
                throw cancelled
            } catch (_: Exception) {
                busy = false
                isStale = true
                overviewStale = true
                failedRefreshes = (failedRefreshes + 1).coerceAtMost(4)
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
                    operationsConnected = true
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
            failedRefreshes = if (operationsConnected && alertsConnected) 0 else (failedRefreshes + 1).coerceAtMost(4)
            busy = false
        }
    }

    suspend fun submitAction(operation: MobileOperation, action: String) {
        if (!networkAvailable(context)) {
            actionBusy = false
            snackbar.showSnackbar("Sin conexión", duration = SnackbarDuration.Short)
            return
        }
        if (settings.actionIsUncertain(operation.uuid, action)) {
            actionMessage = "Esta acción ya tiene un resultado incierto. Verifica la operación en el portal."
            actionBusy = false
            selectedAction = null
            return
        }
        // Persist the intent only after the device credential challenge succeeds, but before network I/O.
        if (!settings.markActionUncertain(operation.uuid, action)) {
            actionMessage = "No se pudo guardar la intención de forma segura. La acción no se envió."
            actionBusy = false
            selectedAction = null
            return
        }
        actionStates[operation.id] = "Pendiente de confirmar"
        val requestBinding = bindingVersion
        val requestUrl = settings.serverUrl
        val requestToken = settings.operatorToken
        val submittedReference = reference.trim()
        selectedAction = null
        val result = withContext(Dispatchers.IO) {
            MobileApi.action(requestUrl, requestToken, operation.uuid, action, submittedReference)
        }
        if (requestBinding != bindingVersion) { actionBusy = false; return }
        if (!result.uncertain && result.message != "Acción confirmada por el servidor.") {
            settings.clearActionUncertain(operation.uuid, action)
        }
        actionMessage = result.message
        actionStates[operation.id] = when {
            result.value != null -> "Confirmada"
            result.uncertain -> "Pendiente de confirmar"
            else -> "Fallida"
        }
        selectedAction = null
        actionBusy = false
        lastFastPollAt = 0
        refresh()
    }

    val credentialLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val pending = pendingAuthenticatedAction
        pendingAuthenticatedAction = null
        if (pending == null) {
            actionBusy = false
        } else if (DeviceCredentialAuth.confirmed(result.resultCode)) {
            scope.launch { submitAction(pending.first, pending.second) }
        } else {
            actionMessage = "Autenticación cancelada o fallida. La acción no se envió."
            selectedAction = null
            actionBusy = false
        }
    }

    LaunchedEffect(isForeground, bindingVersion) {
        if (isForeground) {
            refresh()
            while (isForeground) {
                delay(5_000L * (1L shl failedRefreshes))
                if (isForeground) refresh()
            }
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val refreshNow: () -> Unit = { scope.launch {
        if (!networkAvailable(context)) snackbar.showSnackbar("Sin conexión", duration = SnackbarDuration.Short)
        else { lastFastPollAt = 0; lastReceiptPollAt = 0; lastOverviewPollAt = 0; refresh() }
    } }
    var detailOpen by remember {mutableStateOf(false)}
    val immersive=detailOpen || chatTarget!=null
    androidx.activity.compose.BackHandler(destination==Destination.Alerts) {destination=Destination.Home}
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {if(!immersive) {
            NativeHeader(destination.title,isStale,busy,displayedAlerts.size,{destination=Destination.Alerts},query=search,
                onQueryChange={search=it;destination=Destination.Operations},onBack=if(destination==Destination.Alerts) {{destination=Destination.Home}} else null)
        }},
        bottomBar = {if(!immersive && destination!=Destination.Alerts) PrecisoNavigation(destination) { destination = it; search="" } },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
            when (destination) {
                Destination.Home -> HomeScreen(operations, displayedAlerts, overview, overviewStale,
                    onOperations = { destination = Destination.Operations },
                    onTools = { destination = Destination.Tools }, onSettings = { destination = Destination.Settings },
                    configured = settings.operatorToken.isNotBlank(), onRefresh = refreshNow, busy = busy)
                Destination.Operations -> if(chatTarget != null) {
                    val current = operations.firstOrNull { it.id == chatTarget?.id }
                    current?.let { operation ->
                        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment=Alignment.CenterVertically, horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                            MarketLogo(operation.market, Modifier.size(32.dp))
                            Column(Modifier.weight(1f)) {
                                Text("${money(operation.amount)} QUSD · ${operation.marketLabel}", style=MaterialTheme.typography.titleSmall)
                                Text(statusLabel(operation.status), style=MaterialTheme.typography.bodySmall)
                            }
                            TextButton(onClick={chatTarget=null}) { Text("Detalles") }
                        }
                    }
                    key(bindingVersion) { ChatScreen(settings,isForeground,chatTarget,{chatTarget=it}) }
                } else operationState.SaveableStateProvider("operations:$bindingVersion") {
                    OperationsScreen(operations, settings, isStale, false, "",
                    onRefresh = refreshNow, onAction = { operation, action -> actionMessage="";reference = ""; selectedAction = operation to action },
                    onChat = { operation -> operationDetailId=operation.id;chatTarget=ChatTarget(operation.uuid,operation.orderUuid) }, onDetailOpen={detailOpen=it},query=search,actionStates=actionStates,initialDetailId=operationDetailId,onPayment={paymentOperation=it})
                }
                Destination.Chats -> key(bindingVersion) { ChatScreen(settings,isForeground,chatTarget,{chatTarget=it}) }
                Destination.Alerts -> AlertsScreen(alerts, receipts, busy, refreshNow, settings=settings,onHiddenChanged={hiddenAlertIds=it})
                Destination.Tools -> ToolsScreen(settings, overview, overviewStale, bindingVersion,onDetailOpen={detailOpen=it})
                Destination.Settings -> SettingsScreen(settings, context, theme, onTheme, busy,
                    onPermission = {
                        if(ContextCompat.checkSelfPermission(context,Manifest.permission.RECEIVE_SMS)==PackageManager.PERMISSION_GRANTED)
                            activity.startActivity(android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,android.net.Uri.parse("package:${activity.packageName}")))
                        else permissionLauncher.launch(Manifest.permission.RECEIVE_SMS)
                    },
                    onSave = {
                        operations = emptyList(); alerts = emptyList(); receipts = emptyList()
                        overview = null; overviewStale = true; isStale = true; receiptOutcomesConnected = false
                        actionMessage = ""; actionStates.clear(); operationDetailId=null;paymentOperation=null
                        lastFastPollAt = 0; lastReceiptPollAt = 0; lastOverviewPollAt = 0; bindingVersion++
                        chatTarget=null; ChatNotifications.register(context)
                        WorkManager.getInstance(context).enqueueUniqueWork("upload-payment-receipts", ExistingWorkPolicy.KEEP,
                            OneTimeWorkRequestBuilder<ReceiptUploadWorker>().build())
                    })
            }
        }
    }

    paymentOperation?.let {operation->
        key(bindingVersion,operation.id) {AssistedPaymentDialog(operation,settings,{paymentOperation=null})}
    }
    selectedAction?.let { (operation, action) ->
        val label = actionLabel(action)
        AlertDialog(
            onDismissRequest = { if (!actionBusy) selectedAction = null },
            title = { Text("Confirmar: $label") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
                TextButton(enabled = !actionBusy && (action != "paid" || reference.isNotBlank()), onClick = {
                    if (!networkAvailable(context)) {
                        scope.launch { snackbar.showSnackbar("Sin conexión", duration=SnackbarDuration.Short) }
                        return@TextButton
                    }
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
                    actionBusy = true
                    pendingAuthenticatedAction = operation to action
                    runCatching { credentialLauncher.launch(confirmationIntent) }.onFailure {
                        pendingAuthenticatedAction = null
                        actionMessage = "No se pudo abrir la confirmación de credenciales. La acción no se envió."
                        selectedAction = null
                        actionBusy = false
                    }
                }) { Text("Confirmar") }
            },
            dismissButton = { TextButton(enabled = !actionBusy, onClick = { selectedAction = null }) { Text("Volver") } },
        )
    }
}

internal fun parseOperations(array: JSONArray): List<MobileOperation> = (0 until array.length()).mapNotNull { index ->
    val item = array.optJSONObject(index) ?: return@mapNotNull null
    val actionArray = item.optJSONArray("actions") ?: JSONArray()
    MobileOperation(
        uuid = item.optString("uuid"), side = item.optString("side"), marketLabel = item.optString("marketLabel"),
        currency = item.optString("currency"), amount = item.optString("amount"), receive = item.optString("receive"),
        rate = item.optString("rate"), status = item.optString("status"), createdAt = item.optString("createdAt"),
        actions = (0 until actionArray.length()).map { actionArray.optString(it) },
        orderUuid = item.optString("orderUuid").takeIf { it.isNotBlank() && it != "null" },
        role = item.optString("role", "taker"), chatAvailable = item.optBoolean("chatAvailable", false),
        market = item.optString("market", item.optString("marketLabel")),
        paymentAvailable = item.optBoolean("paymentAvailable",false),
    )
}

private fun parseAlerts(array: JSONArray): List<MobileAlert> = (0 until array.length()).mapNotNull { index ->
    val item = array.optJSONObject(index) ?: return@mapNotNull null
    MobileAlert(item.optString("id"), item.optString("type"), item.optString("message"), item.optString("createdAt"), item.optString("operationUuid").ifBlank { null })
}

private fun parseJsonObjects(array: JSONArray): List<JSONObject> = (0 until array.length()).mapNotNull { array.optJSONObject(it) }

internal fun actionLabel(action: String): String = when (action) { "paid" -> "Marcar pagado"; "received" -> "Confirmar recepción"; "cancel" -> "Cancelar"; else -> action }
