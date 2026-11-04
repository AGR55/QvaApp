package com.qvaapply.sms

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

private fun chatPath(target: ChatTarget, action: String = "", fresh: Boolean = false): String {
    val query = mutableListOf<String>()
    target.orderUuid?.let { query += "order=${Uri.encode(it)}" }
    if (fresh) query += "fresh=1"
    return "/api/mobile/operations/${Uri.encode(target.uuid)}/chat$action" + if(query.isEmpty()) "" else "?${query.joinToString("&")}"
}
private fun chatObjects(array: JSONArray?): List<JSONObject> = (0 until (array?.length() ?: 0)).mapNotNull { array?.optJSONObject(it) }

@Composable
internal fun ChatScreen(settings: SecureSettings, foreground: Boolean, target: ChatTarget? = null, onTarget: (ChatTarget?) -> Unit = {}, initialTarget: ChatTarget? = target) {
    val context = LocalContext.current
    val selectedTarget = initialTarget ?: target
    var search by rememberSaveable { mutableStateOf("") }
    var threads by remember { mutableStateOf(chatObjects(settings.cachedResponse("chat_threads")?.optJSONArray("data"))) }
    LaunchedEffect(foreground, selectedTarget, settings.serverUrl, settings.operatorToken) {
        if (!foreground || selectedTarget != null) return@LaunchedEffect
        while (true) {
            if (!networkAvailable(context)) { delay(10_000); continue }
            val response = withContext(Dispatchers.IO) { MobileApi.get(settings.serverUrl, settings.operatorToken, "/api/mobile/operations/chats") }
            response.value?.let { threads = chatObjects(it.optJSONArray("data")); settings.saveCachedResponse("chat_threads", it) }
            delay(10_000)
        }
    }
    BackHandler(selectedTarget != null) { onTarget(null) }
    Column(Modifier.fillMaxSize()) {
        if(selectedTarget == null) {
            LazyColumn(contentPadding=PaddingValues(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                item { OutlinedTextField(search,{search=it},placeholder={Text("Buscar conversación")},leadingIcon={PrecisoIcon("search")},modifier=Modifier.fillMaxWidth(),singleLine=true,shape=RoundedCornerShape(12.dp)) }
                if(threads.isEmpty()) item {
                    Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp),horizontalAlignment=Alignment.CenterHorizontally) {
                        PrecisoIcon("chat",description=null)
                        EmptyState("Sin conversaciones", "Aparecerán al sincronizar tu cuenta.")
                    }
                }
                items(threads.filter { "$it".contains(search,ignoreCase=true) },key={it.optString("id")}) { thread ->
                    val order=thread.optString("orderUuid").takeIf {it.isNotBlank()&&it!="null"}
                    Surface(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable {onTarget(ChatTarget(thread.optString("uuid"),order))},color=MaterialTheme.colorScheme.surface,shape=RoundedCornerShape(12.dp)) {
                        Row(Modifier.padding(16.dp),horizontalArrangement=Arrangement.spacedBy(12.dp),verticalAlignment=Alignment.CenterVertically) {
                            val name=thread.optString("counterpartyLabel").takeIf {it.isNotBlank()&&it!="null"}?:"Contraparte"
                            Surface(shape=CircleShape,color=MaterialTheme.colorScheme.secondaryContainer,modifier=Modifier.size(48.dp)) {
                                Box(contentAlignment=Alignment.Center) {Text(name.take(2).uppercase(),style=MaterialTheme.typography.titleMedium,color=MaterialTheme.colorScheme.onSecondaryContainer)}
                            }
                            Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(4.dp)) {
                                Text(name,style=MaterialTheme.typography.titleMedium)
                                Text("${thread.optString("marketLabel",thread.optString("coin"))} · ${money(thread.optString("amount"))} QUSD",style=MaterialTheme.typography.bodyMedium)
                                Text("${if(order!=null) "Orden ${order.take(8)}" else "Oferta ${thread.optString("uuid").take(8)}"} · ${statusLabel(thread.optString("state"))}",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            val unread=thread.optInt("unreadCount")
                            if(unread>0) Badge {Text("$unread")} else PrecisoIcon("next",color=MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        } else key(selectedTarget.id, settings.serverUrl, settings.operatorToken) { ConversationScreen(settings,foreground,selectedTarget,{onTarget(null)}) }
    }
}

@Composable
private fun ConversationScreen(settings: SecureSettings, foreground: Boolean, target: ChatTarget, onBack: ()->Unit) {
    val context = LocalContext.current
    val cacheKey = "chat:${target.id}"
    var chat by remember { mutableStateOf(settings.cachedResponse(cacheKey)?.optJSONObject("data")) }
    var draft by rememberSaveable { mutableStateOf(settings.cachedResponse("chat_draft:${target.id}")?.optString("draft").orEmpty()) }
    var error by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var preparing by remember { mutableStateOf(false) }
    var image by remember { mutableStateOf<ByteArray?>(null) }
    var progress by remember { mutableIntStateOf(0) }
    var attemptId by rememberSaveable { mutableStateOf(settings.cachedResponse("chat_draft:${target.id}")?.optString("attemptId").orEmpty()) }
    var uncertain by remember { mutableStateOf(settings.actionIsUncertain(target.id,"chat")) }
    var stale by remember { mutableStateOf(chat?.optBoolean("stale",true) ?: true) }
    var refreshVersion by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    fun connected(): Boolean {
        if (networkAvailable(context)) return true
        scope.launch { snackbar.showSnackbar("Sin conexión") }
        return false
    }
    LaunchedEffect(error) { if (error.startsWith("Sin conexión")) snackbar.showSnackbar("Sin conexión") }
    val pendingImageKey = "pending:${target.id}"
    LaunchedEffect(target.id) {
        preparing=true
        try { image = withContext(Dispatchers.IO) { ChatImages.read(context, settings, pendingImageKey) } }
        finally { preparing=false }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null && !sending && !uncertain) scope.launch {
            preparing = true
            try {
                image = withContext(Dispatchers.IO) {
                    ChatImages.prepare(context, uri).also { ChatImages.save(context, settings, pendingImageKey, it) }
                }
                attemptId = ""
                error = ""
            } catch (cause: Exception) {
                if (cause is kotlinx.coroutines.CancellationException) throw cause
                error = cause.message ?: "No se pudo preparar la imagen."
            } finally { preparing = false }
        }
    }
    val listState = rememberLazyListState()
    val messages = remember(chat) { chatObjects(chat?.optJSONArray("messages")) }
    val marked = remember { mutableSetOf<String>() }
    LaunchedEffect(draft, attemptId) { settings.saveCachedResponse("chat_draft:${target.id}",JSONObject().put("draft",draft).put("attemptId",attemptId).put("savedAt",System.currentTimeMillis())) }
    suspend fun checkAttempt() {
        if (attemptId.isBlank()) return
        val response = withContext(Dispatchers.IO) { MobileApi.get(settings.serverUrl,settings.operatorToken,chatPath(target,"/sends/${Uri.encode(attemptId)}")) }
        when (response.value?.optJSONObject("data")?.optString("state")) {
            "confirmed" -> {
                val sentId=response.value.optJSONObject("data")?.optString("id").orEmpty()
                if(sentId.isNotBlank()) withContext(Dispatchers.IO) {
                    runCatching {
                        val pending=image ?: ChatImages.read(context,settings,pendingImageKey)
                        if(pending!=null) ChatImages.save(context,settings,"${target.id}:$sentId",pending)
                    }
                }
                settings.clearActionUncertain(target.id,"chat")
                uncertain = false
                draft = ""
                image = null
                withContext(Dispatchers.IO) { ChatImages.remove(context,settings,pendingImageKey) }
                attemptId = ""
                refreshVersion++
            }
            "rejected" -> {
                settings.clearActionUncertain(target.id,"chat")
                uncertain = false
            }
            "not_found" -> error = "El servidor aún no tiene evidencia del envío. Se mantiene bloqueado para evitar duplicados."
            else -> if (response.value == null) error = response.message
        }
    }
    LaunchedEffect(foreground, uncertain, attemptId) { if (foreground && uncertain && networkAvailable(context)) checkAttempt() }
    LaunchedEffect(foreground,refreshVersion) {
        if(!foreground) return@LaunchedEffect
        var first=true
        var failures=0
        while(true) {
            if(!networkAvailable(context)) { delay(10_000); continue }
            val response=withContext(Dispatchers.IO) { MobileApi.get(settings.serverUrl,settings.operatorToken,chatPath(target,fresh=first)) }
            first=false
            if(response.value != null) {
                chat=response.value.optJSONObject("data"); settings.saveCachedResponse(cacheKey,response.value)
                stale=chat?.optBoolean("stale",true) ?: true
                error=""
                failures=0
            } else {
                if(!response.message.startsWith("Sin conexión")) error=response.message
                stale=true
                failures=(failures+1).coerceAtMost(4)
            }
            delay((6_000L * (1L shl failures)).coerceAtMost(80_000L))
        }
    }
    var initialScroll by remember {mutableStateOf(true)}
    LaunchedEffect(messages.size) {
        val nearBottom=listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let {it>=messages.size-3}?:true
        if(messages.isNotEmpty()&&(initialScroll||nearBottom)) {listState.scrollToItem(messages.lastIndex);initialScroll=false}
    }
    LaunchedEffect(foreground,chat) {
        if(!foreground || chat==null) return@LaunchedEffect
        while(true) {
            delay(2000)
            if(!networkAvailable(context)) continue
            val visible=listState.layoutInfo.visibleItemsInfo.mapNotNull {item->(item.key as? String)?.takeUnless {it in marked}}
            if(visible.isNotEmpty()) {
                val result=withContext(Dispatchers.IO) { MobileApi.post(settings.serverUrl,settings.operatorToken,chatPath(target,"/read"),JSONObject().put("ids",JSONArray(visible))) }
                if(result.value!=null) marked.addAll(visible)
            }
        }
    }
    val thread=remember(settings,target.id) {chatObjects(settings.cachedResponse("chat_threads")?.optJSONArray("data")).firstOrNull {it.optString("id")==target.id}}
    val name=thread?.optString("counterpartyLabel")?.takeIf {it.isNotBlank()&&it!="null"}?:"Conversación"
    Column(Modifier.fillMaxSize().imePadding()) {
        Surface(color=MaterialTheme.colorScheme.surface) {
            PageBar(name,onBack,"${thread?.optString("marketLabel").orEmpty()} · ${if(target.orderUuid!=null) "Orden ${target.orderUuid.take(8)}" else "Oferta ${target.uuid.take(8)}"}") {
                IconButton(onClick={if(connected()) refreshVersion++}) {PrecisoIcon("refresh",description="Actualizar conversación")}
            }
        }
        if(stale) Text("Copia guardada · pendiente de verificar",Modifier.fillMaxWidth().padding(8.dp),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
        LazyColumn(state=listState,modifier=Modifier.weight(1f).fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(8.dp),contentPadding=PaddingValues(16.dp)) {
            if(messages.isEmpty()) item {
                Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp),horizontalAlignment=Alignment.CenterHorizontally) {
                    PrecisoIcon("chat",description=null)
                    EmptyState("Inicia la conversación","Coordina aquí esta operación.")
                }
            }
            items(messages,key={it.optString("id")}) {message->
                val own=message.optString("sender")=="own"
                Row(Modifier.fillMaxWidth(),horizontalArrangement=if(own) Arrangement.End else Arrangement.Start) {
                    Surface(shape=RoundedCornerShape(topStart=12.dp,topEnd=12.dp,bottomStart=if(own) 12.dp else 8.dp,bottomEnd=if(own) 8.dp else 12.dp),
                        color=if(own) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface,
                        contentColor=if(own) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                        modifier=Modifier.widthIn(max=320.dp)) {
                        Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(4.dp)) {
                            if(message.optString("sender")=="moderator") Text("Moderación",style=MaterialTheme.typography.labelSmall)
                            if (message.optString("image").let { it.isNotBlank() && it != "null" }) ChatImageBubble(settings,target,message.optString("id"),foreground) { error = it }
                            Text(message.optString("message"),style=MaterialTheme.typography.bodyMedium)
                            if(message.has("createdAt")) Text(dateLabel(message.optString("createdAt")),style=MaterialTheme.typography.labelSmall,modifier=Modifier.align(Alignment.End),color=LocalContentColor.current.copy(alpha=.65f))
                        }
                    }
                }
            }
        }
        if(error.isNotBlank()&&!error.startsWith("Sin conexión")) Text(error,Modifier.padding(8.dp),color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall)
        if(uncertain) {
            Text("No se confirmó el último envío. Comprueba los mensajes antes de volver a enviarlo.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.error)
            TextButton(onClick={if(connected()) scope.launch { checkAttempt(); refreshVersion++ }}) { Text("Comprobar envío (sin reenviar)") }
        }
        if (preparing) LinearProgressIndicator(Modifier.fillMaxWidth())
        image?.let { bytes ->
            Row(Modifier.padding(8.dp),verticalAlignment=Alignment.CenterVertically) {
                val preview = remember(bytes) { runCatching { ChatImages.bitmap(bytes).asImageBitmap() }.getOrNull() }
                if (preview != null) Image(preview,"Imagen preparada para enviar",Modifier.size(72.dp))
                Text("JPEG · ${bytes.size / 1024} KiB",Modifier.weight(1f).padding(8.dp))
                TextButton(enabled=!sending&&!uncertain&&!preparing,onClick={
                    preparing=true
                    scope.launch {
                        try {
                            withContext(Dispatchers.IO) { ChatImages.remove(context,settings,pendingImageKey) }
                            image=null;attemptId=""
                        } finally {preparing=false}
                    }
                }) { Text("Quitar") }
            }
        }
        if (sending) {
            LinearProgressIndicator(progress={progress / 100f},modifier=Modifier.fillMaxWidth())
            Text(if(progress<100) "Subiendo al servidor · $progress%" else "Esperando confirmación de QvaPay…",style=MaterialTheme.typography.labelSmall)
        }
        Surface(color=MaterialTheme.colorScheme.surface) {
        Row(Modifier.fillMaxWidth().padding(8.dp),verticalAlignment=Alignment.Bottom,horizontalArrangement=Arrangement.spacedBy(8.dp)) {
        FilledTonalIconButton(enabled=!sending&&!uncertain&&!preparing,onClick={picker.launch("image/*")},
            modifier=Modifier.size(48.dp),shape=CircleShape) { PrecisoIcon("image",description="Adjuntar imagen") }
        ChatDraftInput(draft,{if(it.length<=599) {draft=it;attemptId=""}},!sending&&!uncertain,Modifier.weight(1f))
        FilledIconButton(onClick={
            if(sending||uncertain||preparing||(draft.isBlank()&&image==null)) return@FilledIconButton
            if(!connected()) return@FilledIconButton
            if(attemptId.isBlank()) attemptId=UUID.randomUUID().toString()
            settings.saveCachedResponse("chat_draft:${target.id}",JSONObject().put("draft",draft).put("attemptId",attemptId).put("savedAt",System.currentTimeMillis()))
            if(!settings.markActionUncertain(target.id,"chat")) {error="No se pudo guardar el envío de forma segura.";return@FilledIconButton}
            val outgoing=draft.trim()
            val outgoingImage=image
            val outgoingId=attemptId
            sending=true
            progress=0
            scope.launch {
                val response=withContext(Dispatchers.IO) {
                    if(outgoingImage!=null) MobileApi.sendChatImage(settings.serverUrl,settings.operatorToken,chatPath(target,"/images"),outgoingImage,outgoing,outgoingId) { value -> scope.launch { progress=value } }
                    else MobileApi.post(settings.serverUrl,settings.operatorToken,chatPath(target),JSONObject().put("message",outgoing).put("attemptId",outgoingId))
                }
                uncertain=response.uncertain
                if(!uncertain) settings.clearActionUncertain(target.id,"chat")
                if(response.value!=null) {
                    val sentId=response.value.optJSONObject("data")?.optString("id").orEmpty()
                    if(outgoingImage!=null && sentId.isNotBlank()) withContext(Dispatchers.IO) { runCatching { ChatImages.save(context,settings,"${target.id}:$sentId",outgoingImage) } }
                    draft="";image=null;attemptId="";error=""
                    withContext(Dispatchers.IO) { ChatImages.remove(context,settings,pendingImageKey) }
                    chat=response.value.optJSONObject("data")?.optJSONObject("chat");refreshVersion++
                }
                else error=response.message
                sending=false
            }
        },enabled=!sending&&!uncertain&&!preparing&&(draft.isNotBlank()||image!=null),modifier=Modifier.size(48.dp),shape=CircleShape) {
            if(sending) CircularProgressIndicator(Modifier.size(24.dp),strokeWidth=2.dp,color=MaterialTheme.colorScheme.onPrimary)
            else PrecisoIcon("send",description="Enviar mensaje")
        }
        }
        }
        if(draft.length>=550) Text("${draft.length}/599",Modifier.fillMaxWidth().padding(horizontal=16.dp),style=MaterialTheme.typography.labelSmall)
        SnackbarHost(snackbar)
    }
}

/** Shares the buttons' 48 dp minimum height and round ends; grows only for multiline text. */
@Composable
internal fun ChatDraftInput(value: String, onValueChange: (String)->Unit, enabled: Boolean, modifier: Modifier = Modifier) {
    val shape=RoundedCornerShape(24.dp)
    BasicTextField(value,onValueChange,enabled=enabled,maxLines=4,
        textStyle=MaterialTheme.typography.bodyLarge.copy(color=MaterialTheme.colorScheme.onSurface),
        cursorBrush=SolidColor(MaterialTheme.colorScheme.primary),
        modifier=modifier.heightIn(min=48.dp).clip(shape)
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .border(1.dp,MaterialTheme.colorScheme.outlineVariant,shape)
            .padding(horizontal=16.dp,vertical=12.dp).semantics {contentDescription="Mensaje"},
        decorationBox={inner->
            Box(contentAlignment=Alignment.CenterStart) {
                if(value.isEmpty()) Text("Escribe un mensaje…",style=MaterialTheme.typography.bodyLarge,color=MaterialTheme.colorScheme.onSurfaceVariant,maxLines=1)
                inner()
            }
        })
}

@Composable
private fun ChatImageBubble(settings: SecureSettings, target: ChatTarget, messageId: String, foreground: Boolean, onError: (String) -> Unit) {
    val context = LocalContext.current
    var bitmap by remember(messageId) { mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(false) }
    LaunchedEffect(messageId,foreground,retry) {
        loading=true
        try {
            val key="${target.id}:$messageId"
            val cached=withContext(Dispatchers.IO) {ChatImages.read(context,settings,key)}
            if(cached!=null) bitmap=withContext(Dispatchers.IO) {runCatching {ChatImages.bitmap(cached).asImageBitmap()}.getOrNull()}
            if(bitmap==null && foreground && networkAvailable(context)) {
                val response=withContext(Dispatchers.IO) {MobileApi.chatImage(settings.serverUrl,settings.operatorToken,chatPath(target,"/images/${Uri.encode(messageId)}"))}
                response.value?.let {bytes->
                    bitmap=withContext(Dispatchers.IO) {
                        runCatching {ChatImages.bitmap(bytes).asImageBitmap().also {ChatImages.save(context,settings,key,bytes)}}.getOrNull()
                    }
                }
                if(retry>0&&response.message.startsWith("Sin conexión")) onError("Sin conexión")
            }
        } finally {loading=false}
    }
    val rendered=bitmap
    if(rendered!=null) Image(rendered,"Imagen adjunta",Modifier.fillMaxWidth().heightIn(max=300.dp))
    else Column(verticalArrangement=Arrangement.spacedBy(4.dp)) {
        PrecisoIcon("receipt",description=null)
        if(loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        Text(if(loading) "Cargando imagen…" else "Sin copia local de la imagen. Descarga fallida o referencia aún no verificada.",style=MaterialTheme.typography.bodySmall)
        TextButton(enabled=!loading&&foreground,onClick={if(networkAvailable(context)) retry++ else onError("Sin conexión")}) {Text("Reintentar descarga")}
    }
}
