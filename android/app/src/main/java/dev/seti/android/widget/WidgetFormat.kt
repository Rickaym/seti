package dev.seti.android.widget

import dev.seti.android.api.AgentItem
import dev.seti.android.api.PrItem
import java.util.Locale

/** How an overview row reads its agent's state. */
enum class AgentState { RUNNING, WAITING, FAILED, COMPLETE, IDLE }

/** What a PR chip says, most urgent first. */
enum class PrSignal { CI_FAILING, REVIEWS, CI_PENDING, CI_PASSING, OPEN, MERGED, CLOSED }

/** The second line of an overview row, before it is put into words. */
sealed interface Activity {
    /** Text Seti already wrote: a status line, todo step or waiting reason, maybe with the tool in use. */
    data class Said(val text: String, val tool: String?) : Activity

    /** Running a tool, with nothing else said. */
    data class Using(val tool: String) : Activity

    data object Working : Activity
    data object Failed : Activity
    data object Done : Activity
    data object Idle : Activity
}

/** Pure formatting and layout rules for the widgets, kept apart from Glance so tests reach them. */
object WidgetFormat {
    const val ELLIPSIS = "\u2026"

    fun state(value: String): AgentState = when (value) {
        "running" -> AgentState.RUNNING
        "waiting" -> AgentState.WAITING
        "failed" -> AgentState.FAILED
        "complete" -> AgentState.COMPLETE
        else -> AgentState.IDLE
    }

    fun activity(agent: AgentItem): Activity {
        val text = agent.activity?.takeIf { it.isNotBlank() }
        val tool = agent.tool?.takeIf { it.isNotBlank() }
        return when {
            text != null -> Activity.Said(text, tool)
            tool != null -> Activity.Using(tool)
            else -> when (state(agent.state)) {
                AgentState.RUNNING, AgentState.WAITING -> Activity.Working
                AgentState.FAILED -> Activity.Failed
                AgentState.COMPLETE -> Activity.Done
                AgentState.IDLE -> Activity.Idle
            }
        }
    }

    /** Cuts text to `max` characters at a word break when one is near, ending in an ellipsis. */
    fun clip(text: String, max: Int): String {
        val flat = text.replace(Regex("\\s+"), " ").trim()
        if (flat.length <= max) return flat
        val cut = flat.take(max - 1)
        val space = cut.lastIndexOf(' ')
        val head = if (space >= max / 2) cut.take(space) else cut
        return head.trimEnd(' ', ',', '.', ':', ';') + ELLIPSIS
    }

    /** Roughly how many characters of text at `fontSp` fit across `widthDp`, for clipping lines. */
    fun charsFor(widthDp: Float, fontSp: Float): Int = (widthDp / (fontSp * 0.47f)).toInt().coerceAtLeast(4)

    /** A wait or age in one short token: `now`, `4m`, `2h`, `3d`. */
    fun age(sinceMillis: Long, now: Long): String {
        val minutes = (now - sinceMillis).coerceAtLeast(0) / 60_000
        return when {
            minutes < 1 -> "now"
            minutes < 60 -> "${minutes}m"
            minutes < 48 * 60 -> "${minutes / 60}h"
            else -> "${minutes / (24 * 60)}d"
        }
    }

    fun progress(done: Int, total: Int): String = "$done/$total"

    fun signal(pr: PrItem): PrSignal = when {
        pr.state == "merged" -> PrSignal.MERGED
        pr.state == "closed" -> PrSignal.CLOSED
        pr.ci == "failure" -> PrSignal.CI_FAILING
        pr.unresolvedThreads > 0 -> PrSignal.REVIEWS
        pr.ci == "pending" -> PrSignal.CI_PENDING
        pr.ci == "success" -> PrSignal.CI_PASSING
        else -> PrSignal.OPEN
    }

    /** `#rrggbb` as an opaque ARGB int, or null for anything else. */
    fun color(hex: String?): Int? {
        if (hex == null || !Regex("^#[0-9a-fA-F]{6}$").matches(hex)) return null
        return (0xFF000000 or hex.substring(1).toLong(16)).toInt()
    }

    fun cost(usd: Double): String = String.format(Locale.US, "$%.2f", usd)

    /** How many of `heights` fit in `budget`, in order; at least one whenever there is one. */
    fun fit(heights: List<Int>, budget: Int): Int {
        var used = 0
        var shown = 0
        for (height in heights) {
            if (used + height > budget) break
            used += height
            shown += 1
        }
        return shown.coerceAtLeast(minOf(1, heights.size))
    }
}
