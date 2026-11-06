package dev.seti.android

import dev.seti.android.api.Pairing
import dev.seti.android.data.Freshness
import dev.seti.android.data.SetiState
import dev.seti.android.pairing.PairLink
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LaunchRouterTest {
    private val base = "https://seti.example.com/".toHttpUrl()
    private val paired = SetiState(pairing = Pairing(base, "dev-1", "alias"))

    @Test
    fun firstRunAsksToPair() {
        assertEquals(Launch.Pair(PairReason.FIRST_RUN, null), LaunchRouter.decide(null, null, SetiState()))
    }

    @Test
    fun launcherOpensSetiHome() {
        assertEquals(Launch.Open(base), LaunchRouter.decide("android.intent.action.MAIN", null, paired))
    }

    @Test
    fun agentAppLinksOpenTheAgentRoute() {
        val link = "https://seti.example.com/agent/abc-123".toHttpUrl()
        val open = LaunchRouter.decide("android.intent.action.VIEW", link, paired) as Launch.Open
        assertEquals("https://seti.example.com/#agents/abc-123", open.url.toString())
    }

    @Test
    fun widgetUrlsOnThePairedOriginOpenAsIs() {
        val url = SetiRoutes.url(base, SetiRoutes.NEW_AGENT)
        assertEquals(Launch.Open(url), LaunchRouter.decide("android.intent.action.VIEW", url, paired))
        assertEquals("https://seti.example.com/#agents/new", url.toString())
        assertEquals("https://seti.example.com/#ea", SetiRoutes.url(base, SetiRoutes.EA).toString())
    }

    @Test
    fun foreignOriginsFallBackToHome() {
        val other = "https://elsewhere.example/whatever".toHttpUrl()
        assertEquals(Launch.Open(base), LaunchRouter.decide("android.intent.action.VIEW", other, paired))
    }

    @Test
    fun pairLinksAlwaysShowPairing() {
        val link = "https://seti.example.com/pair#code=XYZ".toHttpUrl()
        assertEquals(Launch.Pair(PairReason.LINK, link.toString()), LaunchRouter.decide(null, link, paired))
    }

    @Test
    fun pairShortcutExplainsRepair() {
        val state = paired.copy(needsRepair = true)
        assertEquals(
            Launch.Pair(PairReason.NEEDS_REPAIR, base.toString()),
            LaunchRouter.decide(LaunchRouter.ACTION_PAIR, null, state),
        )
    }

    @Test
    fun pairLinkParsing() {
        val fragment = PairLink.parse("https://seti.example.com/pair#code=AB12")
        assertEquals(base, fragment?.baseUrl)
        assertEquals("AB12", fragment?.code)
        assertEquals("q1", PairLink.parse("https://seti.example.com/pair?code=q1")?.code)
        assertEquals(base, PairLink.parse(" seti.example.com ")?.baseUrl)
        assertNull(PairLink.parse("seti.example.com")?.code)
        assertNull(PairLink.parse("http://seti.example.com"))
        assertEquals("http://localhost:3006/".toHttpUrl(), PairLink.parse("http://localhost:3006/x")?.baseUrl)
        assertNull(PairLink.parse(""))
    }

    @Test
    fun freshness() {
        val now = 10_000_000L
        assertEquals(Freshness.STALE, SetiState().freshness(now))
        assertEquals(Freshness.FRESH, SetiState(fetchedAt = now - 60_000).freshness(now))
        assertEquals(Freshness.STALE, SetiState(fetchedAt = now - SetiState.STALE_AFTER_MS - 1).freshness(now))
        assertEquals(Freshness.OFFLINE, SetiState(fetchedAt = now - 60_000, failedAt = now).freshness(now))
        assertEquals(Freshness.OFFLINE, SetiState(failedAt = now).freshness(now))
    }
}
