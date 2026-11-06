package dev.seti.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SetiStateTest {
    private val now = 10_000_000L

    @Test
    fun aFailureNewerThanTheLastSummaryIsOffline() {
        assertEquals(Freshness.OFFLINE, SetiState(failedAt = now - 1000).freshness(now))
        assertEquals(Freshness.OFFLINE, SetiState(fetchedAt = now - 5000, failedAt = now - 1000).freshness(now))
        assertEquals(Freshness.FRESH, SetiState(fetchedAt = now - 1000, failedAt = now - 5000).freshness(now))
    }

    @Test
    fun refreshingLastsUntilARefreshSettlesOrTwoMinutesPass() {
        assertTrue(SetiState(refreshingAt = now - 1000).refreshing(now))
        assertTrue(SetiState(fetchedAt = now - 5000, refreshingAt = now - 1000).refreshing(now))
        assertFalse(SetiState(failedAt = now - 500, refreshingAt = now - 1000).refreshing(now))
        assertFalse(SetiState(fetchedAt = now - 500, refreshingAt = now - 1000).refreshing(now))
        assertFalse(SetiState(refreshingAt = now - SetiState.REFRESHING_FOR_MS).refreshing(now))
        assertFalse(SetiState().refreshing(now))
    }
}
