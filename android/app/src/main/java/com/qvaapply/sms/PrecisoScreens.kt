package com.qvaapply.sms

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject

@Composable
internal fun PrecisoNavigation(selected: Destination, onSelect: (Destination) -> Unit) {
    Surface(Modifier.navigationBarsPadding().padding(horizontal=18.dp,vertical=8.dp).fillMaxWidth(),
        shape=RoundedCornerShape(30.dp),color=MaterialTheme.colorScheme.surface.copy(alpha=0.95f),
        border=BorderStroke(1.dp,MaterialTheme.colorScheme.outlineVariant.copy(alpha=0.65f)),shadowElevation=10.dp) {
        Row(Modifier.padding(6.dp),horizontalArrangement=Arrangement.SpaceEvenly) {
            listOf(Destination.Home,Destination.Operations,Destination.Alerts,Destination.Settings).forEach { item ->
                val active = selected == item || (selected == Destination.Tools && item == Destination.Home)
                val tint = if(active) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant
                Column(Modifier.weight(1f).clip(RoundedCornerShape(24.dp))
                    .background(if(active) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                    .clickable { onSelect(item) }.padding(vertical=10.dp),horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.spacedBy(3.dp)) {
                    PrecisoIcon(when(item) { Destination.Home -> "home"; Destination.Operations -> "operations"; Destination.Alerts -> "alerts"; else -> "settings" },color=tint)
                    Text(item.title,style=MaterialTheme.typography.labelSmall,color=tint,maxLines=2,textAlign=androidx.compose.ui.text.style.TextAlign.Center)
                }
            }
        }
    }
}

@Composable
internal fun ConnectionHeader(connection: String, stale: Boolean, busy: Boolean) {
    Row(Modifier.fillMaxWidth().padding(horizontal=22.dp,vertical=12.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(10.dp)) {
        PrecisoMark(Modifier.size(34.dp))
        Column(Modifier.weight(1f)) {
            Text("QvaApply",style=MaterialTheme.typography.titleMedium)
            Text(if(stale) "Datos guardados · sin verificar" else "Conexión verificada",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if(busy) CircularProgressIndicator(Modifier.size(16.dp),strokeWidth=2.dp)
        else Box(Modifier.size(8.dp).background(if(stale) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.secondary,CircleShape))
    }
    // Detailed connection errors remain readable and are never represented by color alone.
    if(stale) Text(connection,Modifier.padding(start=22.dp,end=22.dp,bottom=8.dp),style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.error)
}

@Composable
internal fun HomeScreen(operations: List<MobileOperation>, alerts: List<MobileAlert>, overview: JSONObject?, stale: Boolean,
    onOperations: () -> Unit, onTools: () -> Unit, onSettings: () -> Unit, configured: Boolean, onRefresh: () -> Unit, busy: Boolean) {
    val pending = operations.count { it.actions.isNotEmpty() }
    LazyColumn(contentPadding=PaddingValues(start=22.dp,end=22.dp,top=12.dp,bottom=24.dp),verticalArrangement=Arrangement.spacedBy(22.dp)) {
        item { SectionHeading("Tu centro de operaciones", "Todo en su sitio.", "Lo que necesita tu atención, a primera vista.") }
        item {
            Surface(shape=RoundedCornerShape(28.dp),color=Color(0xFF123B63),contentColor=Color(0xFFF4F5EE)) {
                Box(Modifier.fillMaxWidth().background(Brush.linearGradient(listOf(Color(0xFF123B63),Color(0xFF1D5367))))) {
                    Column(Modifier.padding(24.dp),verticalArrangement=Arrangement.spacedBy(14.dp)) {
                        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=Alignment.CenterVertically) {
                            Text("QUSD DISPONIBLES",style=MaterialTheme.typography.labelSmall,color=Color(0xFFD2E2ED))
                            PrecisoMark(Modifier.size(38.dp),Color(0xFFE2EFDB))
                        }
                        Text(if(overview==null||overview.isNull("balance")) "Sin dato" else money(overview.optString("balance")),style=MaterialTheme.typography.displaySmall,fontFamily=FontFamily.Serif)
                        Text(if(stale) "Último saldo guardado · pendiente de verificar" else "Saldo informado por QvaPay · ${dateLabel(overview?.optString("balanceUpdatedAt").orEmpty())}",style=MaterialTheme.typography.bodySmall,color=Color(0xFFD2E2ED))
                        HorizontalDivider(color=Color.White.copy(alpha=0.2f))
                        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
                            Column { Text(pending.toString(),style=MaterialTheme.typography.titleLarge); Text("Por atender",style=MaterialTheme.typography.labelSmall) }
                            Column { Text(operations.size.toString(),style=MaterialTheme.typography.titleLarge); Text("Operaciones",style=MaterialTheme.typography.labelSmall) }
                            Column { Text(alerts.size.toString(),style=MaterialTheme.typography.titleLarge); Text("Avisos",style=MaterialTheme.typography.labelSmall) }
                        }
                    }
                }
            }
        }
        if(!configured) item {
            PrecisoPanel {
                Text("Empecemos por vincular tu cuenta",style=MaterialTheme.typography.titleMedium)
                Text("Conecta este teléfono al servidor con tu token de operador. El permiso SMS es independiente.",style=MaterialTheme.typography.bodyMedium)
                Button(onClick=onSettings,modifier=Modifier.fillMaxWidth()) { Text("Vincular dispositivo") }
            }
        }
        item {
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=Alignment.CenterVertically) {
                Text("Tu siguiente paso",style=MaterialTheme.typography.titleLarge)
                TextButton(onClick=onRefresh,enabled=!busy) { Text("Actualizar") }
            }
        }
        item {
            PrecisoPanel(Modifier.clickable(onClick=onOperations)) {
                Row(horizontalArrangement=Arrangement.spacedBy(12.dp),verticalAlignment=Alignment.CenterVertically) {
                    PrecisoIcon("operations")
                    Column(Modifier.weight(1f)) {
                        Text(if(pending>0) "$pending operaciones por atender" else "Operaciones al día",style=MaterialTheme.typography.titleMedium)
                        Text(if(pending>0) "Revisa pagos y recepciones pendientes" else "Consulta estados y detalles",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text("→",fontSize=22.sp,color=MaterialTheme.colorScheme.primary)
                }
            }
        }
        item {
            PrecisoPanel(Modifier.clickable(onClick=onTools)) {
                Row(horizontalArrangement=Arrangement.spacedBy(12.dp),verticalAlignment=Alignment.CenterVertically) {
                    PrecisoIcon("target")
                    Column(Modifier.weight(1f)) {
                        Text("Cacerías y herramientas",style=MaterialTheme.typography.titleMedium)
                        Text("Capital, salud, rentabilidad y simulación",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text("→",fontSize=22.sp,color=MaterialTheme.colorScheme.primary)
                }
                val hunting=overview?.optJSONObject("hunting")
                Text(when { overview==null -> "Estado del motor sin verificar"; stale -> "Estado guardado · actualiza para verificar"; overview.optBoolean("paused") -> "Motor pausado"; else -> "Compras: ${if(hunting?.optBoolean("buyRunning")==true) "activas" else "detenidas"} · Ventas: ${if(hunting?.optBoolean("sellRunning")==true) "activas" else "detenidas"}" },style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.primary)
            }
        }
        item { Text("PRECISO EN CADA MOVIMIENTO",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun OperationsScreen(operations: List<MobileOperation>, settings: SecureSettings, stale: Boolean, busy: Boolean, message: String,
    onRefresh: () -> Unit, onAction: (MobileOperation,String) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf("Todas") }
    var detailId by rememberSaveable { mutableStateOf<String?>(null) }
    val visible=remember(operations,query,filter) { filterOperations(operations,query,filter) }
    val context=androidx.compose.ui.platform.LocalContext.current
    LazyColumn(contentPadding=PaddingValues(22.dp),verticalArrangement=Arrangement.spacedBy(14.dp)) {
        item { SectionHeading("Cada movimiento cuenta", "Operaciones", "Pagos, recepciones y seguimiento.") }
        item { OutlinedTextField(query,{query=it},modifier=Modifier.fillMaxWidth(),label={Text("Buscar mercado, importe o ID")},singleLine=true,shape=RoundedCornerShape(18.dp)) }
        item { Row(Modifier.horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            listOf("Todas","Por atender","Compras","Ventas").forEach { label -> FilterChip(selected=filter==label,onClick={filter=label},label={Text(label)}) }
        } }
        item { Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=Alignment.CenterVertically) {
            Text("${visible.size} resultados",style=MaterialTheme.typography.labelLarge)
            TextButton(onClick=onRefresh,enabled=!busy) { Text("Actualizar") }
        } }
        if(message.isNotBlank()) item { Text(message,color=MaterialTheme.colorScheme.primary,style=MaterialTheme.typography.bodyMedium) }
        if(visible.isEmpty()) item { EmptyState(if(query.isNotBlank()||filter!="Todas") "No hay coincidencias" else "Nada por aquí todavía",if(stale) "Actualiza la conexión para consultar tus operaciones." else "Las operaciones aparecerán aquí cuando estén disponibles.") }
        items(visible,key={it.uuid}) { op ->
            PrecisoPanel(Modifier.clickable { detailId=op.uuid }) {
                Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=Alignment.CenterVertically) {
                    Text(op.marketLabel,style=MaterialTheme.typography.titleMedium,modifier=Modifier.weight(1f))
                    StatusPill(statusLabel(op.status))
                }
                Text("${money(op.amount)} QUSD",style=MaterialTheme.typography.headlineMedium)
                Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
                    Text(if(op.side=="sell") "Compra de QUSD" else "Venta de QUSD",style=MaterialTheme.typography.bodyMedium)
                    Text("${money(op.receive)} ${op.currency}",style=MaterialTheme.typography.bodyMedium,fontWeight=FontWeight.SemiBold)
                }
                HorizontalDivider(color=MaterialTheme.colorScheme.outlineVariant)
                Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
                    Text(op.uuid.take(8),style=MaterialTheme.typography.labelSmall,fontFamily=FontFamily.Monospace)
                    Text(if(op.actions.isNotEmpty()) "Requiere atención →" else "Ver detalle →",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.primary)
                }
            }
        }
    }
    val detail=operations.firstOrNull { it.uuid==detailId }
    if(detail!=null) ModalBottomSheet(onDismissRequest={detailId=null},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true),containerColor=MaterialTheme.colorScheme.surface) {
        Column(Modifier.fillMaxWidth().verticalScrollCompat().padding(start=24.dp,end=24.dp,bottom=32.dp),verticalArrangement=Arrangement.spacedBy(16.dp)) {
            SectionHeading(detail.marketLabel, "${money(detail.amount)} QUSD",if(detail.side=="sell") "Compra de QUSD" else "Venta de QUSD")
            DetailRow("Importe fiat", "${money(detail.receive)} ${detail.currency}")
            DetailRow("Tasa",money(detail.rate))
            DetailRow("Estado",statusLabel(detail.status))
            DetailRow("Creada",dateLabel(detail.createdAt))
            Text(detail.uuid,style=MaterialTheme.typography.bodySmall,fontFamily=FontFamily.Monospace)
            OutlinedButton(onClick={ (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("ID de operación",detail.uuid)) },modifier=Modifier.fillMaxWidth()) { Text("Copiar ID de operación") }
            if(stale) Text("Actualiza la conexión antes de realizar una acción.",color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall)
            detail.actions.filter { it in listOf("paid","received","cancel") }.forEach { action ->
                val uncertain=settings.actionIsUncertain(detail.uuid,action)
                val label=if(uncertain) "Resultado pendiente de verificar" else actionLabel(action)
                if(action=="cancel") OutlinedButton(onClick={detailId=null;onAction(detail,action)},enabled=!busy&&!stale&&!uncertain,modifier=Modifier.fillMaxWidth(),colors=ButtonDefaults.outlinedButtonColors(contentColor=MaterialTheme.colorScheme.error)) { Text(label) }
                else Button(onClick={detailId=null;onAction(detail,action)},enabled=!busy&&!stale&&!uncertain,modifier=Modifier.fillMaxWidth()) { Text(label) }
            }
        }
    }
}

@Composable
internal fun AlertsScreen(alerts: List<MobileAlert>, receipts: List<JSONObject>, busy: Boolean, onRefresh: () -> Unit) {
    val sorted=remember(alerts) { alerts.sortedBy { noticePriority(it.type) } }
    LazyColumn(contentPadding=PaddingValues(22.dp),verticalArrangement=Arrangement.spacedBy(14.dp)) {
        item { SectionHeading("Lo importante, primero", "Avisos", "Acciones pendientes y comprobantes separados.") }
        item { TextButton(onClick=onRefresh,enabled=!busy) { Text("Actualizar avisos") } }
        if(alerts.isEmpty()&&receipts.isEmpty()) item { EmptyState("Todo despejado", "No hay avisos ni resultados SMS recientes.") }
        items(sorted,key={"alert-${it.id}"}) { alert -> PrecisoPanel {
            StatusPill(noticeTitle(alert.type),noticePriority(alert.type)==0)
            Text(alert.message,style=MaterialTheme.typography.bodyMedium)
            Text(dateLabel(alert.createdAt),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
        } }
        if(receipts.isNotEmpty()) item { Text("Comprobantes SMS",style=MaterialTheme.typography.titleLarge) }
        items(receipts,key={"receipt-${it.optString("id")}"}) { receipt -> PrecisoPanel {
            Text(receiptStatus(receipt.optString("status")),style=MaterialTheme.typography.titleMedium)
            Text(receipt.optString("reason").ifBlank { "El servidor recibió el comprobante." },style=MaterialTheme.typography.bodyMedium)
            Text(dateLabel(receipt.optString("receivedAt")),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
        } }
        item { Text("Los avisos se actualizan con la aplicación abierta. La entrega con la app cerrada aún no está disponible.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
internal fun SettingsScreen(settings: SecureSettings, context: Context, theme: String, onTheme: (String)->Unit, busy: Boolean,
    onPermission: ()->Unit,onSave: ()->Unit) {
    var server by rememberSaveable { mutableStateOf(settings.serverUrl) }
    // Tokens deliberately stay out of saved-instance-state bundles.
    var sms by remember { mutableStateOf(settings.deviceToken) }
    var operator by remember { mutableStateOf(settings.operatorToken) }
    var error by remember { mutableStateOf("") }
    var queue by remember { mutableStateOf(0 to 0) }
    var queueError by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { while(true) { runCatching { withContext(Dispatchers.IO) { ReceiptStore(context).use { it.counts() } } }.onSuccess { queue=it;queueError=false }.onFailure { queueError=true }; delay(5000) } }
    val allowed=ContextCompat.checkSelfPermission(context,Manifest.permission.RECEIVE_SMS)==PackageManager.PERMISSION_GRANTED
    LazyColumn(contentPadding=PaddingValues(22.dp),verticalArrangement=Arrangement.spacedBy(20.dp)) {
        item { SectionHeading("A tu manera", "Ajustes", "Apariencia, vinculación y comprobantes.") }
        item { PrecisoPanel {
            Text("Apariencia",style=MaterialTheme.typography.titleMedium)
            Row(Modifier.horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                listOf("system" to "Sistema","light" to "Claro","dark" to "Oscuro").forEach { (value,label) -> FilterChip(selected=theme==value,onClick={onTheme(value)},label={Text(label)}) }
            }
        } }
        item { PrecisoPanel {
            Text("Vincular dispositivo",style=MaterialTheme.typography.titleMedium)
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
                if(error.isEmpty()) onSave()
            },enabled=!busy,modifier=Modifier.fillMaxWidth()) { Text("Guardar y conectar") }
        } }
        item { PrecisoPanel {
            Text("Comprobantes SMS",style=MaterialTheme.typography.titleMedium)
            StatusPill(if(allowed) "Permiso concedido" else "Permiso pendiente")
            Text(if(queueError) "No se pudo leer la cola local." else "${queue.first} pendientes de envío · ${queue.second} aceptados por el servidor",style=MaterialTheme.typography.bodyMedium)
            Text("Remitentes admitidos: PAGOxMOVIL y ETECSA. Los saldos y el texto original del SMS no se envían.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedButton(onClick=onPermission,modifier=Modifier.fillMaxWidth()) { Text("Revisar permiso SMS") }
            OutlinedButton(onClick={ WorkManager.getInstance(context).enqueueUniqueWork("upload-payment-receipts",ExistingWorkPolicy.KEEP,OneTimeWorkRequestBuilder<ReceiptUploadWorker>().build()) },enabled=settings.deviceToken.isNotBlank(),modifier=Modifier.fillMaxWidth()) { Text("Reintentar envío de comprobantes") }
            Text("La coincidencia de un SMS requiere validación del servidor. Una recepción entrante nunca demuestra que hayas enviado un pago.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
        } }
        item { Text("QvaApply · Preciso\n${BuildConfig.VERSION_NAME} · APK privada",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
internal fun DetailRow(label: String,value: String) { Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) { Text(label,Modifier.weight(1f),style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant);Text(value,Modifier.weight(1f),style=MaterialTheme.typography.bodyMedium,fontWeight=FontWeight.Medium) } }
@Composable
internal fun StatusPill(label: String,urgent: Boolean=false) { Surface(shape=RoundedCornerShape(12.dp),color=if(urgent) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer) { Text(label,Modifier.padding(horizontal=10.dp,vertical=5.dp),style=MaterialTheme.typography.labelSmall,color=if(urgent) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onPrimaryContainer) } }
@Composable
internal fun EmptyState(title: String,body: String) { Column(Modifier.fillMaxWidth().padding(vertical=30.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) { PrecisoMark(Modifier.size(48.dp));Text(title,style=MaterialTheme.typography.titleLarge);Text(body,style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant) } }
@Composable
internal fun Modifier.verticalScrollCompat(): Modifier = this.then(Modifier.verticalScroll(rememberScrollState()))
