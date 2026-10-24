package com.qvaapply.sms

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

private fun chatPath(target: ChatTarget, action: String = "", fresh: Boolean = false): String {
    val query = mutableListOf<String>()
    target.orderUuid?.let { query += "order=${Uri.encode(it)}" }
    if (fresh) query += "fresh=1"
    return "/api/mobile/operations/${Uri.encode(target.uuid)}/chat$action" + if(query.isEmpty()) "" else "?${query.joinToString("&")}"
}
private fun chatObjects(array: JSONArray?): List<JSONObject> = (0 until (array?.length() ?: 0)).mapNotNull { array?.optJSONObject(it) }

@Composable
internal fun ChatScreen(settings: SecureSettings, foreground: Boolean, target: ChatTarget?, onTarget: (ChatTarget?) -> Unit) {
    val context = LocalContext.current
    var search by rememberSaveable { mutableStateOf("") }
    var threads by remember { mutableStateOf(chatObjects(settings.cachedResponse("chat_threads")?.optJSONArray("data"))) }
    var status by remember { mutableStateOf("Última copia guardada") }
    var registered by remember { mutableStateOf(settings.pushRegistered) }
    var notifications by remember { mutableStateOf(ChatNotifications.enabled(context)) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        notifications = ChatNotifications.enabled(context)
        ChatNotifications.register(context)
    }
    LaunchedEffect(foreground, settings.serverUrl, settings.operatorToken) {
        if (!foreground) return@LaunchedEffect
        notifications = ChatNotifications.enabled(context)
        ChatNotifications.register(context)
        while (true) {
            val response = withContext(Dispatchers.IO) { MobileApi.get(settings.serverUrl, settings.operatorToken, "/api/mobile/operations/chats") }
            response.value?.let { threads = chatObjects(it.optJSONArray("data")); settings.saveCachedResponse("chat_threads", it) }
            registered=settings.pushRegistered
            status = if(response.value != null) "Tus ofertas y las que has tomado" else response.message
            delay(10_000)
        }
    }
    BackHandler(target != null) { onTarget(null) }
    Column(Modifier.fillMaxSize()) {
        if(notifications && !registered) Text("Activando avisos de chat… Se reintentará cuando haya conexión.",Modifier.padding(horizontal=22.dp,vertical=8.dp),style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
        if (!notifications) {
            Surface(color=MaterialTheme.colorScheme.secondaryContainer,shape=RoundedCornerShape(18.dp),modifier=Modifier.padding(horizontal=22.dp,vertical=8.dp)) {
                Column(Modifier.padding(16.dp)) {
                    Text("Recibe los mensajes al instante",style=MaterialTheme.typography.titleSmall)
                    Text("Activa las notificaciones para ver el remitente y el texto con la app cerrada.",style=MaterialTheme.typography.bodySmall)
                    TextButton(onClick={
                        if(Build.VERSION.SDK_INT>=33 && ContextCompat.checkSelfPermission(context,Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)
                            permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                        else context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,context.packageName))
                    }) { Text("Activar notificaciones") }
                }
            }
        }
        if(target == null) {
            LazyColumn(contentPadding=PaddingValues(22.dp),verticalArrangement=Arrangement.spacedBy(14.dp)) {
                item { SectionHeading("Cada orden, su conversación", "Mensajes", status) }
                item { OutlinedTextField(search,{search=it},label={Text("Mercado, contraparte u orden")},modifier=Modifier.fillMaxWidth(),singleLine=true,shape=RoundedCornerShape(18.dp)) }
                if(threads.isEmpty()) item { EmptyState("Sin conversaciones", "Las operaciones normales y cada orden por rango aparecerán al sincronizar tu cuenta.") }
                items(threads.filter { "$it".contains(search,ignoreCase=true) },key={it.optString("id")}) { thread ->
                    val order=thread.optString("orderUuid").takeIf {it.isNotBlank()&&it!="null"}
                    PrecisoPanel(Modifier.clickable { onTarget(ChatTarget(thread.optString("uuid"),order)) }) {
                        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
                            Text(thread.optString("counterpartyLabel").takeIf {it.isNotBlank()&&it!="null"} ?: "Contraparte",style=MaterialTheme.typography.titleMedium)
                            val unread=thread.optInt("unreadCount")
                            if(unread>0) Badge { Text("$unread") }
                        }
                        Text("${thread.optString("marketLabel",thread.optString("coin"))} · ${money(thread.optString("amount"))} QUSD",style=MaterialTheme.typography.bodyLarge)
                        Text("${if(thread.optString("role")=="creator") "Tu oferta" else "Oferta tomada"} · ${statusLabel(thread.optString("state"))}",style=MaterialTheme.typography.bodySmall)
                        Text("Oferta ${thread.optString("uuid").take(8)}${order?.let {" · Orden ${it.take(8)}"} ?: " · Normal"}",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        } else key(target.id) { ConversationScreen(settings,foreground,target,{onTarget(null)}) }
    }
}

@Composable
private fun ConversationScreen(settings: SecureSettings, foreground: Boolean, target: ChatTarget, onBack: ()->Unit) {
    val cacheKey = "chat:${target.id}"
    var chat by remember { mutableStateOf(settings.cachedResponse(cacheKey)?.optJSONObject("data")) }
    var draft by rememberSaveable { mutableStateOf(settings.cachedResponse("chat_draft:${target.id}")?.optString("draft").orEmpty()) }
    var error by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var uncertain by remember { mutableStateOf(settings.actionIsUncertain(target.id,"chat")) }
    var stale by remember { mutableStateOf(true) }
    var refreshVersion by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    val messages = remember(chat) { chatObjects(chat?.optJSONArray("messages")) }
    val marked = remember { mutableSetOf<String>() }
    LaunchedEffect(draft) { settings.saveCachedResponse("chat_draft:${target.id}",JSONObject().put("draft",draft).put("savedAt",System.currentTimeMillis())) }
    LaunchedEffect(foreground,refreshVersion) {
        if(!foreground) return@LaunchedEffect
        var first=true
        while(true) {
            val response=withContext(Dispatchers.IO) { MobileApi.get(settings.serverUrl,settings.operatorToken,chatPath(target,fresh=first)) }
            first=false
            if(response.value != null) {
                chat=response.value.optJSONObject("data"); settings.saveCachedResponse(cacheKey,response.value)
                stale=chat?.optBoolean("stale",true) ?: true
                error=""
            } else { error=response.message; stale=true }
            delay(6000)
        }
    }
    LaunchedEffect(messages.size) { if(messages.isNotEmpty()) listState.scrollToItem(messages.lastIndex) }
    LaunchedEffect(foreground,chat) {
        if(!foreground || chat==null) return@LaunchedEffect
        while(true) {
            delay(2000)
            val visible=listState.layoutInfo.visibleItemsInfo.mapNotNull {item->(item.key as? String)?.takeUnless {it in marked}}
            if(visible.isNotEmpty()) {
                val result=withContext(Dispatchers.IO) { MobileApi.post(settings.serverUrl,settings.operatorToken,chatPath(target,"/read"),JSONObject().put("ids",JSONArray(visible))) }
                if(result.value!=null) marked.addAll(visible)
            }
        }
    }
    Column(Modifier.fillMaxSize().imePadding().padding(horizontal=22.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
            TextButton(onClick=onBack) { Text("‹ Conversaciones") }
            TextButton(onClick={refreshVersion++}) { Text("Actualizar") }
        }
        Text("Oferta ${target.uuid.take(8)}${target.orderUuid?.let {" · Orden ${it.take(8)}"} ?: ""}",style=MaterialTheme.typography.titleMedium)
        Text(if(stale) "Copia guardada · pendiente de verificar" else "Conversación actualizada",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
        LazyColumn(state=listState,modifier=Modifier.weight(1f).fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(10.dp),contentPadding=PaddingValues(vertical=10.dp)) {
            if(messages.isEmpty()) item { EmptyState("Aún no hay mensajes", "Escribe aquí para coordinar esta operación.") }
            items(messages,key={it.optString("id")}) { message ->
                val own=message.optString("sender")=="own"
                Surface(shape=RoundedCornerShape(20.dp),color=if(own) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
                    modifier=Modifier.fillMaxWidth().padding(start=if(own) 28.dp else 0.dp,end=if(own) 0.dp else 28.dp)) {
                    Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(5.dp)) {
                        Text(if(own) "Tú" else if(message.optString("sender")=="moderator") "Moderación" else "Contraparte",style=MaterialTheme.typography.labelSmall)
                        Text(message.optString("message"),style=MaterialTheme.typography.bodyLarge)
                        if(message.has("createdAt")) Text(dateLabel(message.optString("createdAt")),style=MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
        if(error.isNotBlank()) Text(error,color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall)
        if(uncertain) {
            Text("No se confirmó el último envío. Comprueba los mensajes antes de volver a enviarlo.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.error)
            TextButton(onClick={settings.clearActionUncertain(target.id,"chat");uncertain=false}) { Text("He comprobado la conversación") }
        }
        OutlinedTextField(draft,{if(it.length<=599) draft=it},label={Text("Mensaje")},supportingText={Text("${draft.length}/599")},modifier=Modifier.fillMaxWidth(),maxLines=4,shape=RoundedCornerShape(18.dp))
        Button(onClick={
            if(sending||uncertain||draft.isBlank()) return@Button
            if(!settings.markActionUncertain(target.id,"chat")) {error="No se pudo guardar el envío de forma segura.";return@Button}
            sending=true
            scope.launch {
                val response=withContext(Dispatchers.IO) {MobileApi.post(settings.serverUrl,settings.operatorToken,chatPath(target),JSONObject().put("message",draft.trim()))}
                uncertain=response.uncertain
                if(!uncertain) settings.clearActionUncertain(target.id,"chat")
                if(response.value!=null) {draft="";chat=response.value.optJSONObject("data")?.optJSONObject("chat");refreshVersion++}
                else error=response.message
                sending=false
            }
        },enabled=!sending&&!uncertain&&draft.isNotBlank(),modifier=Modifier.fillMaxWidth().padding(bottom=10.dp)) { Text(if(sending) "Enviando…" else "Enviar mensaje") }
    }
}
