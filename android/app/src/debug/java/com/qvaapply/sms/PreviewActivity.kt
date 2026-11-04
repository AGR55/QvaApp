package com.qvaapply.sms

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.json.JSONObject

/** Synthetic UI fixtures. This activity and its data never enter release builds. */
class PreviewActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val prefs=SecureSettings(this,"preview_settings")
        val now=System.currentTimeMillis()
        val overview=JSONObject("""{"balance":142.85,"balanceUpdatedAt":$now,"paused":false,"hunting":{"buyRunning":true,"sellRunning":true},"markets":[{"code":"CLASICA","label":"Clásica","currency":"USD","fiat":87.4,"active":true,"buyMaxRate":1.08,"sellMinRate":1.12,"huntBuyEnabled":true,"huntSellEnabled":true},{"code":"BANK_CUP","label":"CUP","currency":"CUP","fiat":15320,"active":true,"buyMaxRate":410,"sellMinRate":435,"huntBuyEnabled":true,"huntSellEnabled":true}]}""")
        for(tool in listOf("Capital","Cacerías")) prefs.saveCachedResponse("tool:$tool:CLASICA:1:30",JSONObject().put("data",overview).put("savedAt",now))
        prefs.saveCachedResponse("tool:Salud:CLASICA:1:30",JSONObject().put("data",JSONObject("""{"checks":[{"key":"feed","label":"Datos del mercado","status":"ok","detail":"Se reciben datos del mercado."},{"key":"median:CLASICA","label":"Medianas · Clásica","status":"ok","detail":"Última observación hace 2 minutos."},{"key":"latency","label":"Respuesta de QvaPay","status":"idle","detail":"Sin aplicaciones recientes para medir."}]}""")).put("savedAt",now))
        prefs.saveCachedResponse("chat_threads",JSONObject("""{"data":[{"id":"range-example:order-one","uuid":"range-example","orderUuid":"order-one","coin":"CLASICA","marketLabel":"Clásica","amount":25,"state":"paid","role":"creator","counterpartyLabel":"Marta","unreadCount":2},{"id":"range-example:order-two","uuid":"range-example","orderUuid":"order-two","coin":"CLASICA","marketLabel":"Clásica","amount":12,"state":"processing","role":"creator","counterpartyLabel":"Luis","unreadCount":0}]}"""))
        prefs.saveCachedResponse("chat:range-example:order-one",JSONObject("""{"data":{"stale":false,"messages":[{"id":"one","sender":"counterparty","message":"Hola, ya envié la transferencia. Te comparto la referencia en un momento.","createdAt":$now},{"id":"two","sender":"own","message":"Perfecto, reviso el ingreso y te confirmo por aquí.","createdAt":$now},{"id":"three","sender":"counterparty","message":"Listo. La referencia termina en 4821. Gracias.","createdAt":$now}]}}"""))
        val ops=listOf(
            MobileOperation("a112bcde-1111-2222-3333-444444444444","sell","Clásica","USD","25","27.25","1.09","applied",now.toString(),listOf("paid","cancel"),market="CLASICA",paymentAvailable=true),
            MobileOperation("b223cdef-1111-2222-3333-444444444444","buy","CUP","CUP","8.5","3655","430","paid",now.toString(),listOf("received")),
            MobileOperation("c334defa-1111-2222-3333-444444444444","sell","ETECSA","CUP","5","2050","410","acknowledged",now.toString(),listOf("paid","cancel"),market="ETECSA",paymentAvailable=true),
            MobileOperation("d445efab-1111-2222-3333-444444444444","sell","CUP","CUP","10","1000","100","applied",now.toString(),listOf("paid","cancel"),market="BANK_CUP",paymentAvailable=true),
        )
        val alerts=listOf(MobileAlert("a1","operation-applied","Tu compra de 25 QUSD en Clásica está lista para gestionar. Revisa los detalles y registra el pago cuando lo hayas enviado.",now.toString(),ops[0].uuid),MobileAlert("a2","informational-summary","Se completaron 2 reajustes de capital. Consulta tus ofertas para ver la distribución actual.",now.toString(),null))
        setContent {
            var mode by remember {mutableStateOf(intent.getStringExtra("theme")?:"light")}
            var screen by remember {mutableStateOf(when(intent.getStringExtra("screen")){"chats","conversation"->Destination.Chats;"operations"->Destination.Operations;"alerts"->Destination.Alerts;"settings"->Destination.Settings;"tools"->Destination.Tools;else->Destination.Home})}
            var chatTarget by remember {mutableStateOf(if(intent.getStringExtra("screen")=="conversation") ChatTarget("range-example","order-one") else null)}
            var search by remember {mutableStateOf("")}
            var payment by remember {mutableStateOf<MobileOperation?>(null)}
            PrecisoTheme(mode) {
                var detailOpen by remember {mutableStateOf(false)}
                val immersive=detailOpen || (screen==Destination.Chats&&chatTarget!=null)
                Scaffold(topBar={if(!immersive) {
                    NativeHeader(screen.title,false,false,alerts.size,{screen=Destination.Alerts},query=search,
                        onQueryChange={search=it;screen=Destination.Operations},onBack=if(screen==Destination.Alerts) {{screen=Destination.Home}} else null)
                }},bottomBar={if(!immersive&&screen!=Destination.Alerts) PrecisoNavigation(screen){screen=it}}) {padding->
                    Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
                        when(screen) {
                            Destination.Home->HomeScreen(ops,alerts,overview,false,{screen=Destination.Operations},{screen=Destination.Tools},{screen=Destination.Settings},true,{},false)
                            Destination.Operations->OperationsScreen(ops,prefs,false,false,"",{}, {_,_->},onChat={chatTarget=ChatTarget("range-example","order-one");screen=Destination.Chats},onDetailOpen={detailOpen=it},query=search,onPayment={payment=it})
                            Destination.Alerts->AlertsScreen(alerts,emptyList(),false,{})
                            Destination.Settings->SettingsScreen(prefs,this@PreviewActivity,mode,{mode=it},false,{}, {},onNotificationChange={prefs.notificationsEnabled=it})
                            Destination.Chats->ChatScreen(prefs,false,chatTarget,{chatTarget=it})
                            Destination.Tools->ToolsScreen(prefs,overview,false,0,onDetailOpen={detailOpen=it})
                        }
                    }
                }
                payment?.let {op->AssistedPaymentDialog(op,prefs,{payment=null},demo=AssistedPayment(op.uuid,op.orderUuid,op.market,op.receive,op.currency,
                    if(op.market=="ETECSA") "phone" else "card",if(op.market=="ETECSA") "51234567" else "9204123412345678",
                    if(op.market=="ETECSA") null else "51234567","a".repeat(64),now,now+120000))}
            }
        }
    }
}
