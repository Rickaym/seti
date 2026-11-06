package dev.seti.android.widget

import androidx.work.NetworkType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RefreshTest {
    @Test
    fun aRefreshNowRequiresANetworkSoBackgroundJobsMayUseIt() {
        val spec = Refresh.nowRequest(sdk = 36).workSpec
        assertEquals(NetworkType.CONNECTED, spec.constraints.requiredNetworkType)
        assertTrue(spec.expedited)
    }

    @Test
    fun beforeAndroid12ARefreshIsNotExpedited() {
        val spec = Refresh.nowRequest(sdk = 30).workSpec
        assertEquals(NetworkType.CONNECTED, spec.constraints.requiredNetworkType)
        assertFalse(spec.expedited)
    }
}
