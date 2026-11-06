package dev.seti.android.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.components.Scaffold
import androidx.glance.appwidget.provideContent
import androidx.glance.layout.Column
import androidx.glance.layout.fillMaxWidth
import dev.seti.android.R
import dev.seti.android.SetiRoutes
import dev.seti.android.api.WidgetSummary
import dev.seti.android.data.SetiState
import dev.seti.android.data.SetiStore

class AgentsWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget = AgentsWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        Refresh.now(context)
    }
}

/** What each agent is doing, by name: its step, tool, subagents and PR, running agents first. */
class AgentsWidget : GlanceAppWidget() {
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
        val wide = LocalSize.current.width >= WIDE_DP
        val home = openRoute(context, state, SetiRoutes.HOME)
        WidgetFrame(
            state = state,
            now = now,
            extra = summary?.takeIf { wide }?.let {
                context.getString(R.string.widget_cost_today, WidgetFormat.cost(it.costTodayUsd))
            },
            header = {
                val shownCounts = summary?.let { counts(context, it) }.orEmpty().take(if (wide) 2 else 1)
                Header(
                    title = if (shownCounts.isEmpty()) context.getString(R.string.widget_agents) else null,
                    open = home,
                    counts = shownCounts,
                    actions = {
                        if (wide) {
                            IconAction(
                                R.drawable.ic_add,
                                context.getString(R.string.widget_new_agent),
                                openRoute(context, state, SetiRoutes.NEW_AGENT),
                            )
                            IconAction(
                                R.drawable.ic_call,
                                context.getString(R.string.widget_call_ea),
                                openRoute(context, state, SetiRoutes.EA),
                            )
                        }
                    },
                )
            },
        ) {
            when {
                summary == null -> Unit
                summary.agents.isEmpty() -> EmptyNote(
                    null,
                    counts(context, summary).joinToString("  ") { it.text }
                        .ifEmpty { context.getString(R.string.widget_no_agents) },
                    null,
                    home,
                )
                else -> Rows(state, summary, now)
            }
        }
    }

    @Composable
    private fun counts(context: Context, summary: WidgetSummary): List<Count> = listOfNotNull(
        summary.running.takeIf { it > 0 }?.let {
            Count(context.getString(R.string.widget_running_count, it), GlanceTheme.colors.primary)
        },
        summary.needsYouCount.takeIf { it > 0 }?.let {
            Count(context.getString(R.string.widget_waiting_count, it), GlanceTheme.colors.tertiary)
        },
    )

    @Composable
    private fun Rows(state: SetiState, summary: WidgetSummary, now: Long) {
        val context = LocalContext.current
        val size = LocalSize.current
        val budget = bodyBudget(size.height)
        val detail = if (size.height.value >= LARGE_DP && size.width >= WIDE_DP) Detail.FULL else Detail.COMPACT
        val agents = summary.agents
        val shown = WidgetFormat.fit(agents.map { rowHeight(it, detail) }, budget)
        val total = maxOf(agents.size, summary.running + summary.idle + summary.needsYouCount)
        val used = agents.take(shown).sumOf { rowHeight(it, detail) }
        Column(modifier = GlanceModifier.fillMaxWidth()) {
            agents.take(shown).forEach {
                AgentRow(it, detail, now, openRoute(context, state, SetiRoutes.agent(it.taskId)), size.width.value - 24f)
            }
            if (total > shown && budget - used >= Heights.OVERFLOW) {
                MoreLine(plural(R.plurals.widget_more_agents, total - shown), openRoute(context, state, SetiRoutes.HOME))
            }
        }
    }

    private companion object {
        val WIDE_DP = 220.dp
        const val LARGE_DP = 300f
    }
}
