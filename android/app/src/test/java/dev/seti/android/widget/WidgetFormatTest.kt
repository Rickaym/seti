package dev.seti.android.widget

import dev.seti.android.api.AgentItem
import dev.seti.android.api.PrItem
import dev.seti.android.api.SetiJson
import dev.seti.android.api.WidgetSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetFormatTest {
    private val now = 1_000_000_000L

    private fun agent(state: String, activity: String? = null, tool: String? = null) =
        AgentItem(taskId = "a", title = "Ship it", state = state, activity = activity, tool = tool)

    @Test
    fun clipCutsAtAWordBreakAndEndsInAnEllipsis() {
        assertEquals("Short", WidgetFormat.clip("  Short ", 20))
        assertEquals("Fix the flaky…", WidgetFormat.clip("Fix the flaky widget test today", 16))
        assertEquals("abcdefghi…", WidgetFormat.clip("abcdefghijklmnop", 10))
        assertEquals("a b", WidgetFormat.clip("a\n\tb", 10))
    }

    @Test
    fun charsForScalesWithWidthAndFontSize() {
        assertEquals(45, WidgetFormat.charsFor(256f, 12f))
        assertEquals(38, WidgetFormat.charsFor(256f, 14f))
        assertEquals(4, WidgetFormat.charsFor(10f, 12f))
    }

    @Test
    fun ageIsOneShortToken() {
        assertEquals("now", WidgetFormat.age(now - 30_000, now))
        assertEquals("now", WidgetFormat.age(now + 60_000, now))
        assertEquals("4m", WidgetFormat.age(now - 4 * 60_000, now))
        assertEquals("2h", WidgetFormat.age(now - 125 * 60_000, now))
        assertEquals("47h", WidgetFormat.age(now - 47 * 3_600_000L, now))
        assertEquals("3d", WidgetFormat.age(now - 72 * 3_600_000L, now))
    }

    @Test
    fun activityPrefersWhatSetiSaidThenTheToolThenTheState() {
        assertEquals(Activity.Said("Writing tests", "Bash"), WidgetFormat.activity(agent("running", "Writing tests", "Bash")))
        assertEquals(Activity.Using("Bash"), WidgetFormat.activity(agent("running", " ", "Bash")))
        assertEquals(Activity.Working, WidgetFormat.activity(agent("running")))
        assertEquals(Activity.Failed, WidgetFormat.activity(agent("failed")))
        assertEquals(Activity.Done, WidgetFormat.activity(agent("complete")))
        assertEquals(Activity.Idle, WidgetFormat.activity(agent("stopped")))
    }

    @Test
    fun aFailingPrOutranksReviewsAndALandedPrIgnoresCi() {
        assertEquals(PrSignal.CI_FAILING, WidgetFormat.signal(PrItem(ci = "failure", unresolvedThreads = 2)))
        assertEquals(PrSignal.REVIEWS, WidgetFormat.signal(PrItem(ci = "pending", unresolvedThreads = 1)))
        assertEquals(PrSignal.CI_PENDING, WidgetFormat.signal(PrItem(ci = "pending")))
        assertEquals(PrSignal.CI_PASSING, WidgetFormat.signal(PrItem(ci = "success")))
        assertEquals(PrSignal.OPEN, WidgetFormat.signal(PrItem()))
        assertEquals(PrSignal.MERGED, WidgetFormat.signal(PrItem(state = "merged", ci = "failure")))
        assertEquals(PrSignal.CLOSED, WidgetFormat.signal(PrItem(state = "closed")))
    }

    @Test
    fun colorReadsOnlyHexTriplets() {
        assertEquals(0xFF5488EC.toInt(), WidgetFormat.color("#5488ec"))
        assertNull(WidgetFormat.color("blue"))
        assertNull(WidgetFormat.color("#fff"))
        assertNull(WidgetFormat.color(null))
    }

    @Test
    fun fitShowsTheRowsThatFitInOrderAndAlwaysOne() {
        assertEquals(3, WidgetFormat.fit(listOf(40, 40, 40), 120))
        assertEquals(2, WidgetFormat.fit(listOf(40, 40, 40), 119))
        assertEquals(1, WidgetFormat.fit(listOf(40, 90, 10), 100))
        assertEquals(1, WidgetFormat.fit(listOf(90, 40), 50))
        assertEquals(0, WidgetFormat.fit(emptyList(), 50))
    }

    @Test
    fun aSummaryFromAnOlderSetiStillReads() {
        val old = """{"needs_you":[{"task_id":"t","title":"T","reason":"asking","since":"2026-10-29T06:00:00Z"}],
            "running":2,"idle":1,"cost_today_usd":1.5,"updated_at":"2026-10-29T06:00:00Z"}"""
        val summary = SetiJson.decodeFromString(WidgetSummary.serializer(), old)
        assertEquals(1, summary.needsYouCount)
        assertTrue(summary.agents.isEmpty())
        assertFalse(summary.namesHidden)
        assertEquals("", summary.needsYou.single().line)
        assertEquals("$1.50", WidgetFormat.cost(summary.costTodayUsd))
    }

    @Test
    fun theWidgetsRefreshSoonerOnlyWhileAgentsRun() {
        val idle = WidgetSummary(needsYouTotal = 3, updatedAt = "x")
        assertFalse(Refresh.active(idle))
        assertTrue(Refresh.active(idle.copy(running = 1)))
    }
}
