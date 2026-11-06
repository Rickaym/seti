package dev.seti.android.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** An agent that waits on the user; `line` says why, as Seti's notifications do. */
@Serializable
data class NeedsYouItem(
    @SerialName("task_id") val taskId: String,
    val title: String,
    val reason: String,
    val since: String,
    val line: String = "",
    val color: String? = null,
)

@Serializable
data class SubagentItem(val label: String, val tool: String? = null)

@Serializable
data class TodoCount(val done: Int, val total: Int)

/** The agent's most telling PR; `label` is null while the device hides names. */
@Serializable
data class PrItem(
    val label: String? = null,
    val state: String = "open",
    val ci: String? = null,
    @SerialName("unresolved_threads") val unresolvedThreads: Int = 0,
    val more: Int = 0,
)

/** One agent in the overview: running, waiting, failed, complete or idle. */
@Serializable
data class AgentItem(
    @SerialName("task_id") val taskId: String,
    val title: String,
    val color: String? = null,
    val state: String = "idle",
    val activity: String? = null,
    val tool: String? = null,
    val todos: TodoCount? = null,
    val subagents: List<SubagentItem> = emptyList(),
    @SerialName("more_subagents") val moreSubagents: Int = 0,
    val pr: PrItem? = null,
    val workspace: String? = null,
    val since: String = "",
)

@Serializable
data class WidgetSummary(
    @SerialName("needs_you") val needsYou: List<NeedsYouItem> = emptyList(),
    @SerialName("needs_you_count") val needsYouTotal: Int? = null,
    val agents: List<AgentItem> = emptyList(),
    val running: Int = 0,
    val idle: Int = 0,
    @SerialName("cost_today_usd") val costTodayUsd: Double = 0.0,
    @SerialName("names_hidden") val namesHidden: Boolean = false,
    @SerialName("updated_at") val updatedAt: String,
) {
    /** Every waiting agent, listed or not; an older Seti lists them all. */
    val needsYouCount: Int get() = maxOf(needsYouTotal ?: 0, needsYou.size)
}

@Serializable
internal data class PairRequest(
    val code: String,
    val name: String,
    val platform: String,
    @SerialName("public_key") val publicKey: String,
)

@Serializable
internal data class PairResponse(@SerialName("device_id") val deviceId: String)

/** Seti's success body: `{"data": ..., "meta": {...}}`. */
@Serializable
internal data class Envelope<T>(val data: T)

@Serializable
internal data class ErrorDetail(val title: String? = null, val detail: String? = null)

@Serializable
internal data class ErrorBody(val error: ErrorDetail? = null)

val SetiJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
}
