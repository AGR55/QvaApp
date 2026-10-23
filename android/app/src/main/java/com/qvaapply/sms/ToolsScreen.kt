package com.qvaapply.sms

import android.net.Uri
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

private val toolNames=listOf("Capital","Cacerías","Salud","Rentabilidad","Historial","Diagnóstico","Simular")

@Composable
internal fun ToolsScreen(settings: SecureSettings, overview: JSONObject?, overviewStale: Boolean, bindingVersion: Int) {
    var tool by rememberSaveable { mutableStateOf("Capital") }
    val markets=remember(overview) { objects(overview?.optJSONArray("markets")) }
    var coin by rememberSaveable { mutableStateOf(markets.firstOrNull()?.optString("code").orEmpty()) }
    var page by remember { mutableIntStateOf(1) }
    var days by rememberSaveable { mutableIntStateOf(30) }
    var reload by remember { mutableIntStateOf(0) }
    var report by remember { mutableStateOf<JSONObject?>(null) }
    var cachedAt by remember { mutableLongStateOf(0L) }
    var stale by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var simulation by remember { mutableStateOf<JSONObject?>(null) }
    var requestVersion by remember { mutableIntStateOf(0) }
    val market=markets.firstOrNull { it.optString("code")==coin }
    var buy by remember(coin) { mutableStateOf(market?.optString("buyMaxRate").orEmpty()) }
    var sell by remember(coin) { mutableStateOf(market?.optString("sellMinRate").orEmpty()) }
    var maximum by rememberSaveable { mutableStateOf("25") }
    var hours by rememberSaveable { mutableIntStateOf(24) }
    val scope=rememberCoroutineScope()
    val key="tool:$tool:$coin:$page:$days"
    LaunchedEffect(markets) { if(markets.none {it.optString("code")==coin}) coin=markets.firstOrNull()?.optString("code").orEmpty() }
    LaunchedEffect(tool,coin) { simulation=null }
    LaunchedEffect(tool,coin,page,days,reload,bindingVersion) {
        requestVersion++
        val version=requestVersion
        error="";busy=false
        val cached=settings.cachedResponse(key)
        report=cached?.optJSONObject("data"); cachedAt=cached?.optLong("savedAt")?:0;stale=true
        if(tool=="Simular") { report=null;return@LaunchedEffect }
        if(settings.operatorToken.isBlank()) {error="Vincula primero tu token de operador en Ajustes.";return@LaunchedEffect}
        if(tool in listOf("Historial","Diagnóstico") && coin.isBlank()) {error="Todavía no hay mercados guardados. Actualiza Inicio.";return@LaunchedEffect}
        val path=when(tool) {
            "Capital","Cacerías" -> "/api/mobile/overview"
            "Salud" -> "/api/mobile/insights?kind=health"
            "Rentabilidad" -> "/api/mobile/insights?kind=profitability&days=$days"
            "Historial" -> "/api/mobile/insights?kind=history&coin=${Uri.encode(coin)}&page=$page"
            else -> "/api/mobile/insights?kind=diagnostics&coin=${Uri.encode(coin)}"
        }
        busy=true
        try {
            val response=withContext(Dispatchers.IO) {MobileApi.get(settings.serverUrl,settings.operatorToken,path)}
            val value=response.value
            if(version!=requestVersion) return@LaunchedEffect
            if(value!=null && value.has("data")) {
                report=value.optJSONObject("data");cachedAt=System.currentTimeMillis();stale=false
                settings.saveCachedResponse(key,JSONObject().put("data",report?:JSONObject.NULL).put("savedAt",cachedAt))
            } else error=response.message
        } catch(cancelled: CancellationException) {throw cancelled}
        finally {if(version==requestVersion) busy=false}
    }
    val needsMarket=tool in listOf("Historial","Diagnóstico","Simular")
    LazyColumn(contentPadding=PaddingValues(22.dp),verticalArrangement=Arrangement.spacedBy(16.dp)) {
        item { SectionHeading("Observa. Comprende. Decide.","Herramientas","Capital, rendimiento y precios, en un solo lugar.") }
        item { Row(Modifier.horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            toolNames.forEach { name -> FilterChip(selected=tool==name,onClick={tool=name;page=1},label={Text(name)}) }
        } }
        if(needsMarket) item { Row(Modifier.horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            markets.forEach { m -> FilterChip(selected=coin==m.optString("code"),onClick={coin=m.optString("code");page=1},label={Text(m.optString("label"))}) }
        } }
        if(tool=="Rentabilidad") item { Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {listOf(7,30,90).forEach {d-> FilterChip(selected=days==d,onClick={days=d},label={Text("$d días")}) }} }
        if(tool!="Simular") item {
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
                Text(if(busy) "Consultando…" else if(stale) "Datos guardados · sin verificar" else "Consultado ${dateLabel(cachedAt.toString())}",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant,modifier=Modifier.weight(1f))
                TextButton(enabled=!busy,onClick={reload++}) {Text("Actualizar")}
            }
        }
        if(busy) item {LinearProgressIndicator(Modifier.fillMaxWidth())}
        if(error.isNotBlank()) item {Text(error,color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodyMedium)}
        when(tool) {
            "Capital" -> {
                item {PrecisoPanel {
                    Text("QUSD disponibles",style=MaterialTheme.typography.titleMedium)
                    Text(if(report==null||report!!.isNull("balance")) "Sin dato" else money(report!!.optString("balance")),style=MaterialTheme.typography.displaySmall)
                    Text("Saldo informado: ${dateLabel(report?.optString("balanceUpdatedAt").orEmpty())}",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                }}
                items(objects(report?.optJSONArray("markets")),key={it.optString("code")}) { m -> PrecisoPanel {
                    Text(m.optString("label"),style=MaterialTheme.typography.titleMedium)
                    Text("${money(m.optString("fiat"))} ${m.optString("currency")}",style=MaterialTheme.typography.headlineMedium)
                    Text("Saldo fiat registrado · no es una consulta a tu banco",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                } }
            }
            "Cacerías" -> {
                item {PrecisoPanel {
                    Text("Estado del motor",style=MaterialTheme.typography.titleMedium)
                    Text(if(report==null) "Sin verificar" else if(report!!.optBoolean("paused")) "Pausado" else "En ejecución",style=MaterialTheme.typography.headlineMedium)
                    val hunting=report?.optJSONObject("hunting")
                    DetailRow("Compras",if(hunting==null) "Sin dato" else if(hunting.optBoolean("buyRunning")) "Activas" else "Detenidas")
                    DetailRow("Ventas",if(hunting==null) "Sin dato" else if(hunting.optBoolean("sellRunning")) "Activas" else "Detenidas")
                    Text("Vista de lectura. Los límites se gestionan desde la web o Telegram.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                }}
                items(objects(report?.optJSONArray("markets")),key={it.optString("code")}) { m ->PrecisoPanel {
                    Text(m.optString("label"),style=MaterialTheme.typography.titleMedium)
                    DetailRow("Máximo de compra",money(m.optString("buyMaxRate")))
                    DetailRow("Mínimo de venta",money(m.optString("sellMinRate")))
                    Text(if(!m.optBoolean("active")) "Mercado desactivado" else "Compras: ${if(m.optBoolean("huntBuyEnabled")) "habilitadas" else "deshabilitadas"} · Ventas: ${if(m.optBoolean("huntSellEnabled")) "habilitadas" else "deshabilitadas"}",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                }}
            }
            "Salud" -> {
                val checks=objects(report?.optJSONArray("checks"))
                if(checks.isEmpty()&&!busy) item {EmptyState("Esperando comprobaciones","El monitor publica su estado periódicamente.")}
                items(checks,key={it.optString("key")}) { check ->PrecisoPanel {
                    Text(check.optString("label"),style=MaterialTheme.typography.titleMedium)
                    StatusPill(when(check.optString("status")){"ok"->"Correcto";"warning"->"Necesita atención";else->"Sin actividad suficiente"},check.optString("status")=="warning")
                    Text(check.optString("detail"),style=MaterialTheme.typography.bodyMedium)
                }}
            }
            "Rentabilidad" -> {
                val currencies=objects(report?.optJSONArray("currencies"))
                if(currencies.isEmpty()&&!busy) item {EmptyState("Sin resultados para este período","La rentabilidad se calcula sobre operaciones cerradas y costes identificables.")}
                items(currencies,key={it.optString("currency")}) { row ->PrecisoPanel {
                    Text(row.optString("currency"),style=MaterialTheme.typography.titleLarge)
                    Text("Resultado documentado",style=MaterialTheme.typography.labelMedium)
                    Text(if(row.optDouble("documentedMatchedQusd",0.0)>0) money(row.optString("documentedProfit")) else "Sin evidencia suficiente",style=MaterialTheme.typography.headlineMedium)
                    DetailRow("Parte estimada",money((row.optDouble("profit",0.0)-row.optDouble("documentedProfit",0.0)).toString()))
                    DetailRow("QUSD documentados",money(row.optString("documentedMatchedQusd")))
                }}
                item {Text("FIFO por mercado. La parte documentada exige costes, cobros y comisiones respaldados. Registra la evidencia de comisiones en Gráficas de la web. El historial puede estar incompleto.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)}
                if(report!=null) item {Text(report!!.optString("note"),style=MaterialTheme.typography.bodySmall,color=if(report!!.optBoolean("limited")) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)}
                if(report!=null) item {Text("Calculado: ${dateLabel(report!!.optString("generatedAt"))}",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)}
                val unmatched=report?.optJSONObject("coverage")?.optDouble("unmatchedSoldQusd",0.0)?:0.0
                if(unmatched>0) item {Text("${money(unmatched.toString())} QUSD vendidos sin coste identificable: no se cuentan como beneficio.",style=MaterialTheme.typography.bodySmall)}
            }
            "Historial" -> {
                val movements=objects(report?.optJSONArray("items"))
                if(movements.isEmpty()&&!busy) item {EmptyState("Sin movimientos","No hay movimientos registrados para esta página.")}
                items(movements,key={it.optString("id")}) { movement ->PrecisoPanel {
                    val value=movement.optDouble("amount",0.0)
                    Text("${if(value>=0) "+" else ""}${money(value.toString())} ${market?.optString("currency").orEmpty()}",style=MaterialTheme.typography.headlineMedium)
                    DetailRow("Antes",if(movement.isNull("before")) "Sin registro" else money(movement.optString("before")))
                    DetailRow("Después",if(movement.isNull("after")) "Sin registro" else money(movement.optString("after")))
                    Text(movement.optString("source"),style=MaterialTheme.typography.bodyMedium)
                    Text(dateLabel(movement.optString("createdAt")),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                    if(movement.optString("kind")=="historical") Text("Histórico ya incluido en el saldo; sin nuevo descuento.",style=MaterialTheme.typography.bodySmall)
                }}
                item {Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
                    TextButton(onClick={page--},enabled=page>1&&!busy) {Text("Anterior")};Text("Página $page",style=MaterialTheme.typography.labelLarge)
                    TextButton(onClick={page++},enabled=report?.optBoolean("hasMore")==true&&!busy&&page<1000) {Text("Siguiente")}
                }}
            }
            "Diagnóstico" -> {
                item {PrecisoPanel {
                    Text("Últimas 24 horas",style=MaterialTheme.typography.titleMedium)
                    DetailRow("Observaciones",report?.optString("observations")?:"Sin dato")
                    DetailRow("Ofertas distintas",report?.optString("uniqueOffers")?:"Sin dato")
                    val applications=report?.optJSONObject("applications")
                    listOf("sent" to "Aplicaciones enviadas","confirmed" to "Confirmadas","rejected" to "Rechazadas","uncertain" to "Resultado incierto","notSent" to "Sin enviar").forEach { (key,label) -> DetailRow(label,applications?.optString(key)?:"Sin dato") }
                }}
                items(objects(report?.optJSONArray("reasons")),key={it.optString("label")}) {reason ->PrecisoPanel {DetailRow(reason.optString("label"),reason.optString("count"))}}
                if(report!=null) item {Text(report!!.optString("note"),style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)}
                if(report?.optBoolean("truncated")==true) item {Text("Muestra limitada a 5.000 registros.",style=MaterialTheme.typography.bodySmall)}
            }
            "Simular" -> {
                item {PrecisoPanel {
                    Text("Explora otros límites",style=MaterialTheme.typography.titleLarge)
                    Text("Compara precios sin cambiar tu estrategia ni aplicar a ofertas.",style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)
                    if(overviewStale) Text("Los límites iniciales proceden de datos guardados.",style=MaterialTheme.typography.bodySmall)
                    OutlinedTextField(buy,{buy=it;simulation=null},Modifier.fillMaxWidth(),label={Text("Máximo de compra")},keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Decimal),singleLine=true)
                    OutlinedTextField(sell,{sell=it;simulation=null},Modifier.fillMaxWidth(),label={Text("Mínimo de venta")},keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Decimal),singleLine=true)
                    OutlinedTextField(maximum,{maximum=it;simulation=null},Modifier.fillMaxWidth(),label={Text("Máximo QUSD por oferta")},keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Decimal),singleLine=true)
                    Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {listOf(1,24,168).forEach {h->FilterChip(selected=hours==h,onClick={hours=h;simulation=null},label={Text(if(h==168) "7 días" else "$h h")})}}
                    Button(enabled=!busy&&coin.isNotBlank()&&settings.operatorToken.isNotBlank(),modifier=Modifier.fillMaxWidth(),onClick={
                        fun positive(value:String)=value.replace(',','.').toDoubleOrNull()?.takeIf {it.isFinite()&&it>0&&it<=1e9}
                        val b=positive(buy);val s=positive(sell);val m=positive(maximum)
                        if(b==null||s==null||m==null) error="Introduce tasas e importe positivos y válidos."
                        else {
                            error="";busy=true
                            requestVersion++
                            val version=requestVersion
                            val requestedCoin=coin
                            val requestedBuy=buy
                            val requestedSell=sell
                            val requestedMaximum=maximum
                            val requestedHours=hours
                            scope.launch {
                                try {
                                    val response=withContext(Dispatchers.IO) {MobileApi.simulate(settings.serverUrl,settings.operatorToken,JSONObject().put("coin",requestedCoin).put("hours",requestedHours).put("buyMaxRate",b).put("sellMinRate",s).put("maxQusd",m))}
                                    if(version==requestVersion&&tool=="Simular"&&coin==requestedCoin&&buy==requestedBuy&&sell==requestedSell&&maximum==requestedMaximum&&hours==requestedHours) {
                                        simulation=response.value?.optJSONObject("data")
                                        if(simulation==null) error=response.message
                                    }
                                } finally {if(version==requestVersion) busy=false}
                            }
                        }
                    }) {Text(if(busy) "Calculando…" else "Comparar precios")}
                }}
                simulation?.let { sim -> item {PrecisoPanel {
                    Text("Actuales → propuestos",style=MaterialTheme.typography.titleMedium)
                    val base=sim.optJSONObject("baseline");val proposed=sim.optJSONObject("proposed")
                    DetailRow("Compras", "${base?.optInt("buy")?:0} → ${proposed?.optInt("buy")?:0}")
                    DetailRow("Ventas", "${base?.optInt("sell")?:0} → ${proposed?.optInt("sell")?:0}")
                    Text("${sim.optInt("uniqueOffers")} ofertas distintas en la muestra.",style=MaterialTheme.typography.bodyMedium)
                    if(sim.optBoolean("truncated")) Text("Muestra limitada a 5.000 observaciones.",style=MaterialTheme.typography.bodySmall)
                    Text(sim.optString("note"),style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                }} }
            }
        }
    }
}

internal fun objects(array: JSONArray?): List<JSONObject> = if(array==null) emptyList() else (0 until array.length()).mapNotNull {array.optJSONObject(it)}
