package com.qvaapply.sms

import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/** Debug-only laboratory. No production operation or payment adapter is reachable here. */
class PaymentLabActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { PrecisoTheme("system") { PaymentLabScreen() } }
    }
}

@Composable
private fun PaymentLabScreen() {
    val context=LocalContext.current
    var state by rememberSaveable { mutableStateOf(PaymentLabState()) }
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(state.session.requestId,state.session.phase) {
        while(state.sessionBusy) { now=SystemClock.elapsedRealtime();delay(250) }
    }
    val waiting=state.session.phase in listOf(LabSessionPhase.AUTHENTICATING,LabSessionPhase.DISCONNECTING)
    val elapsed=if(waiting) ((now-state.session.startedAt).coerceAtLeast(0)/1000) else 0
    Scaffold { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            Text("Laboratorio de pagos",style=MaterialTheme.typography.headlineSmall)
            Text("SIMULACIÓN · Sin llamadas, USSD ni movimientos reales",color=MaterialTheme.colorScheme.primary,style=MaterialTheme.typography.titleSmall)
            OutlinedButton(onClick={context.startActivity(android.content.Intent(context,PreviewActivity::class.java).putExtra("screen","operations"))},modifier=Modifier.fillMaxWidth()) {Text("Probar pago desde una operación")}
            Text("Operación ficticia · demo-${state.provider.name.lowercase()} · compra",style=MaterialTheme.typography.bodySmall)
            Row(Modifier.horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                LabProvider.entries.forEach { provider -> FilterChip(selected=state.provider==provider,
                    onClick={state=state.select(provider)},enabled=!state.locked && state.payment!=LabPaymentPhase.REVIEW,label={Text(provider.label)}) }
            }
            Text("Origen: ${state.provider.label} · cuenta de prueba",style=MaterialTheme.typography.titleMedium)
            OutlinedTextField(state.destination,{state=state.edit(destination=it)},label={Text("Destino ficticio")},
                supportingText={Text("Solo se admite ${state.provider.destination}")},modifier=Modifier.fillMaxWidth(),singleLine=true,
                enabled=!state.locked && state.payment !in listOf(LabPaymentPhase.REVIEW,LabPaymentPhase.SIMULATED),shape=UiShapes.large)
            OutlinedTextField(state.amount,{state=state.edit(amount=it)},label={Text("Importe ${state.provider.currency}")},
                modifier=Modifier.fillMaxWidth(),singleLine=true,enabled=!state.locked && state.payment !in listOf(LabPaymentPhase.REVIEW,LabPaymentPhase.SIMULATED),shape=UiShapes.large)
            if(!state.valid) Text("Destino de prueba o importe inválido. Usa hasta dos decimales con punto, mayor que cero y como máximo 100000.",color=MaterialTheme.colorScheme.error)
            HorizontalDivider()
            Text("Sesión: ${state.session.provider?.label ?: "ninguna"} · ${when(state.session.phase) {
                LabSessionPhase.NONE->"desconectada";LabSessionPhase.AUTHENTICATING->"autenticando";LabSessionPhase.CONNECTED->"autenticada"
                LabSessionPhase.DISCONNECTING->"desconectando";LabSessionPhase.UNKNOWN->"sin confirmar"
            }}",style=MaterialTheme.typography.titleSmall)
            Text("Solo puede haber un banco autenticado. Para cambiar, desconecta el anterior y espera su respuesta. No se solicitan claves reales.")
            if(state.provider==LabProvider.ETECSA) Text("ETECSA usa su propia clave de saldo; aquí se omite y no se envía ningún código.")
            if(waiting) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text("Esperando respuesta simulada · ${elapsed}s")
                Text(if(elapsed>=60) "La congestión puede superar un minuto. La espera no confirma éxito ni permite reenviar." else "La respuesta se puede simular desde los 5 segundos. Puedes dejarla esperando para probar congestión.")
                Button(onClick={state=state.sessionResponse(state.session.requestId,SystemClock.elapsedRealtime(),true)},enabled=elapsed>=5,modifier=Modifier.fillMaxWidth()) {Text("Simular respuesta correcta")}
                OutlinedButton(onClick={state=state.sessionResponse(state.session.requestId,SystemClock.elapsedRealtime(),false)},enabled=elapsed>=5,modifier=Modifier.fillMaxWidth()) {Text("Simular resultado incierto")}
            } else if(state.session.phase==LabSessionPhase.UNKNOWN) {
                Text("Bloqueado: primero hay que comprobar la sesión. No se reintenta automáticamente.",color=MaterialTheme.colorScheme.error)
                OutlinedButton(onClick={state=state.observeDisconnected()},modifier=Modifier.fillMaxWidth()) {Text("Simular comprobación: desconectado")}
            } else {
                if(state.provider.needsSession && state.session.phase==LabSessionPhase.NONE) Button(onClick={state=state.authenticate(SystemClock.elapsedRealtime())},enabled=!state.locked,modifier=Modifier.fillMaxWidth()) {Text("Simular autenticación")}
                if(state.session.phase==LabSessionPhase.CONNECTED) OutlinedButton(onClick={state=state.disconnect(SystemClock.elapsedRealtime())},enabled=!state.locked,modifier=Modifier.fillMaxWidth()) {Text("Simular desconexión de ${state.session.provider?.label}")}
                if(!state.sessionReady) Text("Falta autenticar ${state.provider.label}; desconecta primero cualquier banco anterior.",style=MaterialTheme.typography.bodySmall)
            }
            Button(onClick={state=state.prepare()},enabled=state.canPrepare,modifier=Modifier.fillMaxWidth()) {Text("Preparar pago de prueba")}
            when(state.payment) {
                LabPaymentPhase.SIMULATED -> Text("Pago simulado aceptado · intento ${state.attempt}. No se envió dinero ni se marcó pagada ninguna operación.",color=MaterialTheme.colorScheme.secondary)
                LabPaymentPhase.CANCELLED -> Text("Revisión cancelada. No se envió nada.")
                LabPaymentPhase.UNCERTAIN -> {
                    Text("Resultado simulado incierto. Reenvío bloqueado, incluso al cambiar de banco.",color=MaterialTheme.colorScheme.error)
                    OutlinedButton(onClick={state=state.reconcileSyntheticReceipt()},modifier=Modifier.fillMaxWidth()) {Text("Simular comprobante coincidente")}
                }
                else -> Unit
            }
            if(!state.locked && state.payment!=LabPaymentPhase.REVIEW) TextButton(onClick={state=state.copy(payment=LabPaymentPhase.DRAFT)}) {Text("Nueva revisión ficticia")}
        }
    }
    if(state.payment==LabPaymentPhase.REVIEW) AlertDialog(onDismissRequest={state=state.cancel()},
        title={Text("Confirmación simulada")},text={Column(verticalArrangement=Arrangement.spacedBy(8.dp)) {
            Text("¿Simular el pago de ${state.amountValue?.setScale(2)?.toPlainString()} ${state.provider.currency} a ${state.destination}?")
            Text("Origen: ${state.provider.label}. Este diálogo pertenece al laboratorio, no al banco ni a ETECSA.")
            TextButton(onClick={state=state.interrupt()}) {Text("Simular interrupción y bloquear reenvío")}
        }},confirmButton={TextButton(onClick={state=state.confirm()}) {Text("Aceptar simulación")}},
        dismissButton={TextButton(onClick={state=state.cancel()}) {Text("Cancelar")}})
}
