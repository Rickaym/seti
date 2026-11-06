package dev.seti.android.widget

import android.os.Build
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.glance.GlanceTheme
import androidx.glance.color.ColorProvider as dayNight
import androidx.glance.color.ColorProviders
import androidx.glance.material3.ColorProviders as materialColors
import androidx.glance.unit.ColorProvider

/** Seti's own blue scheme, for phones before Android 12 that have no wallpaper colours. */
private val SetiColors: ColorProviders = materialColors(
    light = lightColorScheme(
        primary = Color(0xFF2B5FD9),
        onPrimary = Color.White,
        primaryContainer = Color(0xFFDCE5FF),
        onPrimaryContainer = Color(0xFF0B1E4D),
        secondaryContainer = Color(0xFFECEFF6),
        onSecondaryContainer = Color(0xFF1A1F2E),
        tertiary = Color(0xFF94570A),
        tertiaryContainer = Color(0xFFFFE3C2),
        onTertiaryContainer = Color(0xFF3A2000),
        error = Color(0xFFB3261E),
        background = Color(0xFFFAFBFE),
        surface = Color(0xFFFAFBFE),
        onSurface = Color(0xFF171B26),
        surfaceVariant = Color(0xFFE3E6EE),
        onSurfaceVariant = Color(0xFF586071),
        outline = Color(0xFFB9BECB),
    ),
    dark = darkColorScheme(
        primary = Color(0xFF8FB2FF),
        onPrimary = Color(0xFF0D1B3A),
        primaryContainer = Color(0xFF253B73),
        onPrimaryContainer = Color(0xFFDCE5FF),
        secondaryContainer = Color(0xFF262B3D),
        onSecondaryContainer = Color(0xFFE3E6F0),
        tertiary = Color(0xFFF2B866),
        tertiaryContainer = Color(0xFF5A3A0C),
        onTertiaryContainer = Color(0xFFFFE3C2),
        error = Color(0xFFFF8A80),
        background = Color(0xFF1A1D2E),
        surface = Color(0xFF1A1D2E),
        onSurface = Color(0xFFEEF0F6),
        surfaceVariant = Color(0xFF2E3346),
        onSurfaceVariant = Color(0xFFA9AFBF),
        outline = Color(0xFF555C70),
    ),
)

/** Material You from the wallpaper where Android offers it, else Seti's blue. */
@Composable
internal fun WidgetTheme(content: @Composable () -> Unit) {
    val colors = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) GlanceTheme.colors else SetiColors
    GlanceTheme(colors = colors, content = content)
}

/** Passing CI and merged PRs; Material has no green of its own. */
internal val SuccessColor: ColorProvider = dayNight(day = Color(0xFF2E7D32), night = Color(0xFF81C995))

@Composable
internal fun stateColor(state: AgentState): ColorProvider = when (state) {
    AgentState.RUNNING -> GlanceTheme.colors.primary
    AgentState.WAITING -> GlanceTheme.colors.tertiary
    AgentState.FAILED -> GlanceTheme.colors.error
    AgentState.COMPLETE -> SuccessColor
    AgentState.IDLE -> GlanceTheme.colors.outline
}

@Composable
internal fun signalColor(signal: PrSignal): ColorProvider = when (signal) {
    PrSignal.CI_FAILING -> GlanceTheme.colors.error
    PrSignal.REVIEWS, PrSignal.CI_PENDING -> GlanceTheme.colors.tertiary
    PrSignal.CI_PASSING, PrSignal.MERGED -> SuccessColor
    PrSignal.OPEN, PrSignal.CLOSED -> GlanceTheme.colors.onSurfaceVariant
}

/** The agent's own colour, or a quiet outline when it has none. */
@Composable
internal fun agentColor(hex: String?): ColorProvider =
    WidgetFormat.color(hex)?.let { ColorProvider(Color(it)) } ?: GlanceTheme.colors.outline
