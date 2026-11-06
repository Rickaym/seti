package dev.seti.android.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalContext
import androidx.glance.action.Action
import androidx.glance.action.clickable
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
import androidx.glance.unit.ColorProvider
import dev.seti.android.R
import dev.seti.android.api.AgentItem
import dev.seti.android.api.PrItem

/** How much of an agent a row shows: its name and activity, or its PR and subagents as well. */
internal enum class Detail { COMPACT, FULL }

/** Text under the name starts here, past the dot and its gap. */
private val INDENT = 14.dp

/** Room the name leaves for its age or progress at the end of the line. */
private const val META_DP = 32f

internal fun rowHeight(agent: AgentItem, detail: Detail): Int {
    val base = Heights.TITLE + Heights.LINE + Heights.GAP
    if (detail == Detail.COMPACT) return base
    val pr = if (agent.pr != null) 1 else 0
    val more = if (agent.moreSubagents > 0) 1 else 0
    return base + Heights.LINE * (pr + agent.subagents.size + more)
}

internal fun activityText(context: Context, activity: Activity): String = when (activity) {
    is Activity.Said ->
        activity.tool?.let { context.getString(R.string.widget_said_tool, activity.text, it) } ?: activity.text
    is Activity.Using -> context.getString(R.string.widget_using_tool, activity.tool)
    Activity.Working -> context.getString(R.string.widget_working)
    Activity.Failed -> context.getString(R.string.widget_failed_turn)
    Activity.Done -> context.getString(R.string.widget_done)
    Activity.Idle -> context.getString(R.string.widget_idle_activity)
}

internal fun prText(context: Context, pr: PrItem): String {
    val signal = WidgetFormat.signal(pr)
    val word = when (signal) {
        PrSignal.CI_FAILING -> context.getString(R.string.widget_pr_failing)
        PrSignal.REVIEWS -> null
        PrSignal.CI_PENDING -> context.getString(R.string.widget_pr_pending)
        PrSignal.CI_PASSING -> context.getString(R.string.widget_pr_passing)
        PrSignal.OPEN -> context.getString(R.string.widget_pr_open)
        PrSignal.MERGED -> context.getString(R.string.widget_pr_merged)
        PrSignal.CLOSED -> context.getString(R.string.widget_pr_closed)
    }
    val reviews = pr.unresolvedThreads.takeIf { it > 0 && pr.state == "open" }?.let {
        context.resources.getQuantityString(R.plurals.widget_pr_reviews, it, it)
    }
    val more = pr.more.takeIf { it > 0 }?.let { "+$it" }
    return listOfNotNull(pr.label ?: context.getString(R.string.widget_pr), word, reviews, more).joinToString(" \u00b7 ")
}

/** What sits at the end of the name line: todo progress while running, else how long ago it changed. */
private fun meta(agent: AgentItem, now: Long): String? {
    val todos = agent.todos
    if (WidgetFormat.state(agent.state) == AgentState.RUNNING && todos != null && todos.total > 0) {
        return WidgetFormat.progress(todos.done, todos.total)
    }
    return parseInstant(agent.since)?.let { WidgetFormat.age(it, now) }
}

@Composable
private fun SmallLine(text: String, color: ColorProvider, width: Float) {
    Text(
        WidgetFormat.clip(text, WidgetFormat.charsFor(width, 11f)),
        maxLines = 1,
        style = TextStyle(color = color, fontSize = 11.sp),
        modifier = GlanceModifier.padding(start = INDENT),
    )
}

/** An agent's name with its colour, what it does now, and with room its PR and subagents. */
@Composable
internal fun AgentRow(agent: AgentItem, detail: Detail, now: Long, open: Action, width: Float) {
    val lineWidth = width - INDENT.value
    val context = LocalContext.current
    val state = WidgetFormat.state(agent.state)
    val muted = GlanceTheme.colors.onSurfaceVariant
    Column(modifier = GlanceModifier.fillMaxWidth().padding(bottom = Heights.GAP.dp).clickable(open)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = GlanceModifier.fillMaxWidth()) {
            Dot(agentColor(agent.color))
            Spacer(GlanceModifier.width(6.dp))
            Text(
                WidgetFormat.clip(agent.title, WidgetFormat.charsFor(lineWidth - META_DP, 14f)),
                maxLines = 1,
                style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 14.sp, fontWeight = FontWeight.Medium),
                modifier = GlanceModifier.defaultWeight(),
            )
            meta(agent, now)?.let {
                Text(it, maxLines = 1, style = TextStyle(color = muted, fontSize = 11.sp, fontWeight = FontWeight.Medium))
            }
        }
        val activity = WidgetFormat.activity(agent)
        val pr = agent.pr
        val prInstead = detail == Detail.COMPACT && pr != null && (activity == Activity.Idle || activity == Activity.Done)
        Text(
            WidgetFormat.clip(
                if (prInstead && pr != null) prText(context, pr) else activityText(context, activity),
                WidgetFormat.charsFor(lineWidth, 12f),
            ),
            maxLines = 1,
            style = TextStyle(
                color = if (prInstead && pr != null) signalColor(WidgetFormat.signal(pr)) else stateColor(state),
                fontSize = 12.sp,
            ),
            modifier = GlanceModifier.padding(start = INDENT),
        )
        if (detail == Detail.FULL) {
            agent.pr?.let { SmallLine(prText(context, it), signalColor(WidgetFormat.signal(it)), lineWidth) }
            agent.subagents.forEach { sub ->
                val text = listOfNotNull(sub.label, sub.tool).joinToString(" \u00b7 ")
                SmallLine("\u21b3 $text", muted, lineWidth)
            }
            if (agent.moreSubagents > 0) {
                SmallLine(plural(R.plurals.widget_more_subagents, agent.moreSubagents), muted, lineWidth)
            }
        }
    }
}
