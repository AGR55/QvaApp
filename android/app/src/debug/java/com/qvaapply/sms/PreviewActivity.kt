package com.qvaapply.sms

import android.os.Bundle
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
        val prefs=SecureSettings(this,"preview_settings")
        val now=System.currentTimeMillis()
        val overview=JSONObject("""{"balance":142.85,"balanceUpdatedAt":$now,"paused":false,"hunting":{"buyRunning":true,"sellRunning":true},"markets":[{"code":"CLASICA","label":"Clásica","currency":"USD","fiat":87.4,"active":true,"buyMaxRate":1.08,"sellMinRate":1.12,"huntBuyEnabled":true,"huntSellEnabled":true},{"code":"BANK_CUP","label":"CUP","currency":"CUP","fiat":15320,"active":true,"buyMaxRate":410,"sellMinRate":435,"huntBuyEnabled":true,"huntSellEnabled":true}]}""")
        for(tool in listOf("Capital","Cacerías")) prefs.saveCachedResponse("tool:$tool:CLASICA:1:30",JSONObject().put("data",overview).put("savedAt",now))
        prefs.saveCachedResponse("tool:Salud:CLASICA:1:30",JSONObject().put("data",JSONObject("""{"checks":[{"key":"feed","label":"Datos del mercado","status":"ok","detail":"Se reciben datos del mercado."},{"key":"median:CLASICA","label":"Medianas · Clásica","status":"ok","detail":"Última observación hace 2 minutos."},{"key":"latency","label":"Respuesta de QvaPay","status":"idle","detail":"Sin aplicaciones recientes para medir."}]}""")).put("savedAt",now))
        val ops=listOf(
            MobileOperation("a112bcde-1111-2222-3333-444444444444","sell","Clásica","USD","25","27.25","1.09","applied",now.toString(),listOf("paid","cancel")),
            MobileOperation("b223cdef-1111-2222-3333-444444444444","buy","CUP","CUP","8.5","3655","430","paid",now.toString(),listOf("received")),
            MobileOperation("c334defa-1111-2222-3333-444444444444","sell","ETECSA","CUP","5","2050","410","acknowledged",now.toString(),listOf("paid","cancel")),
        )
        val alerts=listOf(MobileAlert("a1","operation-applied","Tu compra de 25 QUSD en Clásica está lista para gestionar. Revisa los detalles y registra el pago cuando lo hayas enviado.",now.toString(),ops[0].uuid),MobileAlert("a2","informational-summary","Se completaron 2 reajustes de capital. Consulta tus ofertas para ver la distribución actual.",now.toString(),null))
        setContent {
            var mode by remember {mutableStateOf(intent.getStringExtra("theme")?:"light")}
            var screen by remember {mutableStateOf(when(intent.getStringExtra("screen")){"operations"->Destination.Operations;"alerts"->Destination.Alerts;"settings"->Destination.Settings;"tools"->Destination.Tools;else->Destination.Home})}
            PrecisoTheme(mode) {
                Scaffold(bottomBar={PrecisoNavigation(screen){screen=it}}) {padding->
                    Column(Modifier.fillMaxSize().padding(padding)) {
                        Text("VISTA PREVIA · DATOS DE EJEMPLO",Modifier.padding(16.dp),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.primary)
                        when(screen) {
                            Destination.Home->HomeScreen(ops,alerts,overview,false,{screen=Destination.Operations},{screen=Destination.Tools},{screen=Destination.Settings},true,{},false)
                            Destination.Operations->OperationsScreen(ops,prefs,false,false,"",{}, {_,_->})
                            Destination.Alerts->AlertsScreen(alerts,emptyList(),false,{})
                            Destination.Settings->SettingsScreen(prefs,this@PreviewActivity,mode,{mode=it},false,{}, {})
                            Destination.Tools->ToolsScreen(prefs,overview,false,0)
                        }
                    }
                }
            }
        }
    }
}
