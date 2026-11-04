package com.qvaapply.sms

import android.app.KeyguardManager
import android.content.Intent
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.UUID

@Composable
internal fun AssistedPaymentDialog(operation: MobileOperation, settings: SecureSettings, onDismiss: ()->Unit, demo: AssistedPayment? = null) {
    val context=LocalContext.current
    val activity=context as? ComponentActivity
    val scope=rememberCoroutineScope()
    var plan by remember {mutableStateOf<AssistedPayment?>(null)}
    var source by remember {mutableStateOf<PaymentSource?>(null)}
    var busy by remember {mutableStateOf(false)}
    var message by remember {mutableStateOf("")}
    var enabled by remember {mutableStateOf(PaymentFormService.enabled(context))}
    var supported by remember {mutableStateOf(PaymentFormService.supported(context))}
    var handed by remember {mutableStateOf(settings.actionIsUncertain(operation.id,"payment_form"))}
    var authPurpose by remember {mutableStateOf<String?>(null)}
    var demoForm by remember {mutableStateOf(false)}
    var unlocking by remember {mutableStateOf(false)}
    suspend fun fetch(): ApiResponse<AssistedPayment> = if(demo!=null) ApiResponse(demo.copy(checkedAt=System.currentTimeMillis(),expiresAt=System.currentTimeMillis()+120_000),"")
        else if(!networkAvailable(context)) ApiResponse(null,"Sin conexión. No se preparará el pago con datos guardados.")
        else withContext(Dispatchers.IO) {MobileApi.preparePayment(settings.serverUrl,settings.operatorToken,operation)}
    fun refresh() { scope.launch {
        busy=true
        try {val result=fetch();plan=result.value;message=result.message;source=source?.takeIf {it in result.value?.sources.orEmpty()} ?: result.value?.sources?.singleOrNull()}
        finally {busy=false}
    } }
    DisposableEffect(activity) {
        val observer=LifecycleEventObserver {_,event->if(event==Lifecycle.Event.ON_RESUME) {
            enabled=PaymentFormService.enabled(context);supported=PaymentFormService.supported(context)
        }}
        activity?.lifecycle?.addObserver(observer)
        val secureFlag=android.view.WindowManager.LayoutParams.FLAG_SECURE
        val wasSecure=(activity?.window?.attributes?.flags ?: 0) and secureFlag != 0
        if(demo==null) activity?.window?.addFlags(secureFlag)
        onDispose {activity?.lifecycle?.removeObserver(observer);if(demo==null && !wasSecure) activity?.window?.clearFlags(secureFlag)}
    }
    LaunchedEffect(operation.id) {refresh()}
    fun dispatch(fresh: AssistedPayment) {
        val selected=source?.takeIf {it in fresh.sources} ?: return
        if(demo!=null) {demoForm=true;return}
        if(!PaymentFormService.enabled(context) || !PaymentFormService.supported(context)) {message="Activa el asistente y comprueba la versión de Transfermóvil.";return}
        if(settings.pendingPaymentForm()!=null) {message="Ya existe un formulario en preparación. Revísalo antes de preparar otro.";return}
        val intent=context.packageManager.getLaunchIntentForPackage(TRANSFERMOVIL_PACKAGE)
        if(intent==null) {message="No se puede abrir Transfermóvil.";return}
        if(!settings.markActionUncertain(operation.id,"payment_form")) {message="No se pudo guardar el intento. No se abrió Transfermóvil.";return}
        val request=JSONObject().put("id",UUID.randomUUID().toString()).put("source",selected.name).put("plan",fresh.toJson())
        if(!settings.savePaymentForm(request)) {message="No se pudo guardar la preparación. Revisa el estado local antes de repetirla.";handed=true;return}
        handed=true
        runCatching {context.startActivity(intent)}.onFailure {
            settings.clearPaymentForm();settings.clearActionUncertain(operation.id,"payment_form");handed=false
            message="No se pudo abrir Transfermóvil. No se envió ninguna solicitud de pago."
        }
    }
    val credentials=rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {result->
        val purpose=authPurpose;authPurpose=null
        if(!DeviceCredentialAuth.confirmed(result.resultCode)) {message="Autorización cancelada. No se preparó ningún formulario.";return@rememberLauncherForActivityResult}
        if(purpose=="unlock") {
            val pending=settings.pendingPaymentForm()
            if(pending?.optJSONObject("plan")?.optString("uuid")==operation.uuid &&
                pending.optJSONObject("plan")?.optString("orderUuid").let {it==operation.orderUuid || operation.orderUuid==null && it=="null"}) settings.clearPaymentForm()
            settings.clearActionUncertain(operation.id,"payment_form");handed=false;unlocking=false;refresh()
        } else if(purpose=="handoff") scope.launch {
            busy=true
            try {
                val reviewed=plan
                val response=fetch();val fresh=response.value
                if(fresh==null) {plan=null;message=response.message}
                else if(reviewed?.fingerprint!=fresh.fingerprint) {plan=fresh;message="El destino o importe cambió. Revisa de nuevo antes de continuar."}
                else {plan=fresh;dispatch(fresh)}
            } finally {busy=false}
        }
    }
    fun authorize(purpose: String) {
        if(demo!=null) {plan?.let(::dispatch);return}
        val keyguard=context.getSystemService(KeyguardManager::class.java)
        if(!keyguard.isDeviceSecure) {message="Configura el bloqueo de pantalla de Android para autorizar la preparación.";return}
        val intent=keyguard.createConfirmDeviceCredentialIntent("Autorizar preparación de pago","Confirma tu identidad. El asistente no aceptará la transferencia.")
        if(intent==null) {message="No se pudo abrir la confirmación de Android.";return}
        authPurpose=purpose
        runCatching {credentials.launch(intent)}.onFailure {authPurpose=null;message="No se pudo abrir la autorización de Android."}
    }
    AlertDialog(onDismissRequest={if(!busy) onDismiss()},properties=DialogProperties(securePolicy=if(demo==null) SecureFlagPolicy.SecureOn else SecureFlagPolicy.Inherit),title={Text(if(demoForm) "Formulario de prueba" else "Realizar pago")},
        text={Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            if(demo!=null) Text("DEMOSTRACIÓN · Sin acceso al teléfono ni a pagos reales",color=MaterialTheme.colorScheme.primary)
            if(busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            plan?.let {current->
                Text("${current.amount} ${current.currency}",style=MaterialTheme.typography.headlineSmall)
                Text(if(current.kind=="card") "Tarjeta publicada en la oferta" else "Móvil destinatario publicado")
                Text(current.destination,style=MaterialTheme.typography.titleMedium)
                Text("Móvil de confirmación: ${current.confirmationPhone ?: if(current.kind=="phone") "el destinatario" else "no publicado"}")
                Text("Oferta ${current.uuid.take(8)}${current.orderUuid?.let {" · orden ${it.take(8)}"}.orEmpty()}",style=MaterialTheme.typography.bodySmall)
                if(!demoForm) {
                    Text("Banco de origen",style=MaterialTheme.typography.titleSmall)
                    Row(Modifier.horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                        current.sources.forEach {bank->FilterChip(selected=source==bank,onClick={source=bank},enabled=!busy&&!handed,label={Text(bank.label)})}
                    }
                    Text("Desconecta cualquier otro banco y autentícate en el banco de origen en Transfermóvil. La desconexión se completa al terminar su USSD; el SMS de autenticación puede llegar después.")
                    Text(if(demo==null && !BuildConfig.PAYMENT_FORM_ENABLED) "Puedes revisar estos datos y realizar el pago manualmente en Transfermóvil. El rellenado asistido sigue en pruebas y no está activado en esta versión."
                        else if(current.market=="ETECSA") "El asistente rellena los datos y se detiene antes de ACEPTAR. La clave y la confirmación quedan en ETECSA."
                        else "El asistente rellena los datos y puede abrir la primera revisión de Transfermóvil. Se detiene allí: tú confirmas o cancelas. Revisa también la cuenta de origen y la moneda.")
                    Text("Abrir el formulario o su revisión no marca pagada la operación.")
                } else Text("Datos rellenados en el formulario ficticio. En Transfermóvil quedarían pendientes la cuenta de origen, la revisión y tu confirmación final.")
            }
            if(message.isNotBlank()) Text(message,color=MaterialTheme.colorScheme.error)
            if(handed) {
                Text("Hay una preparación anterior. Comprueba Transfermóvil y el comprobante antes de repetirla.",color=MaterialTheme.colorScheme.error)
                TextButton(onClick={unlocking=true},enabled=!busy) {Text("Ya comprobé que no se realizó el pago")}
            } else if(demo==null && BuildConfig.PAYMENT_FORM_ENABLED) {
                if(!supported) Text("Se requiere Transfermóvil $TRANSFERMOVIL_SUPPORTED_VERSION para el rellenado verificado.",style=MaterialTheme.typography.bodySmall)
                if(!enabled) OutlinedButton(onClick={context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))},modifier=Modifier.fillMaxWidth()) {Text("Activar asistente de Transfermóvil")}
            }
            TextButton(onClick={refresh()},enabled=!busy) {Text("Volver a comprobar la oferta")}
        }},
        confirmButton={if(demo!=null || BuildConfig.PAYMENT_FORM_ENABLED) TextButton(onClick={authorize("handoff")},enabled=plan!=null&&source!=null&&!busy&&!handed&&!demoForm&&(demo!=null||enabled&&supported)) {Text(if(demo!=null) "Simular rellenado" else "Rellenar Transfermóvil")}},
        dismissButton={TextButton(onClick=onDismiss,enabled=!busy) {Text("Cerrar")}})
    if(unlocking) AlertDialog(onDismissRequest={unlocking=false},title={Text("Revisar preparación anterior")},
        text={Text("Continúa solo si verificaste que no se confirmó la transferencia ni existe un débito o comprobante pendiente. La ausencia del SMS no demuestra que el pago no se hizo.")},
        confirmButton={TextButton(onClick={authorize("unlock")}) {Text("Confirmar con Android")}},
        dismissButton={TextButton(onClick={unlocking=false}) {Text("Volver")}})
}
