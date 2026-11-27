package dev.seti.android.call

import android.app.Notification
import android.app.NotificationManager
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.browser.customtabs.CustomTabsService
import androidx.core.app.ServiceCompat
import com.google.androidbrowserhelper.trusted.TwaProviderPicker

/** Holds a live EA call as a microphone foreground service and lends the browser its capability. */
class CallService : Service() {
    private var browser: ServiceConnection? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val tag = intent?.getStringExtra(EXTRA_TAG)
        val id = intent?.getIntExtra(EXTRA_ID, 0) ?: 0
        val notification = tag?.let { posted(it, id) }
        if (tag == null || notification == null || !promote(notification)) {
            stopSelf()
            return START_NOT_STICKY
        }
        getSystemService(NotificationManager::class.java).cancel(tag, id)
        if (browser == null) {
            browser = bindBrowser()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        browser?.let(::unbindService)
        browser = null
        super.onDestroy()
    }

    private fun posted(tag: String, id: Int): Notification? =
        getSystemService(NotificationManager::class.java).activeNotifications
            .firstOrNull { it.tag == tag && it.id == id }
            ?.notification

    private fun promote(notification: Notification): Boolean =
        try {
            ServiceCompat.startForeground(this, FOREGROUND_ID, notification, microphoneType())
            true
        } catch (e: SecurityException) {
            Log.w(LOG_TAG, "The call could not hold the microphone", e)
            false
        } catch (e: IllegalStateException) {
            Log.w(LOG_TAG, "The call could not start in the foreground", e)
            false
        }

    private fun bindBrowser(): ServiceConnection? {
        val browserPackage = TwaProviderPicker.pickProvider(packageManager).provider ?: return null
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, service: IBinder?) = Unit

            override fun onServiceDisconnected(name: ComponentName?) = Unit
        }
        val intent = Intent(CustomTabsService.ACTION_CUSTOM_TABS_CONNECTION).setPackage(browserPackage)
        return if (bindService(intent, connection, bindFlags(Build.VERSION.SDK_INT))) connection else null
    }

    companion object {
        const val EXTRA_TAG = "dev.seti.android.call.TAG"
        const val EXTRA_ID = "dev.seti.android.call.ID"
        const val FOREGROUND_ID = 7301
        private const val LOG_TAG = "SetiCall"

        /** The browser gets this app's microphone capability while the call holds the service. */
        fun bindFlags(sdk: Int): Int =
            if (sdk >= Build.VERSION_CODES.Q) {
                BIND_AUTO_CREATE or BIND_INCLUDE_CAPABILITIES
            } else {
                BIND_AUTO_CREATE
            }

        private fun microphoneType(): Int =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0

        fun start(context: Context, tag: String, id: Int) {
            val intent = Intent(context, CallService::class.java).putExtra(EXTRA_TAG, tag).putExtra(EXTRA_ID, id)
            try {
                context.startService(intent)
            } catch (e: IllegalStateException) {
                Log.w(LOG_TAG, "Android refused the call service from the background", e)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CallService::class.java))
        }
    }
}
