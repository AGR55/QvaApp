package com.qvaapply.sms

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.selection.selectable
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.json.JSONArray

@Composable
internal fun PrecisoNavigation(selected: Destination, onSelect: (Destination) -> Unit) {
    Surface(color=MaterialTheme.colorScheme.surface,shadowElevation=4.dp) {
        Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(12.dp)) {
            listOf(Destination.Home,Destination.Operations,Destination.Tools,Destination.Settings).forEach { item ->
                val active=selected==item
                val tint=if(active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
                Column(Modifier.weight(1f).clip(RoundedCornerShape(16.dp)).selectable(selected=active,role=Role.Tab,onClick={onSelect(item)}),horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.spacedBy(4.dp)) {
                    Box(Modifier.clip(RoundedCornerShape(16.dp)).background(if(active) MaterialTheme.colorScheme.primaryContainer else Color.Transparent).padding(12.dp)) {
                        PrecisoIcon(when(item){Destination.Home->"home";Destination.Operations->"operations";Destination.Chats->"chat";Destination.Tools->"tools";else->"settings"},color=tint)
                    }
                    Text(item.title,style=MaterialTheme.typography.labelSmall,color=tint,maxLines=2,textAlign=androidx.compose.ui.text.style.TextAlign.Center)
                }
            }
        }
    }
}

@Composable
internal fun NativeHeader(title: String, stale: Boolean, busy: Boolean, alerts: Int, onAlerts: ()->Unit,
    query: String = "", onQueryChange: (String)->Unit = {}, onBack: (() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().statusBarsPadding().padding(12.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
        if(onBack!=null) IconButton(onClick=onBack) {PrecisoIcon("back",description="Volver")}
        OutlinedTextField(
            value=query,onValueChange=onQueryChange,modifier=Modifier.weight(1f),
            placeholder={Text("Buscar operación")},leadingIcon={PrecisoIcon("search")},
            singleLine=true,shape=RoundedCornerShape(16.dp),
            trailingIcon={if(query.isNotEmpty()) IconButton(onClick={onQueryChange("")}) {PrecisoIcon("close",description="Borrar búsqueda")}}
        )
        IconButton(onClick=onAlerts) { BadgedBox(badge={if(alerts>0) Badge {Text(alerts.toString())}}) {PrecisoIcon("alerts",description="Avisos")} }
    }
}

@Composable
internal fun PageBar(title: String, onBack: ()->Unit, subtitle: String?=null, topInset: Boolean=false, action: (@Composable ()->Unit)?=null) {
    Row(Modifier.fillMaxWidth().then(if(topInset) Modifier.statusBarsPadding() else Modifier).padding(8.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
        IconButton(onClick=onBack) {PrecisoIcon("back",description="Volver")}
        Column(Modifier.weight(1f)) {
            Text(title,style=MaterialTheme.typography.titleMedium)
            if(subtitle!=null) Text(subtitle,style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
        }
        action?.invoke()
    }
}

@Composable
internal fun ConnectionHeader(connection: String, stale: Boolean, busy: Boolean) {
    NativeHeader("Inicio",stale,busy,0,{})
}

@Composable
internal fun IconPlate(kind: String, mint: Boolean=false) {
    Box(Modifier.size(48.dp).clip(RoundedCornerShape(16.dp)).background(if(mint) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.primaryContainer),contentAlignment=Alignment.Center) {
        PrecisoIcon(kind,color=if(mint) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.primary)
    }
}

@Composable
internal fun HomeScreen(operations: List<MobileOperation>, alerts: List<MobileAlert>, overview: JSONObject?, stale: Boolean,
    onOperations: () -> Unit, onTools: () -> Unit, onSettings: () -> Unit, configured: Boolean, onRefresh: () -> Unit, busy: Boolean) {
    val pending=operations.count {it.actions.isNotEmpty()}
    val markets=objects(overview?.optJSONArray("markets"))
    LazyColumn(contentPadding=PaddingValues(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
        item {
            Surface(shape=RoundedCornerShape(20.dp),color=MaterialTheme.colorScheme.primaryContainer,contentColor=MaterialTheme.colorScheme.onPrimaryContainer) {
                Box(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=Alignment.CenterVertically) {
                            Text("Saldo disponible",style=MaterialTheme.typography.bodyMedium)
                            PrecisoIcon("wallet",color=MaterialTheme.colorScheme.onPrimaryContainer)
                        }
                        Row(verticalAlignment=Alignment.Bottom,horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                            Text(if(overview==null||overview.isNull("balance")) "—" else money(overview.optString("balance")),style=MaterialTheme.typography.displaySmall,modifier=Modifier.weight(1f,false))
                            Text("QUSD",style=MaterialTheme.typography.labelLarge)
                        }
                        Text(if(stale) "Copia guardada · saldo sin verificar" else "Actualizado ${dateLabel(overview?.optString("balanceUpdatedAt").orEmpty())}",style=MaterialTheme.typography.labelSmall)
                        HorizontalDivider(color=MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha=.18f))
                        Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                            PrecisoIcon("target",color=MaterialTheme.colorScheme.onPrimaryContainer)
                            val hunting=overview?.optJSONObject("hunting")
                            Text(when {overview==null||stale->"Cacerías sin verificar";overview.optBoolean("paused")->"Cacerías pausadas";else->"Compras ${if(hunting?.optBoolean("buyRunning")==true) "activas" else "detenidas"} · Ventas ${if(hunting?.optBoolean("sellRunning")==true) "activas" else "detenidas"}"},style=MaterialTheme.typography.labelMedium)
                        }
                    }
                }
            }
        }
        if(!configured) item {CompactSection {
            Text("Vincula tu cuenta",style=MaterialTheme.typography.titleMedium)
            Text("Conecta el servidor con tu token de operador.",style=MaterialTheme.typography.bodyMedium)
            Button(onClick=onSettings,modifier=Modifier.fillMaxWidth()) {Text("Conectar dispositivo")}
        }}
        if(markets.isNotEmpty()) {
            item {Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=Alignment.CenterVertically) {
                Text("Tu capital",style=MaterialTheme.typography.titleLarge)
                TextButton(onClick=onTools) {Text("Ver todo")}
            }}
            items(markets) { market ->
                Column {
                    Row(Modifier.fillMaxWidth().padding(12.dp),horizontalArrangement=Arrangement.spacedBy(12.dp),verticalAlignment=Alignment.CenterVertically) {
                        MarketLogo(market.optString("code").ifBlank {market.optString("label")},Modifier.size(40.dp))
                        Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(4.dp)) {
                            Text(market.optString("label"),style=MaterialTheme.typography.titleSmall)
                            Text("${market.optString("currency")} · registrado",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Text(money(market.optString("fiat")),style=MaterialTheme.typography.titleMedium)
                    }
                    HorizontalDivider(color=MaterialTheme.colorScheme.outlineVariant)
                }
            }
        }
        item {Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=Alignment.CenterVertically) {
            Text("Por atender",style=MaterialTheme.typography.titleLarge)
            IconButton(onClick=onRefresh,enabled=!busy) {PrecisoIcon("refresh",description="Actualizar")}
        }}
        item {CompactSection(Modifier.clickable(onClick=onOperations)) {
            Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                IconPlate(if(pending>0) "receipt" else "check",true)
                Column(Modifier.weight(1f)) {
                    Text(if(pending>0) "$pending operaciones pendientes" else "Todo al día",style=MaterialTheme.typography.titleMedium)
                    Text(if(pending>0) "Pagos y recepciones" else "Consulta tus movimientos",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                }
                PrecisoIcon("next")
            }
        }}
        itemsIndexed(operations.filter {it.actions.isNotEmpty()}.take(3),key={_,op->op.id}) {index,op->
            if(index>0) HorizontalDivider(color=MaterialTheme.colorScheme.outlineVariant)
            OperationRow(op,onOperations)
        }
    }
}

@Composable
internal fun OperationRow(op: MobileOperation,onClick: ()->Unit, actionState: String? = null) {
    Surface(Modifier.fillMaxWidth().clickable(onClick=onClick),color=MaterialTheme.colorScheme.background) {
        Row(Modifier.padding(12.dp),horizontalArrangement=Arrangement.spacedBy(12.dp),verticalAlignment=Alignment.CenterVertically) {
            MarketLogo(op.market,Modifier.size(40.dp))
            Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(4.dp)) {
                Text(op.marketLabel,style=MaterialTheme.typography.titleMedium)
                Text("${if(op.side=="sell") "Compra" else "Venta"} · ${if(op.orderUuid!=null) "Orden ${op.orderUuid.take(8)}" else op.uuid.take(8)}",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                StatusPill(statusLabel(op.status),op.actions.isNotEmpty())
                OperationActionStatus(actionState)
            }
            Column(Modifier.weight(1f),horizontalAlignment=Alignment.End,verticalArrangement=Arrangement.spacedBy(4.dp)) {
                Text("${money(op.amount)} QUSD",style=MaterialTheme.typography.titleMedium)
                Text("${money(op.receive)} ${op.currency}",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                Text(dateLabel(op.createdAt),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun OperationsScreen(operations: List<MobileOperation>, settings: SecureSettings, stale: Boolean, busy: Boolean, message: String,
    onRefresh: () -> Unit, onAction: (MobileOperation,String) -> Unit, onChats: (() -> Unit)? = null, onChat: ((MobileOperation) -> Unit)? = null, onDetailOpen: (Boolean)->Unit = {},
    query: String = "", initialDetailId: String? = null, actionStates: Map<String,String> = emptyMap(), onPayment: ((MobileOperation)->Unit)? = null) {
    var filter by rememberSaveable { mutableStateOf("Todas") }
    var detailId by rememberSaveable { mutableStateOf(initialDetailId) }
    val visible=remember(operations,query,filter) { filterOperations(operations,query,filter) }
    val context=androidx.compose.ui.platform.LocalContext.current
    DisposableEffect(Unit) {onDispose {onDetailOpen(false)}}
    androidx.activity.compose.BackHandler(detailId!=null) {detailId=null}
    val detail=operations.firstOrNull {it.id==detailId}
    val sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true)
    LaunchedEffect(initialDetailId) {if(initialDetailId!=null) detailId=initialDetailId}
    LaunchedEffect(detail?.id) {onDetailOpen(detail!=null)}
    LazyColumn(contentPadding=PaddingValues(16.dp)) {
        item { Row(Modifier.horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            listOf("Todas","Por atender","Compras","Ventas").forEach { label -> FilterChip(selected=filter==label,onClick={filter=label},label={Text(label)}) }
        } }
        item { Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=Alignment.CenterVertically) {
            Text("${visible.size} resultados",style=MaterialTheme.typography.labelLarge)
            TextButton(onClick=onRefresh,enabled=!busy) { Text("Actualizar") }
        } }
        if(message.isNotBlank()) item { Text(message,color=MaterialTheme.colorScheme.primary,style=MaterialTheme.typography.bodyMedium) }
        if(visible.isEmpty()) item { EmptyState(if(query.isNotBlank()||filter!="Todas") "No hay coincidencias" else "Nada por aquí todavía",if(stale) "Actualiza la conexión para consultar tus operaciones." else "Las operaciones aparecerán aquí cuando estén disponibles.") }
        itemsIndexed(visible,key={_,op->op.id}) {index,op->
            if(index>0) HorizontalDivider(color=MaterialTheme.colorScheme.outlineVariant)
            OperationRow(op,{detailId=op.id},actionStates[op.id])
        }
    }
    if(detail!=null) ModalBottomSheet(onDismissRequest={detailId=null},sheetState=sheetState) {
        PageBar("Detalle de operación",{detailId=null},detail.orderUuid?.let {"Orden ${it.take(8)}"}?:"Oferta ${detail.uuid.take(8)}")
        Column(Modifier.fillMaxWidth().wrapContentHeight().verticalScrollCompat().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            Column(verticalArrangement=Arrangement.spacedBy(8.dp)) {
                Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=Alignment.CenterVertically) {
                    MarketLogo(detail.market,Modifier.size(40.dp))
                    StatusPill(statusLabel(detail.status),detail.actions.isNotEmpty())
                }
                Text("${if(detail.side=="sell") "Compra" else "Venta"} · ${detail.marketLabel}",style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)
                Text("${money(detail.amount)} QUSD",style=MaterialTheme.typography.headlineLarge)
                Text("${money(detail.receive)} ${detail.currency}",style=MaterialTheme.typography.titleLarge,color=MaterialTheme.colorScheme.secondary)
            }
            OperationActionStatus(actionStates[detail.id])
            DetailRow("Tasa",money(detail.rate))
            DetailRow("Estado",statusLabel(detail.status))
            DetailRow("Creada",dateLabel(detail.createdAt))
            DetailRow("Origen",if(detail.role=="creator") "Tu oferta" else "Oferta tomada")
            detail.orderUuid?.let { DetailRow("Orden",it) }
            if(detail.chatAvailable && onChat!=null) Button(onClick={ onChat(detail) },modifier=Modifier.fillMaxWidth()) { Text("Abrir conversación") }
            Text(detail.uuid,style=MaterialTheme.typography.bodySmall,fontFamily=FontFamily.Monospace)
            OutlinedButton(onClick={ (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("ID de operación",detail.uuid)) },modifier=Modifier.fillMaxWidth()) { Text("Copiar ID de operación") }
            if(stale) Text("Copia guardada · se comprobará la conexión al actuar.",color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall)
            if(detail.paymentAvailable && onPayment!=null) Button(onClick={onPayment(detail)},enabled=!operationActionPending(actionStates[detail.id]),modifier=Modifier.fillMaxWidth()) {
                PrecisoIcon("card",description=null);Spacer(Modifier.width(8.dp));Text("Realizar pago")
            }
            detail.actions.filter { it in listOf("paid","received","cancel") }.forEach { action ->
                val uncertain=settings.actionIsUncertain(detail.uuid,action)
                val label=if(uncertain) "Resultado pendiente de verificar" else actionLabel(action)
                val enabled=!uncertain&&!operationActionPending(actionStates[detail.id])
                if(action=="cancel") OutlinedButton(onClick={onAction(detail,action)},enabled=enabled,modifier=Modifier.fillMaxWidth(),colors=ButtonDefaults.outlinedButtonColors(contentColor=MaterialTheme.colorScheme.error)) { Text(label) }
                else Button(onClick={onAction(detail,action)},enabled=enabled,modifier=Modifier.fillMaxWidth()) { Text(label) }
            }
        }
    }
}

internal const val HIDDEN_ALERTS_CACHE_KEY = "hidden_alerts"

internal fun hiddenAlertIds(settings: SecureSettings?): Set<String> {
    val stored=settings?.cachedResponse(HIDDEN_ALERTS_CACHE_KEY)?.optJSONArray("data")?:return emptySet()
    return (0 until stored.length()).mapNotNull {index->
        (stored.opt(index) as? String)?.takeIf {it.isNotBlank()}
    }.toSet()
}

@Composable
internal fun AlertsScreen(alerts: List<MobileAlert>, receipts: List<JSONObject>, busy: Boolean, onRefresh: () -> Unit,
    settings: SecureSettings? = null, onHiddenChanged: (Set<String>)->Unit = {}) {
    val binding=settings?.let {it.serverUrl to it.operatorToken}
    key(binding) {
        var hidden by rememberSaveable {
            mutableStateOf(ArrayList(hiddenAlertIds(settings)))
        }
        var undoIds by rememberSaveable {mutableStateOf(arrayListOf<String>())}
        val snackbar=remember {SnackbarHostState()}
        val currentOnHiddenChanged by rememberUpdatedState(onHiddenChanged)
        LaunchedEffect(Unit) {currentOnHiddenChanged(hidden.toSet())}
        fun persist(ids: List<String>) {
            settings?.saveCachedResponse(HIDDEN_ALERTS_CACHE_KEY,JSONObject().put("data",JSONArray(ids)))
            currentOnHiddenChanged(ids.toSet())
        }
        fun hide(id: String) {
            if(id !in hidden) {
                hidden=ArrayList(hideAlertLocally(hidden,id))
                persist(hidden)
                undoIds=ArrayList(undoIds+id)
            }
        }
        LaunchedEffect(undoIds.toList()) {
            if(undoIds.isNotEmpty()) {
                val snapshot=undoIds.toSet()
                val result=snackbar.showSnackbar(
                    message=if(snapshot.size==1) "Aviso ocultado en este dispositivo" else "${snapshot.size} avisos ocultados en este dispositivo",
                    actionLabel="Deshacer",withDismissAction=true,duration=SnackbarDuration.Long
                )
                if(result==SnackbarResult.ActionPerformed) {
                    hidden=ArrayList(restoreAlertsLocally(hidden,snapshot))
                    persist(hidden)
                }
                undoIds=ArrayList(undoIds.filterNot {it in snapshot})
            }
        }
        val sorted=remember(alerts,hidden) {visibleAlerts(alerts,hidden.toSet()).sortedBy {noticePriority(it.type)}}
        Column(Modifier.fillMaxSize()) {
            LazyColumn(Modifier.weight(1f),contentPadding=PaddingValues(16.dp)) {
                item {Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=Alignment.CenterVertically) {
                    Text("${sorted.size} avisos",style=MaterialTheme.typography.labelLarge)
                    TextButton(onClick=onRefresh,enabled=!busy) {Text("Actualizar")}
                }}
                if(hidden.isNotEmpty()) item {TextButton(onClick={
                    hidden=arrayListOf();undoIds=arrayListOf();persist(hidden)
                }) {Text("Mostrar avisos ocultos (${hidden.size})")}}
                if(sorted.isEmpty()&&receipts.isEmpty()) item {EmptyState("Todo despejado","No hay avisos visibles ni resultados SMS recientes.")}
                itemsIndexed(sorted,key={_,alert->"alert-${alert.id}"}) {index,alert->
                    if(index>0) HorizontalDivider(color=MaterialTheme.colorScheme.outlineVariant)
                    DismissibleAlertRow(alert,{hide(alert.id)})
                }
                if(receipts.isNotEmpty()) item {
                    Text("Comprobantes SMS",Modifier.padding(16.dp),style=MaterialTheme.typography.titleMedium)
                }
                itemsIndexed(receipts,key={_,receipt->"receipt-${receipt.optString("id")}"}) {index,receipt->
                    if(index>0) HorizontalDivider(color=MaterialTheme.colorScheme.outlineVariant)
                    Column(Modifier.fillMaxWidth().padding(12.dp),verticalArrangement=Arrangement.spacedBy(4.dp)) {
                        Text(receiptStatus(receipt.optString("status")),style=MaterialTheme.typography.titleSmall)
                        Text(receipt.optString("reason").ifBlank {"El servidor recibió el comprobante."},style=MaterialTheme.typography.bodyMedium)
                        Text(dateLabel(receipt.optString("receivedAt")),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            SnackbarHost(snackbar)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DismissibleAlertRow(alert: MobileAlert, onHide: ()->Unit) {
    val currentOnHide by rememberUpdatedState(onHide)
    val dismissState=rememberSwipeToDismissBoxState()
    val visibility=remember {MutableTransitionState(true)}
    var committed by remember {mutableStateOf(false)}
    LaunchedEffect(dismissState.settledValue) {
        if(dismissState.settledValue!=SwipeToDismissBoxValue.Settled) visibility.targetState=false
    }
    LaunchedEffect(visibility.isIdle,visibility.currentState,visibility.targetState) {
        if(!committed&&alertHideAnimationFinished(visibility.isIdle,visibility.currentState,visibility.targetState)) {
            committed=true
            dismissState.snapTo(SwipeToDismissBoxValue.Settled)
            currentOnHide()
        }
    }
    AnimatedVisibility(visibleState=visibility,exit=shrinkVertically(tween(180),shrinkTowards=Alignment.Top)+fadeOut(tween(180))) {
        SwipeToDismissBox(state=dismissState,enableDismissFromStartToEnd=false,backgroundContent={
            Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.secondaryContainer).padding(16.dp),contentAlignment=Alignment.CenterEnd) {
                Text("Ocultar",color=MaterialTheme.colorScheme.onSecondaryContainer)
            }
        }) {
            Surface(color=MaterialTheme.colorScheme.background,modifier=Modifier.semantics {
                customActions=listOf(CustomAccessibilityAction("Ocultar aviso en este dispositivo") {visibility.targetState=false;true})
            }) {
                Row(Modifier.fillMaxWidth().padding(12.dp),horizontalArrangement=Arrangement.spacedBy(8.dp),verticalAlignment=Alignment.Top) {
                    Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(4.dp)) {
                        StatusPill(noticeTitle(alert.type),noticePriority(alert.type)==0)
                        Text(alert.message,style=MaterialTheme.typography.bodyMedium)
                        Text(dateLabel(alert.createdAt),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    IconButton(onClick={visibility.targetState=false},enabled=visibility.targetState) {PrecisoIcon("close",description="Ocultar aviso en este dispositivo")}
                }
            }
        }
    }
}

@Composable
internal fun SettingsScreen(settings: SecureSettings, context: Context, theme: String, onTheme: (String)->Unit, busy: Boolean,
    onPermission: ()->Unit,onSave: ()->Unit, onNotificationChange: ((Boolean)->Unit)? = null) {
    var server by rememberSaveable { mutableStateOf(settings.serverUrl) }
    // Tokens deliberately stay out of saved-instance-state bundles.
    var sms by remember { mutableStateOf(settings.deviceToken) }
    var operator by remember { mutableStateOf(settings.operatorToken) }
    var editConnection by rememberSaveable {mutableStateOf(settings.operatorToken.isBlank())}
    var showSms by rememberSaveable {mutableStateOf(false)}
    var error by remember { mutableStateOf("") }
    var queue by remember { mutableStateOf(0 to 0) }
    var queueError by remember { mutableStateOf(false) }
    var notificationsEnabled by remember {mutableStateOf(settings.notificationsEnabled)}
    var notificationsAllowed by remember {mutableStateOf(ChatNotifications.enabled(context))}
    var allowed by remember {mutableStateOf(ContextCompat.checkSelfPermission(context,Manifest.permission.RECEIVE_SMS)==PackageManager.PERMISSION_GRANTED)}
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle,context) {
        val observer=LifecycleEventObserver {_,event->
            if(event==Lifecycle.Event.ON_RESUME) {
                notificationsAllowed=ChatNotifications.enabled(context)
                notificationsEnabled=settings.notificationsEnabled
                allowed=ContextCompat.checkSelfPermission(context,Manifest.permission.RECEIVE_SMS)==PackageManager.PERMISSION_GRANTED
            }
        }
        lifecycle.addObserver(observer)
        onDispose {lifecycle.removeObserver(observer)}
    }
    LaunchedEffect(Unit) { while(true) { runCatching { withContext(Dispatchers.IO) { ReceiptStore(context).use { it.counts() } } }.onSuccess { queue=it;queueError=false }.onFailure { queueError=true }; delay(5000) } }
    LazyColumn(contentPadding=PaddingValues(16.dp)) {
        item { CompactSection {
            Text("Apariencia",style=MaterialTheme.typography.titleMedium)
            Row(Modifier.horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                listOf("system" to "Sistema","light" to "Claro","dark" to "Oscuro").forEach { (value,label) -> FilterChip(selected=theme==value,onClick={onTheme(value)},label={Text(label)}) }
            }
        } }
        item { HorizontalDivider(color=MaterialTheme.colorScheme.outlineVariant) }
        item { CompactSection {
            Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(4.dp)) {
                    Text("Notificaciones",style=MaterialTheme.typography.titleMedium)
                    Text(when {
                        !notificationsEnabled -> "Desactivadas en QvaApply"
                        !notificationsAllowed -> "Bloqueadas en los ajustes del sistema o del canal"
                        else -> "Avisos de actividad y mensajes"
                    },style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Switch(checked=notificationsEnabled,onCheckedChange={enabled->
                    if(onNotificationChange!=null) onNotificationChange(enabled)
                    else ChatNotifications.setEnabled(context,enabled)
                    notificationsEnabled=settings.notificationsEnabled
                    notificationsAllowed=ChatNotifications.enabled(context)
                },modifier=Modifier.semantics {contentDescription="Notificaciones de QvaApply"})
            }
            if(notificationsEnabled&&!notificationsAllowed) TextButton(onClick={
                val action=if(NotificationManagerCompat.from(context).areNotificationsEnabled()) android.provider.Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS else android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS
                context.startActivity(android.content.Intent(action)
                    .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE,context.packageName)
                    .putExtra(android.provider.Settings.EXTRA_CHANNEL_ID,ChatNotifications.CHANNEL)
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
            }) {Text("Abrir ajustes de notificaciones")}
        } }
        item { HorizontalDivider(color=MaterialTheme.colorScheme.outlineVariant) }
        item { CompactSection {
            Row(Modifier.fillMaxWidth().clickable {editConnection=!editConnection},verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f)) {Text("Vinculación",style=MaterialTheme.typography.titleMedium);Text(if(settings.operatorToken.isBlank()) "Sin vincular" else "Dispositivo vinculado",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)}
                IconButton(onClick={editConnection=!editConnection}) {PrecisoIcon(if(editConnection) "close" else "settings",description=if(editConnection) "Cerrar edición" else "Editar conexión")}
            }
            if(editConnection) {
            Text("Utiliza los tokens de Ajustes → Móvil Android en la web. Nunca introduzcas la contraseña de tu cuenta.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(server,{server=it},Modifier.fillMaxWidth(),label={Text("Servidor HTTPS")},singleLine=true,keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Uri))
            OutlinedTextField(operator,{operator=it},Modifier.fillMaxWidth(),label={Text("Token de operador")},singleLine=true,visualTransformation=PasswordVisualTransformation(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Password))
            OutlinedTextField(sms,{sms=it},Modifier.fillMaxWidth(),label={Text("Token SMS (opcional)")},singleLine=true,visualTransformation=PasswordVisualTransformation(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Password))
            if(error.isNotBlank()) Text(error,color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall)
            Button(onClick={
                val uri=android.net.Uri.parse(server.trim())
                val validToken=Regex("^[A-Za-z0-9_-]{40,100}$")
                error=when {
                    uri.scheme!="https"||uri.host.isNullOrBlank()||uri.userInfo!=null||uri.query!=null||uri.fragment!=null -> "Introduce una URL HTTPS sin usuario, parámetros ni fragmento."
                    !validToken.matches(operator.trim()) -> "El token de operador no tiene un formato válido."
                    sms.isNotBlank()&&!validToken.matches(sms.trim()) -> "El token SMS no tiene un formato válido."
                    !settings.saveConnection(server,sms,operator) -> "No se pudo guardar la vinculación de forma segura."
                    else -> ""
                }
                if(error.isEmpty()) {editConnection=false;onSave()}
            },enabled=!busy,modifier=Modifier.fillMaxWidth()) { Text("Guardar vinculación") }
            }
        } }
        item { HorizontalDivider(color=MaterialTheme.colorScheme.outlineVariant) }
        item { CompactSection {
            Text("Comprobantes SMS",style=MaterialTheme.typography.titleMedium)
            StatusPill(if(allowed) "Permiso concedido" else "Permiso pendiente")
            Text(if(queueError) "No se pudo leer la cola local." else "${queue.first} pendientes de envío · ${queue.second} aceptados por el servidor",style=MaterialTheme.typography.bodyMedium)
            TextButton(onClick={showSms=!showSms}) {Text(if(showSms) "Ocultar opciones SMS" else "Gestionar comprobantes")}
            if(showSms) {
            Text("Remitentes admitidos: PAGOxMOVIL y ETECSA. Los saldos y el texto original del SMS no se envían.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedButton(onClick=onPermission,modifier=Modifier.fillMaxWidth()) { Text("Revisar permiso SMS") }
            OutlinedButton(onClick={ WorkManager.getInstance(context).enqueueUniqueWork("upload-payment-receipts",ExistingWorkPolicy.KEEP,OneTimeWorkRequestBuilder<ReceiptUploadWorker>().build()) },enabled=settings.deviceToken.isNotBlank(),modifier=Modifier.fillMaxWidth()) { Text("Reintentar envío de comprobantes") }
            Text("La coincidencia de un SMS requiere validación del servidor. Una recepción entrante nunca demuestra que hayas enviado un pago.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } }
        item { Text("QvaApply · Preciso\n${BuildConfig.VERSION_NAME} · APK privada",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
internal fun DetailRow(label: String,value: String) { Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) { Text(label,Modifier.weight(1f),style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant);Text(value,Modifier.weight(1f),style=MaterialTheme.typography.bodyMedium,fontWeight=FontWeight.Medium) } }
@Composable
internal fun StatusPill(label: String,urgent: Boolean=false) { Surface(shape=RoundedCornerShape(12.dp),color=if(urgent) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer) { Text(label,Modifier.padding(12.dp),style=MaterialTheme.typography.labelSmall,color=if(urgent) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onPrimaryContainer) } }
@Composable
internal fun EmptyState(title: String,body: String) { Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp),horizontalAlignment=Alignment.CenterHorizontally) { Text(title,style=MaterialTheme.typography.titleMedium,textAlign=androidx.compose.ui.text.style.TextAlign.Center);Text(body,style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant,textAlign=androidx.compose.ui.text.style.TextAlign.Center) } }
@Composable
internal fun Modifier.verticalScrollCompat(): Modifier = this.then(Modifier.verticalScroll(rememberScrollState()))

@Composable
private fun CompactSection(modifier: Modifier = Modifier, content: @Composable ColumnScope.()->Unit) {
    Column(modifier.fillMaxWidth().padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp),content=content)
}

internal fun operationActionLabel(state: String?): String? = when(state) {
    "pending", "Pendiente de confirmar" -> "Pendiente de confirmar"
    "confirmed", "Confirmada" -> "Confirmada"
    "failed", "Fallida" -> "Fallida"
    else -> state?.takeIf {it.isNotBlank()}
}

internal fun operationActionPending(state: String?): Boolean = operationActionLabel(state)=="Pendiente de confirmar"

internal fun hideAlertLocally(hidden: List<String>, id: String): List<String> =
    if(id.isBlank()||id in hidden) hidden else hidden+id

internal fun restoreAlertsLocally(hidden: List<String>, ids: Set<String>): List<String> = hidden.filterNot {it in ids}

internal fun visibleAlerts(alerts: List<MobileAlert>, hidden: Set<String>): List<MobileAlert> = alerts.filterNot {it.id in hidden}

internal fun alertHideAnimationFinished(isIdle: Boolean, currentVisible: Boolean, targetVisible: Boolean): Boolean =
    isIdle&&!currentVisible&&!targetVisible

@Composable
private fun OperationActionStatus(state: String?) {
    operationActionLabel(state)?.let {label->
        Text(label,style=MaterialTheme.typography.labelSmall,color=when(label) {
            "Fallida" -> MaterialTheme.colorScheme.error
            "Confirmada" -> MaterialTheme.colorScheme.secondary
            else -> MaterialTheme.colorScheme.primary
        },modifier=Modifier.semantics {liveRegion=androidx.compose.ui.semantics.LiveRegionMode.Polite})
    }
}
