package dev.seti.android.data

import dev.seti.android.api.ApiException
import dev.seti.android.api.BadReplyException
import dev.seti.android.api.RedirectedException
import dev.seti.android.api.UnauthorizedException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.UnknownHostException
import java.security.KeyStoreException
import kotlin.coroutines.cancellation.CancellationException

class ProblemTest {
    @Test
    fun failuresMapToShortReasons() {
        assertEquals(Problem.Unreachable, Problem.of(UnknownHostException("seti.example.com")))
        assertEquals(Problem.SignedOut, Problem.of(UnauthorizedException()))
        assertEquals(Problem.Redirected, Problem.of(RedirectedException(302)))
        assertEquals(Problem.BadReply, Problem.of(BadReplyException(200, IllegalArgumentException("x"))))
        assertEquals(Problem.Status(403), Problem.of(ApiException(403, "Forbidden")))
        assertEquals(Problem.KeyLost, Problem.of(KeyStoreException("gone")))
        assertEquals(Problem.KeyLost, Problem.of(IllegalStateException("No device key")))
    }

    @Test
    fun cancellationIsNotAProblem() {
        assertNull(Problem.of(CancellationException("replaced")))
        assertNull(Problem.of(RuntimeException("bug")))
    }

    @Test
    fun onlyKeyProblemsNeedRepair() {
        assertTrue(Problem.SignedOut.needsRepair)
        assertTrue(Problem.KeyLost.needsRepair)
        assertFalse(Problem.Unreachable.needsRepair)
        assertFalse(Problem.Status(500).needsRepair)
    }

    @Test
    fun problemsSurviveStorage() {
        val all = listOf(
            Problem.Unreachable,
            Problem.Redirected,
            Problem.BadReply,
            Problem.SignedOut,
            Problem.KeyLost,
            Problem.Status(502),
        )
        all.forEach { assertEquals(it, Problem.decode(it.encode())) }
        assertNull(Problem.decode(null))
        assertNull(Problem.decode("status:x"))
        assertNull(Problem.decode("something else"))
    }
}
