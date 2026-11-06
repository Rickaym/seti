package dev.seti.android.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.components.Scaffold
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import dev.seti.android.R
import dev.seti.android.SetiRoutes
import dev.seti.android.api.NeedsYouItem
import dev.seti.android.data.SetiState
import dev.seti.android.data.SetiStore

class NeedsYouWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget = NeedsYouWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        Refresh.now(context)
    }
}

/** Each agent that waits on the user, why and for how long; a count only for those that do not fit. */
class NeedsYouWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val store = SetiStore(context)
        val initial = store.current()
        provideContent {
            val state by store.state.collectAsState(initial)
            WidgetTheme { Content(state, System.currentTimeMillis()) }
        }
    }

    @Composable
    private fun Content(state: SetiState, now: Long) {
        val context = LocalContext.current
        if (!state.paired) {
            Scaffold { PairPrompt(state) }
            return
        }
        val summary = state.summary
        val items = summary?.needsYou.orEmpty()
        val total = summary?.needsYouCount ?: 0
        val home = openRoute(context, state, SetiRoutes.HOME)
        val narrow = LocalSize.current.width < WIDE_DP
        val waiting = GlanceTheme.colors.tertiary
        WidgetFrame(
            state = state,
            now = now,
            header = {
                when {
                    total == 0 -> Header(context.getString(R.string.widget_needs_you), home)
                    narrow -> Header(null, home, listOf(Count(context.getString(R.string.widget_waiting_count, total), waiting)))
                    else -> Header(context.getString(R.string.widget_needs_you), home, listOf(Count(total.toString(), waiting)))
                }
            },
        ) {
            when {
                summary == null -> Unit
                items.isEmpty() -> EmptyNote(
                    R.drawable.ic_check,
                    context.getString(R.string.widget_all_clear),
                    context.getString(R.string.widget_nothing_waits),
                    home,
                )
                else -> Rows(state, items, total, now, narrow)
            }
        }
    }

    @Composable
    private fun Rows(state: SetiState, items: List<NeedsYouItem>, total: Int, now: Long, narrow: Boolean) {
        val context = LocalContext.current
        val budget = bodyBudget(LocalSize.current.height)
        val lines = if (narrow || budget >= 2 * rowHeight(2)) 2 else 1
        val height = rowHeight(lines, if (narrow) 2 else 1)
        val shown = WidgetFormat.fit(items.map { height }, budget)
        val more = total - shown
        val room = budget - shown * height >= Heights.OVERFLOW
        Column(modifier = GlanceModifier.fillMaxWidth()) {
            val width = LocalSize.current.width.value - TEXT_INSET
            items.take(shown).forEach { WaitingRow(state, it, now, lines, width, narrow) }
            if (more > 0 && room) {
                MoreLine(plural(R.plurals.widget_more_waiting, more), openRoute(context, state, SetiRoutes.HOME))
            }
        }
    }

    @Composable
    private fun WaitingRow(state: SetiState, item: NeedsYouItem, now: Long, lines: Int, width: Float, narrow: Boolean) {
        val context = LocalContext.current
        val since = parseInstant(item.since)?.let { WidgetFormat.age(it, now) }
        val text = GlanceTheme.colors.onSecondaryContainer
        Column(modifier = GlanceModifier.fillMaxWidth().padding(bottom = Heights.GAP.dp)) {
            Row(
                verticalAlignment = Alignment.Top,
                modifier = GlanceModifier
                    .fillMaxWidth()
                    .cornerRadius(12.dp)
                    .background(GlanceTheme.colors.secondaryContainer)
                    .padding(horizontal = 10.dp, vertical = 6.dp)
                    .clickable(openRoute(context, state, SetiRoutes.agent(item.taskId))),
            ) {
                Column(modifier = GlanceModifier.padding(top = 6.dp)) { Dot(agentColor(item.color)) }
                Spacer(GlanceModifier.width(8.dp))
                Column(modifier = GlanceModifier.defaultWeight()) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = GlanceModifier.fillMaxWidth()) {
                        Text(
                            WidgetFormat.clip(item.title, WidgetFormat.charsFor(if (narrow) width else width - 32f, 14f) * if (narrow) 2 else 1),
                            maxLines = if (narrow) 2 else 1,
                            style = TextStyle(color = text, fontSize = 14.sp, fontWeight = FontWeight.Medium),
                            modifier = GlanceModifier.defaultWeight(),
                        )
                        if (since != null && !narrow) {
                            Text(since, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.tertiary, fontSize = 11.sp))
                        }
                    }
                    val reason = item.line.ifBlank { item.reason }
                    Text(
                        WidgetFormat.clip(
                            if (narrow && since != null) "$since \u00b7 $reason" else reason,
                            WidgetFormat.charsFor(width, 12f) * lines,
                        ),
                        maxLines = lines,
                        style = TextStyle(color = text, fontSize = 12.sp),
                    )
                }
            }
        }
    }

    private companion object {
        val WIDE_DP = 220.dp

        /** Frame padding, card padding and the dot column, left of a row's text. */
        const val TEXT_INSET = 24f + 20f + 14f
    }

    private fun rowHeight(lines: Int, titleLines: Int = 1) = Heights.TITLE * titleLines + Heights.LINE * lines + Heights.GAP + 12
}
