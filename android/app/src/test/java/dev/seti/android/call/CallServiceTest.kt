package dev.seti.android.call

import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class CallServiceTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val notifications = context.getSystemService(NotificationManager::class.java)
    private val tag = "p#https://seti.example#${CallNotice.TAG}"

    private fun postCall() {
        notifications.createNotificationChannel(NotificationChannel("web", "Web", NotificationManager.IMPORTANCE_LOW))
        val notification = Notification.Builder(context, "web").setContentTitle("Call with the EA").build()
        notifications.notify(tag, 3, notification)
    }

    private fun startFor(tag: String, id: Int) = Robolectric.buildService(
        CallService::class.java,
        Intent(context, CallService::class.java).putExtra(CallService.EXTRA_TAG, tag).putExtra(CallService.EXTRA_ID, id),
    ).create().startCommand(0, 1).get()

    @Test
    fun knowsTheCallNotificationByItsTag() {
        assertTrue(CallNotice.isCall(tag))
        assertFalse(CallNotice.isCall("p#https://seti.example#agent-7"))
    }

    @Test
    fun lendsTheBrowserItsCapabilitiesWhereAndroidHasThem() {
        val include = Context.BIND_INCLUDE_CAPABILITIES
        assertEquals(include, CallService.bindFlags(Build.VERSION_CODES.Q) and include)
        assertEquals(0, CallService.bindFlags(Build.VERSION_CODES.P) and include)
    }

    @Test
    fun holdsTheCallsOwnNotificationInTheForeground() {
        postCall()
        val service = startFor(tag, 3)
        val shown = shadowOf(service).lastForegroundNotification
        assertNotNull(shown)
        assertEquals("Call with the EA", shown?.extras?.getString(Notification.EXTRA_TITLE))
        assertEquals(CallService.FOREGROUND_ID, shadowOf(service).lastForegroundNotificationId)
        assertTrue(notifications.activeNotifications.none { it.tag == tag })
    }

    @Test
    fun stopsWithoutTheForegroundWhenTheNotificationIsGone() {
        val service = startFor(tag, 3)
        assertNull(shadowOf(service).lastForegroundNotification)
        assertTrue(shadowOf(service).isStoppedBySelf)
    }
}
