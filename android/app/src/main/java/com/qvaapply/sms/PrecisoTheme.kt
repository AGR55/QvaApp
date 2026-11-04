package com.qvaapply.sms

import android.os.Build
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.util.Locale

object UiSpace {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 24.dp
    val touchTarget = 48.dp
}

object UiShapes {
    val small = RoundedCornerShape(8.dp)
    val medium = RoundedCornerShape(12.dp)
    val large = RoundedCornerShape(16.dp)
}

private val PrecisoShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = UiShapes.small,
    medium = UiShapes.medium,
    large = UiShapes.large,
    extraLarge = RoundedCornerShape(24.dp),
)

private val Day = lightColorScheme(
    primary=Color(0xFF2463EB),onPrimary=Color.White,primaryContainer=Color(0xFFE7EEFF),onPrimaryContainer=Color(0xFF174AB0),
    secondary=Color(0xFF12765D),onSecondary=Color.White,secondaryContainer=Color(0xFFD9F6EA),onSecondaryContainer=Color(0xFF07533E),
    tertiary=Color(0xFF996315),onTertiary=Color.White,tertiaryContainer=Color(0xFFFFF0D8),onTertiaryContainer=Color(0xFF674308),
    background=Color(0xFFF5F7FC),onBackground=Color(0xFF15243C),surface=Color.White,onSurface=Color(0xFF15243C),
    surfaceVariant=Color(0xFFEDF1F8),onSurfaceVariant=Color(0xFF66738A),outline=Color(0xFF8290A6),outlineVariant=Color(0xFFE4EAF3),
    surfaceContainer=Color(0xFFF0F3FA),surfaceContainerLow=Color(0xFFF8FAFF),surfaceContainerHigh=Color(0xFFEDF1F8),
    surfaceContainerLowest=Color.White,surfaceContainerHighest=Color(0xFFE4EAF3),surfaceDim=Color(0xFFDCE2EB),surfaceBright=Color.White,
    inverseSurface=Color(0xFF293448),inverseOnSurface=Color(0xFFEDF2FC),inversePrimary=Color(0xFFA6C4FF),surfaceTint=Color(0xFF2463EB),
    error=Color(0xFFB63950),onError=Color.White,errorContainer=Color(0xFFFFE8ED),onErrorContainer=Color(0xFF8D2035),
)
private val Night = darkColorScheme(
    primary=Color(0xFFA6C4FF),onPrimary=Color(0xFF102E68),primaryContainer=Color(0xFF1F3963),onPrimaryContainer=Color(0xFFD9E6FF),
    secondary=Color(0xFF83DFC0),onSecondary=Color(0xFF003829),secondaryContainer=Color(0xFF164C3E),onSecondaryContainer=Color(0xFFA6F0D7),
    tertiary=Color(0xFFEBC481),onTertiary=Color(0xFF422C09),tertiaryContainer=Color(0xFF4F3B1B),onTertiaryContainer=Color(0xFFFFE5B8),
    background=Color(0xFF0D1524),onBackground=Color(0xFFEDF2FC),surface=Color(0xFF172236),onSurface=Color(0xFFEDF2FC),
    surfaceVariant=Color(0xFF223148),onSurfaceVariant=Color(0xFFA9B8CF),outline=Color(0xFF7D8FA9),outlineVariant=Color(0xFF29394F),
    surfaceContainer=Color(0xFF1B293F),surfaceContainerLow=Color(0xFF131E31),surfaceContainerHigh=Color(0xFF223148),
    surfaceContainerLowest=Color(0xFF080F1C),surfaceContainerHighest=Color(0xFF29394F),surfaceDim=Color(0xFF0D1524),surfaceBright=Color(0xFF304057),
    inverseSurface=Color(0xFFEDF2FC),inverseOnSurface=Color(0xFF293448),inversePrimary=Color(0xFF2463EB),surfaceTint=Color(0xFFA6C4FF),
    error=Color(0xFFFFACBB),onError=Color(0xFF650E25),errorContainer=Color(0xFF512A38),onErrorContainer=Color(0xFFFFD9E1),
)

@Composable
fun PrecisoTheme(mode: String, content: @Composable () -> Unit) {
    val dark=mode=="dark" || (mode=="system" && isSystemInDarkTheme())
    val context=LocalContext.current
    val colors=if(mode=="system" && Build.VERSION.SDK_INT>=Build.VERSION_CODES.S) {
        if(dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    } else if(dark) Night else Day
    val view=androidx.compose.ui.platform.LocalView.current
    SideEffect {
        (view.context as? android.app.Activity)?.let { activity ->
            androidx.core.view.WindowCompat.getInsetsController(activity.window,view).apply {
                isAppearanceLightStatusBars=!dark
                isAppearanceLightNavigationBars=!dark
            }
        }
    }
    MaterialTheme(colorScheme=colors,shapes=PrecisoShapes,typography=Typography(
        displayLarge=TextStyle(fontSize=40.sp,lineHeight=48.sp,fontWeight=FontWeight.SemiBold),
        displayMedium=TextStyle(fontSize=36.sp,lineHeight=44.sp,fontWeight=FontWeight.SemiBold),
        displaySmall=TextStyle(fontSize=32.sp,lineHeight=40.sp,fontWeight=FontWeight.SemiBold,letterSpacing=(-0.5).sp),
        headlineLarge=TextStyle(fontSize=28.sp,lineHeight=36.sp,fontWeight=FontWeight.SemiBold),
        headlineMedium=TextStyle(fontSize=24.sp,lineHeight=32.sp,fontWeight=FontWeight.SemiBold),
        headlineSmall=TextStyle(fontSize=22.sp,lineHeight=28.sp,fontWeight=FontWeight.SemiBold),
        titleLarge=TextStyle(fontSize=20.sp,lineHeight=28.sp,fontWeight=FontWeight.SemiBold),
        titleMedium=TextStyle(fontSize=16.sp,lineHeight=22.sp,fontWeight=FontWeight.SemiBold),
        titleSmall=TextStyle(fontSize=14.sp,lineHeight=20.sp,fontWeight=FontWeight.SemiBold),
        bodyLarge=TextStyle(fontSize=16.sp,lineHeight=24.sp),bodyMedium=TextStyle(fontSize=14.sp,lineHeight=20.sp),
        bodySmall=TextStyle(fontSize=12.sp,lineHeight=18.sp),
        labelLarge=TextStyle(fontSize=14.sp,lineHeight=20.sp,fontWeight=FontWeight.Medium),
        labelMedium=TextStyle(fontSize=12.sp,lineHeight=16.sp,fontWeight=FontWeight.Medium),
        labelSmall=TextStyle(fontSize=11.sp,lineHeight=15.sp,fontWeight=FontWeight.Medium),
    ),content=content)
}

@Composable
fun PrecisoMark(modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.primary) {
    Canvas(modifier) {
        val scale = size.minDimension / 256f
        val p = Path().apply {
            moveTo(108f,32f); lineTo(220f,32f); lineTo(220f,48f); lineTo(202f,66f); lineTo(112f,66f)
            cubicTo(84f,66f,68f,84f,68f,112f); lineTo(68f,144f); lineTo(32f,144f); lineTo(32f,108f)
            cubicTo(32f,62f,62f,32f,108f,32f); close()
        }
        with(drawContext.canvas) {
            save(); scale(scale, scale); drawPath(p, androidx.compose.ui.graphics.Paint().apply { this.color = color })
            translate(256f,256f); rotate(180f); drawPath(p, androidx.compose.ui.graphics.Paint().apply { this.color = color }); restore()
        }
        val diamond = Path().apply {
            moveTo(128f*scale,102f*scale); lineTo(154f*scale,128f*scale); lineTo(128f*scale,154f*scale); lineTo(102f*scale,128f*scale); close()
        }
        drawPath(diamond,color)
    }
}

@Composable
fun PrecisoIcon(kind: String, modifier: Modifier = Modifier, color: Color = LocalContentColor.current, description: String? = null) {
    val resource=when(kind) {
        "home"->R.drawable.ph_house; "wallet","capital"->R.drawable.ph_wallet
        "operations"->R.drawable.ph_arrows_left_right; "chat"->R.drawable.ph_chat_circle_dots
        "tools"->R.drawable.ph_squares_four; "settings"->R.drawable.ph_gear_six
        "alerts"->R.drawable.ph_bell; "back"->R.drawable.ph_arrow_left
        "send"->R.drawable.ph_paper_plane_right; "image"->R.drawable.ph_image; "search"->R.drawable.ph_magnifying_glass
        "next"->R.drawable.ph_caret_right; "buy"->R.drawable.ph_arrow_down_left
        "sell"->R.drawable.ph_arrow_up_right; "target"->R.drawable.ph_crosshair
        "chart"->R.drawable.ph_chart_bar; "history"->R.drawable.ph_clock_counter_clockwise
        "health"->R.drawable.ph_heartbeat; "filter"->R.drawable.ph_sliders_horizontal
        "phone"->R.drawable.ph_device_mobile; "shield"->R.drawable.ph_shield_check
        "check"->R.drawable.ph_check_circle; "warning"->R.drawable.ph_warning_circle
        "copy"->R.drawable.ph_copy; "refresh"->R.drawable.ph_arrow_clockwise
        "moon"->R.drawable.ph_moon; "sun"->R.drawable.ph_sun
        "receipt"->R.drawable.ph_receipt; "info"->R.drawable.ph_info
        "coins"->R.drawable.ph_coins; "more"->R.drawable.ph_dots_three_vertical
        "eye"->R.drawable.ph_eye; "eye-off"->R.drawable.ph_eye_slash
        "card"->R.drawable.ph_credit_card; "bank"->R.drawable.ph_bank
        "close"->R.drawable.ph_x; else->R.drawable.ph_info
    }
    Icon(androidx.compose.ui.res.painterResource(resource),description,modifier.size(24.dp),tint=color)
}

@Composable
fun MarketLogo(market: String, modifier: Modifier = Modifier) {
    val resource=when(market.trim().uppercase(Locale.ROOT)) {
        "BANK_CUP","CUP"->R.drawable.market_cup
        "BANDECPREPAGO","TROPICAL"->R.drawable.market_tropical
        "CLASICA","CLÁSICA"->R.drawable.market_clasica
        "QUSD","QVAPAY"->R.drawable.market_qusd
        "ETECSA"->R.drawable.market_etecsa
        "ZELLE"->R.drawable.market_zelle
        else->null
    }
    if(resource!=null) {
        Image(painterResource(resource),contentDescription=null,modifier=modifier.size(32.dp),contentScale=ContentScale.Fit)
    } else {
        Icon(painterResource(R.drawable.ph_bank),contentDescription=null,modifier=modifier.size(32.dp),tint=MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun PrecisoPanel(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(modifier.fillMaxWidth(), shape=UiShapes.medium, color=MaterialTheme.colorScheme.surface,
        border=BorderStroke(1.dp,MaterialTheme.colorScheme.outlineVariant)) {
        Column(Modifier.padding(UiSpace.md),verticalArrangement=Arrangement.spacedBy(UiSpace.sm),content=content)
    }
}

@Composable
fun SectionHeading(eyebrow: String, title: String, subtitle: String? = null) {
    Column(verticalArrangement=Arrangement.spacedBy(UiSpace.xs)) {
        Text(title,style=MaterialTheme.typography.titleLarge)
        if(subtitle!=null) Text(subtitle,style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
