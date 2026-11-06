package dev.seti.android.data

import dev.seti.android.api.Pairing
import dev.seti.android.api.WidgetSummary

enum class Freshness { FRESH, STALE, OFFLINE }

/** What the app knows: the pairing, the last widget summary and how the last refresh went. */
data class SetiState(
    val pairing: Pairing? = null,
    val needsRepair: Boolean = false,
    val summary: WidgetSummary? = null,
    val fetchedAt: Long? = null,
    val failedAt: Long? = null,
    val problem: Problem? = null,
    val refreshingAt: Long? = null,
) {
    val paired: Boolean get() = pairing != null && !needsRepair

    fun freshness(now: Long): Freshness {
        val fetched = fetchedAt
        return when {
            failedAt != null && (fetched == null || failedAt > fetched) -> Freshness.OFFLINE
            fetched == null || now - fetched > STALE_AFTER_MS -> Freshness.STALE
            else -> Freshness.FRESH
        }
    }

    /** A refresh was asked for recently and has not finished yet. */
    fun refreshing(now: Long): Boolean {
        val asked = refreshingAt ?: return false
        val settled = maxOf(fetchedAt ?: 0, failedAt ?: 0)
        return asked > settled && now - asked < REFRESHING_FOR_MS
    }

    companion object {
        const val STALE_AFTER_MS = 40L * 60 * 1000
        const val REFRESHING_FOR_MS = 2L * 60 * 1000
    }
}
