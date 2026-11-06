package dev.seti.android.widget

import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.appwidget.components.CircleIconButton
import androidx.glance.appwidget.components.Scaffold
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ColumnScope
import androidx.glance.layout.Row
import androidx.glance.layout.RowScope
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import dev.seti.android.R
import dev.seti.android.data.SetiState

/** Heights the widgets plan their rows with, in dp; Glance cannot measure text before drawing it. */
internal object Heights {
    const val HEADER = 40
    const val FOOTER = 20
    const val PADDING = 14
    const val OVERFLOW = 20
    const val LINE = 16
    const val TITLE = 20
    const val GAP = 6
}

/** The frame both widgets share: a header that opens Seti, the body, and the freshness line. */
@Composable
internal fun WidgetFrame(
    state: SetiState,
    now: Long,
    header: @Composable () -> Unit,
    extra: String? = null,
    body: @Composable ColumnScope.() -> Unit,
) {
    Scaffold(horizontalPadding = 12.dp) {
        Column(modifier = GlanceModifier.fillMaxSize().padding(bottom = 8.dp)) {
            header()
            Column(modifier = GlanceModifier.fillMaxWidth().defaultWeight(), content = body)
            Footer(state, now, extra)
        }
    }
}

/** A count in the header, in the colour of the state it counts. */
internal data class Count(val text: String, val color: ColorProvider)

/** The Seti mark, a title or counts in its place, which open Seti, then icon actions and refresh. */
@Composable
internal fun Header(
    title: String?,
    open: Action,
    counts: List<Count> = emptyList(),
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = GlanceModifier.fillMaxWidth().height(Heights.HEADER.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = GlanceModifier.defaultWeight().clickable(open),
        ) {
            Image(
                provider = ImageProvider(R.drawable.ic_seti),
                contentDescription = null,
                colorFilter = ColorFilter.tint(GlanceTheme.colors.primary),
                modifier = GlanceModifier.size(18.dp),
            )
            if (title != null) {
                Spacer(GlanceModifier.width(6.dp))
                Text(
                    title,
                    maxLines = 1,
                    style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 15.sp, fontWeight = FontWeight.Medium),
                )
            }
            counts.forEachIndexed { index, count ->
                Spacer(GlanceModifier.width(if (index == 0 && title == null) 6.dp else 8.dp))
                Text(
                    count.text,
                    maxLines = 1,
                    style = TextStyle(
                        color = count.color,
                        fontSize = if (title == null) 15.sp else 12.sp,
                        fontWeight = FontWeight.Medium,
                    ),
                )
            }
        }
        actions()
        RefreshButton()
    }
}

@Composable
internal fun IconAction(icon: Int, label: String, action: Action) {
    CircleIconButton(
        imageProvider = ImageProvider(icon),
        contentDescription = label,
        onClick = action,
        backgroundColor = null,
        contentColor = GlanceTheme.colors.onSurfaceVariant,
        modifier = GlanceModifier.size(36.dp),
    )
}

/** Freshness on the left, and an optional secondary fact such as today's cost on the right. */
@Composable
private fun Footer(state: SetiState, now: Long, extra: String?) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = GlanceModifier.fillMaxWidth().height(Heights.FOOTER.dp),
    ) {
        StatusText(state, now, GlanceModifier.defaultWeight())
        if (extra != null) {
            Text(extra, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp))
        }
    }
}

/** A round marker; before Android 12 Glance draws it square. */
@Composable
internal fun Dot(color: ColorProvider, size: Dp = 8.dp) {
    Box(modifier = GlanceModifier.size(size).cornerRadius(size / 2).background(color)) {}
}

/** One line of secondary text that opens `action`, such as "+3 more waiting". */
@Composable
internal fun MoreLine(text: String, action: Action) {
    Text(
        text,
        maxLines = 1,
        style = TextStyle(color = GlanceTheme.colors.primary, fontSize = 12.sp, fontWeight = FontWeight.Medium),
        modifier = GlanceModifier.fillMaxWidth().height(Heights.OVERFLOW.dp).padding(top = 3.dp).clickable(action),
    )
}

/** The calm centre a widget shows with nothing to list. */
@Composable
internal fun EmptyNote(icon: Int?, title: String, detail: String?, action: Action) {
    Column(
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = GlanceModifier.fillMaxSize().clickable(action),
    ) {
        if (icon != null) {
            Image(
                provider = ImageProvider(icon),
                contentDescription = null,
                colorFilter = ColorFilter.tint(SuccessColor),
                modifier = GlanceModifier.size(28.dp),
            )
            Spacer(GlanceModifier.height(4.dp))
        }
        Text(
            title,
            maxLines = 1,
            style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 14.sp, fontWeight = FontWeight.Medium),
        )
        if (detail != null) {
            Text(detail, maxLines = 2, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp))
        }
    }
}

/** The text a body has room for: total height less the frame's header, footer and padding. */
internal fun bodyBudget(height: Dp): Int = (height.value.toInt() - Heights.HEADER - Heights.FOOTER - Heights.PADDING)

/** Plural strings read through the widget's context. */
@Composable
internal fun plural(id: Int, count: Int): String = LocalContext.current.resources.getQuantityString(id, count, count)
