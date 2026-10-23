package com.qvaapply.sms

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val Day = lightColorScheme(
    primary = Color(0xFF1D4E86), onPrimary = Color.White, primaryContainer = Color(0xFFE1EBF8), onPrimaryContainer = Color(0xFF123B70),
    secondary = Color(0xFF286748), secondaryContainer = Color(0xFFDCEDE0), onSecondaryContainer = Color(0xFF164D30),
    background = Color(0xFFF6F2EA), onBackground = Color(0xFF242720), surface = Color(0xFFFFFDF8), onSurface = Color(0xFF242720),
    surfaceVariant = Color(0xFFECE7DF), onSurfaceVariant = Color(0xFF5D625D), outline = Color(0xFF798078), outlineVariant = Color(0xFFD8D9D1),
    error = Color(0xFFA62F42), errorContainer = Color(0xFFFCE6E8), onErrorContainer = Color(0xFF742030),
)
private val Night = darkColorScheme(
    primary = Color(0xFFA5C9FA), onPrimary = Color(0xFF0B2B50), primaryContainer = Color(0xFF183D65), onPrimaryContainer = Color(0xFFDAE9FF),
    secondary = Color(0xFFAAD9B8), secondaryContainer = Color(0xFF1C4431), onSecondaryContainer = Color(0xFFCBF0D3),
    background = Color(0xFF101A22), onBackground = Color(0xFFF0F1EB), surface = Color(0xFF18252E), onSurface = Color(0xFFF0F1EB),
    surfaceVariant = Color(0xFF24333C), onSurfaceVariant = Color(0xFFBBC7CB), outline = Color(0xFF8C9BA2), outlineVariant = Color(0xFF354852),
    error = Color(0xFFFFAAB5), errorContainer = Color(0xFF572C37), onErrorContainer = Color(0xFFFFD9DE),
)

@Composable
fun PrecisoTheme(mode: String, content: @Composable () -> Unit) {
    val dark = mode == "dark" || (mode == "system" && isSystemInDarkTheme())
    val view=androidx.compose.ui.platform.LocalView.current
    SideEffect {
        (view.context as? android.app.Activity)?.let { activity ->
            androidx.core.view.WindowCompat.getInsetsController(activity.window,view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
    }
    MaterialTheme(colorScheme = if (dark) Night else Day, typography = Typography(
        displaySmall = TextStyle(fontFamily = FontFamily.Serif, fontSize = 38.sp, lineHeight = 44.sp),
        headlineLarge = TextStyle(fontFamily = FontFamily.Serif, fontSize = 32.sp, lineHeight = 38.sp),
        headlineMedium = TextStyle(fontFamily = FontFamily.Serif, fontSize = 28.sp, lineHeight = 34.sp),
        titleLarge = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
        titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
        bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 21.sp),
        labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 16.sp, letterSpacing = 0.3.sp),
    ), content = content)
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

/** Small vector glyphs, independent of emoji fonts and large icon libraries. */
@Composable
fun PrecisoIcon(kind: String, modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.primary) {
    Canvas(modifier.size(24.dp)) {
        val s = size.minDimension / 24f
        fun line(a: Float, b: Float, c: Float, d: Float) = drawLine(color, Offset(a*s,b*s),Offset(c*s,d*s),1.7f*s, androidx.compose.ui.graphics.StrokeCap.Round)
        when (kind) {
            "home" -> { line(3f,11f,12f,3f); line(12f,3f,21f,11f); line(6f,10f,6f,21f); line(6f,21f,18f,21f); line(18f,21f,18f,10f); line(10f,21f,10f,15f); line(10f,15f,14f,15f); line(14f,15f,14f,21f) }
            "operations" -> { line(4f,7f,20f,7f); line(20f,7f,16f,3f); line(20f,17f,4f,17f); line(4f,17f,8f,21f) }
            "alerts" -> { drawRoundRect(color,Offset(6*s,4*s), androidx.compose.ui.geometry.Size(12*s,14*s), androidx.compose.ui.geometry.CornerRadius(5*s),style=Stroke(1.7f*s)); line(4f,18f,20f,18f); line(10f,21f,14f,21f) }
            "settings" -> { for(y in listOf(6f,12f,18f)) line(3f,y,21f,y); drawCircle(color,2*s,Offset(8*s,6*s)); drawCircle(color,2*s,Offset(16*s,12*s)); drawCircle(color,2*s,Offset(10*s,18*s)) }
            "target" -> { drawCircle(color,9*s,style=Stroke(1.7f*s)); drawCircle(color,4*s,style=Stroke(1.7f*s)); line(12f,2f,12f,7f); line(17f,12f,22f,12f) }
            else -> { line(4f,20f,4f,4f); line(4f,20f,21f,20f); line(7f,16f,11f,11f); line(11f,11f,15f,14f); line(15f,14f,21f,5f) }
        }
    }
}

@Composable
fun PrecisoPanel(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(modifier.fillMaxWidth(), shape=RoundedCornerShape(24.dp), color=MaterialTheme.colorScheme.surface.copy(alpha=0.94f),
        border=BorderStroke(1.dp,MaterialTheme.colorScheme.outlineVariant.copy(alpha=0.65f))) {
        Column(Modifier.padding(20.dp),verticalArrangement=Arrangement.spacedBy(12.dp),content=content)
    }
}

@Composable
fun SectionHeading(eyebrow: String, title: String, subtitle: String? = null) {
    Column(verticalArrangement=Arrangement.spacedBy(6.dp)) {
        Text(eyebrow.uppercase(),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.primary)
        Text(title,style=MaterialTheme.typography.headlineLarge)
        if(subtitle!=null) Text(subtitle,style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
