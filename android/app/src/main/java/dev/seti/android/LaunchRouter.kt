package dev.seti.android

import dev.seti.android.data.SetiState
import dev.seti.android.pairing.PairLink
import okhttp3.HttpUrl

enum class PairReason { FIRST_RUN, NEEDS_REPAIR, REQUESTED, LINK }

sealed interface Launch {
    /** Open this URL in the Trusted Web Activity. */
    data class Open(val url: HttpUrl) : Launch

    /** Show the pairing screen, prefilled with `link` when one came in. */
    data class Pair(val reason: PairReason, val link: String?) : Launch
}

/** Decides what a launch shows from its intent action and URL and the stored state. */
object LaunchRouter {
    const val ACTION_PAIR = "dev.seti.android.action.PAIR"

    fun decide(action: String?, data: HttpUrl?, state: SetiState): Launch {
        val pairing = state.pairing
        return when {
            action == ACTION_PAIR ->
                Launch.Pair(if (state.needsRepair) PairReason.NEEDS_REPAIR else PairReason.REQUESTED, pairing?.baseUrl?.toString())
            data != null && PairLink.isPairLink(data) -> Launch.Pair(PairReason.LINK, data.toString())
            pairing == null -> Launch.Pair(PairReason.FIRST_RUN, null)
            else -> Launch.Open(target(pairing.baseUrl, data))
        }
    }

    private fun target(base: HttpUrl, data: HttpUrl?): HttpUrl {
        if (data == null) return SetiRoutes.url(base, SetiRoutes.HOME)
        val route = SetiRoutes.fromAppLinkPath(data.pathSegments)
        val sameOrigin = PairLink.origin(data) == base
        return when {
            route != null -> SetiRoutes.url(base, route)
            sameOrigin -> data
            else -> SetiRoutes.url(base, SetiRoutes.HOME)
        }
    }
}
