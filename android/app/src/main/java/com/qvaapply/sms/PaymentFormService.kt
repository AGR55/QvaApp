package com.qvaapply.sms

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast

/** Only navigation and SET_TEXT in one supported Transfermóvil version.
 * No USSD, SMS, password access, global actions, final confirmation or payment-success inference.
 * The first bank-form ACEPTAR may open review; the subsequent confirmation is always manual. */
class PaymentFormService : AccessibilityService() {
    private val handler=Handler(Looper.getMainLooper())
    private var requestId=""
    private var step=0
    private var clicks=0
    private var nextActionAt=0L
    private val poll=object:Runnable {
        override fun run() { if(advance()) handler.postDelayed(this,500) }
    }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if(event?.packageName?.toString()!=TRANSFERMOVIL_PACKAGE) return
        handler.removeCallbacks(poll);handler.postDelayed(poll,200)
    }
    override fun onInterrupt() {handler.removeCallbacks(poll);stop("Asistente interrumpido. Revisa el formulario; no se confirmó ningún pago.")}
    override fun onDestroy() {handler.removeCallbacks(poll);super.onDestroy()}

    private fun stop(message: String): Boolean {
        SecureSettings(this).clearPaymentForm()
        Toast.makeText(this,message,Toast.LENGTH_LONG).show()
        return false
    }
    private fun advance(): Boolean {
        if(!BuildConfig.PAYMENT_FORM_ENABLED) return stop("El rellenado sigue en validación. Revisa los datos y paga manualmente en Transfermóvil.")
        val request=SecureSettings(this).pendingPaymentForm() ?: return false
        val plan=request.optJSONObject("plan")?.let(AssistedPayment::parse) ?: return stop("Preparación inválida.")
        if(request.optBoolean("reviewRequested")) return stop("La revisión ya se solicitó. Confirma o cancela manualmente en Transfermóvil.")
        if(System.currentTimeMillis()>=plan.expiresAt) return stop("La preparación venció. Vuelve a QvaApply y verifica la operación.")
        if(!supported(this)) return stop("Esta versión de Transfermóvil requiere verificar de nuevo el asistente.")
        val source=runCatching {PaymentSource.valueOf(request.getString("source"))}.getOrNull()
            ?.takeIf {it in plan.sources} ?: return stop("Banco de origen inválido.")
        if(paymentFormValues(plan,source)==null) return stop("Datos de formulario inválidos.")
        if(request.optString("id").isBlank()) return stop("Falta identificar la preparación.")
        if(requestId!=request.getString("id")) {requestId=request.getString("id");step=0;clicks=0;nextActionAt=0}
        if(System.currentTimeMillis()<nextActionAt) return true
        val root=rootInActiveWindow ?: return true
        if(root.packageName?.toString()!=TRANSFERMOVIL_PACKAGE) return true
        // Never inspect or dismiss a bank/network/PIN/confirmation dialog.
        if(nodes(root).any {it.isVisibleToUser && (it.isPassword || it.text?.toString() in listOf("ACEPTAR","ENVIAR"))} && step<3)
            return stop("Hay un formulario o diálogo abierto. Ciérralo sin enviar y vuelve a preparar desde QvaApply.")
        if(clicks>=10) return stop("La pantalla no coincide con la versión verificada. No se completó el formulario.")
        return when(step) {
            0 -> {
                val drawer=nodes(root).any {it.isVisibleToUser && it.text?.toString()=="Bancos"}
                if(drawer) {
                    val chosen=nodes(root).firstOrNull {it.isVisibleToUser &&
                        (it.text?.toString()?.trim()==source.menuLabel || source==PaymentSource.CLASICA && it.text?.toString()?.trim()?.startsWith("MiTransfer")==true)}
                    if(chosen!=null && click(chosen,source.menuLabel)) {step=if(source==PaymentSource.ETECSA) 2 else 1}
                    true
                } else {
                    val menu=nodes(root).firstOrNull {it.isVisibleToUser && it.contentDescription?.toString()=="Transfermóvil" && it.isClickable}
                    if(menu!=null) navigationClick(menu)
                    true
                }
            }
            1 -> {findText(root,"OPERACIONES")?.let {if(click(it,"OPERACIONES")) step=2};true}
            2 -> {
                val label=if(source==PaymentSource.ETECSA) "Transferir tu Saldo" else if(source==PaymentSource.BPA || source==PaymentSource.BANDEC) "Transferencia" else "Transferir Efectivo"
                findText(root,label)?.let {if(click(it,label)) step=3};true
            }
            3 -> {
                if(source==PaymentSource.CLASICA) findText(root,"Transferir Efectivo Clásica")?.let {
                    if(click(it,"Transferir Efectivo Clásica")) return true
                }
                val title=byId(root,"toolbar_title").firstOrNull()?.text?.toString()
                val expected=when(source) {PaymentSource.CLASICA->"Transferencia de Efectivo Clásica";PaymentSource.ETECSA->"Transferir Saldo";else->"Transferir Efectivo"}
                if(title!=expected) return true
                val currency=byId(root,"spinnerTipoMonedaImporte").firstOrNull()
                if(currency!=null && nodes(currency).none {it.text?.toString()?.trim()==plan.currency}) {
                    if(navigationClick(currency)) step=4
                    return true
                }
                fill(root,plan,source)
            }
            4 -> {
                // AutoCompleteTextView's list may be a separate popup window.
                // Inspect only roots owned by Transfermóvil, never system/USSD windows.
                val roots=windows.mapNotNull {it.root}.filter {it.packageName?.toString()==TRANSFERMOVIL_PACKAGE}
                val option=(roots+root).firstNotNullOfOrNull {findCurrencyOption(it,plan.currency)}
                if(option!=null && click(option,plan.currency)) step=3
                else if(System.currentTimeMillis()-nextActionAt>5_000) return stop("No se pudo verificar el selector de moneda. No se rellenó el pago.")
                true
            }
            else -> false
        }
    }

    private fun fill(root: AccessibilityNodeInfo, plan: AssistedPayment, source: PaymentSource): Boolean {
        // Require the whole known form before editing anything. A service restart
        // always navigates from the bank menu again instead of trusting a stale form.
        val fields=paymentFormValues(plan,source) ?: return stop("Datos de pago inválidos.")
        val values=fields.map {(id,value)->(editable(root,id) ?: return stop("No se encontraron todos los campos verificados. No se rellenó la transferencia.")) to value}
        val succeeded=values.all {(node,value)->node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,value)
        })}
        if(!succeeded) return stop("No se pudieron rellenar todos los campos. Revisa el formulario; no se confirmó ningún pago.")
        val request=SecureSettings(this).pendingPaymentForm()
        if(request==null || request.optString("id")!=requestId) return false
        // Re-read values after TextWatchers. No final click on partial/stale data.
        if(!root.refresh()) return stop("Datos rellenados. La ventana cambió; revisa y continúa manualmente.")
        val verified=fields.all {(id,value)->
            val actual=editable(root,id)?.text?.toString() ?: return@all false
            if(id=="input_monto") actual.toBigDecimalOrNull()?.compareTo(value.toBigDecimalOrNull())==0 else actual==value
        }
        val title=byId(root,"toolbar_title").firstOrNull()?.text?.toString()
        val currentWindow=rootInActiveWindow
        val dialogVisible=nodes(root).any {node->
            val id=node.viewIdResourceName.orEmpty()
            val text=if(node.isEditable || node.isPassword) "" else node.text?.toString()?.trim()?.lowercase().orEmpty()
            node.isVisibleToUser && (id in listOf("android:id/alertTitle","android:id/button1") ||
                listOf("confirme","¿desea","desea transferir","confirmar transferencia").any {text.startsWith(it)})
        }
        val sameActiveForm=currentWindow?.packageName?.toString()==TRANSFERMOVIL_PACKAGE && currentWindow.windowId==root.windowId &&
            root.window?.isActive==true && !dialogVisible
        val currencyField=byId(root,"spinnerTipoMonedaImporte").firstOrNull()
        val sameCurrency=currencyField==null || currencyField.text?.toString()?.trim()==plan.currency
        if(verified && sameCurrency && sameActiveForm && mayRequestNativePaymentReview(source,title,request.optBoolean("reviewRequested"),plan.expiresAt,System.currentTimeMillis())) {
            // A PIN field, if present, is left exclusively to the operator.
            if(byId(root,"input_clave").isNotEmpty()) return stop("Datos rellenados. La clave y la confirmación quedan en Transfermóvil.")
            val button=byId(root,"btn_aceptar").singleOrNull()?.takeIf {it.isClickable && it.isEnabled && it.text?.toString()=="ACEPTAR"}
            if(button!=null) {
                // Persist before the one permitted form click. Never retry it.
                if(!SecureSettings(this).savePaymentForm(request.put("reviewRequested",true))) return stop("No se pudo guardar el punto de parada. Continúa manualmente.")
                button.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                return stop("Revisa la confirmación o los campos pendientes en Transfermóvil. El asistente se ha detenido; tú confirmas o cancelas.")
            }
        }
        return stop("Datos rellenados. Revisa banco, cuenta de origen, moneda, destinatario e importe en Transfermóvil. Tú decides si aceptas o cancelas.")
    }

    private fun nodes(root: AccessibilityNodeInfo): List<AccessibilityNodeInfo> {
        val result=ArrayList<AccessibilityNodeInfo>();val pending=java.util.ArrayDeque<AccessibilityNodeInfo>();pending.add(root)
        while(pending.isNotEmpty() && result.size<600) {
            val node=pending.removeFirst();result.add(node)
            for(index in 0 until node.childCount) node.getChild(index)?.let {pending.add(it)}
        }
        return result
    }
    private fun byId(root: AccessibilityNodeInfo,id: String) = root.findAccessibilityNodeInfosByViewId("$TRANSFERMOVIL_PACKAGE:id/$id").filter {it.isVisibleToUser}
    private fun editable(root: AccessibilityNodeInfo,id: String) = byId(root,id).firstNotNullOfOrNull {parent->nodes(parent).firstOrNull {it.isEditable && !it.isPassword && it.isEnabled}}
    private fun findText(root: AccessibilityNodeInfo,text: String) = nodes(root).firstOrNull {it.isVisibleToUser && it.text?.toString()?.trim()==text}
    private fun findCurrencyOption(root: AccessibilityNodeInfo,currency: String): AccessibilityNodeInfo? = nodes(root).firstOrNull {node->
        if(!node.isVisibleToUser || node.isEditable || node.text?.toString()?.trim()!=currency) false
        else {
            var parent=node.parent
            var inList=false
            repeat(5) {if(parent?.className?.toString()?.contains("ListView")==true) inList=true;parent=parent?.parent}
            inList
        }
    }
    private fun click(node: AccessibilityNodeInfo,label: String): Boolean = safePaymentNavigation(label) && navigationClick(node)
    private fun navigationClick(node: AccessibilityNodeInfo): Boolean {
        var current: AccessibilityNodeInfo?=node
        repeat(5) {
            val target=current ?: return false
            if(target.isClickable && target.isEnabled) {
                val success=target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                if(success) {clicks++;nextActionAt=System.currentTimeMillis()+700}
                return success
            }
            current=target.parent
        }
        return false
    }
    companion object {
        internal fun enabled(context: Context): Boolean = BuildConfig.PAYMENT_FORM_ENABLED && context.getSystemService(AccessibilityManager::class.java)
            .getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .any {it.resolveInfo.serviceInfo.packageName==context.packageName && it.resolveInfo.serviceInfo.name==PaymentFormService::class.java.name}
        internal fun supported(context: Context): Boolean = BuildConfig.PAYMENT_FORM_ENABLED && runCatching {
            context.packageManager.getPackageInfo(TRANSFERMOVIL_PACKAGE,0).versionName==TRANSFERMOVIL_SUPPORTED_VERSION
        }.getOrDefault(false)
    }
}
