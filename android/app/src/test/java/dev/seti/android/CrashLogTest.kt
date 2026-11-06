package dev.seti.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.time.Instant

class CrashLogTest {
    @get:Rule
    val folder = TemporaryFolder()

    @Test
    fun formatCarriesTheDeviceThreadAndStackTrace() {
        val error = IllegalStateException("boom", NullPointerException("inner"))
        val text = CrashLog.format("Seti for Android 0.1.0 (1)", Thread("main"), error, Instant.EPOCH)
        assertTrue(text.startsWith("Seti for Android 0.1.0 (1)\nTime: 1970-01-01T00:00:00Z\nThread: main\n"))
        assertTrue(text.contains("java.lang.IllegalStateException: boom"))
        assertTrue(text.contains("Caused by: java.lang.NullPointerException: inner"))
        assertTrue(text.contains("at dev.seti.android.CrashLogTest.formatCarriesTheDeviceThreadAndStackTrace"))
    }

    @Test
    fun recordsTheLastCrashUntilCleared() {
        val log = CrashLog(folder.root.resolve("last-crash.txt"))
        assertNull(log.read())

        log.record("about", Thread("worker"), RuntimeException("first"))
        log.record("about", Thread("worker"), RuntimeException("second"))
        val trace = log.read()
        assertTrue(trace.orEmpty().contains("RuntimeException: second"))
        assertFalse(trace.orEmpty().contains("first"))

        log.clear()
        assertNull(log.read())
    }
}
