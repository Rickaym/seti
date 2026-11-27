package dev.seti.android.call

import android.Manifest
import android.app.Notification
import android.content.pm.PackageManager
import android.os.Build
import com.google.androidbrowserhelper.trusted.DelegationService

/** Shows Seti's web notifications as the app's own, and holds a live EA call's microphone. */
class SetiDelegationService : DelegationService() {

    override fun onNotifyNotificationWithChannel(
        platformTag: String,
        platformId: Int,
        notification: Notification,
        channelName: String,
    ): Boolean {
        val allowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (!allowed) {
            return false
        }
        val shown = super.onNotifyNotificationWithChannel(platformTag, platformId, notification, channelName)
        if (shown && CallNotice.isCall(platformTag)) {
            CallService.start(this, platformTag, platformId)
        }
        return shown
    }

    override fun onCancelNotification(platformTag: String, platformId: Int) {
        super.onCancelNotification(platformTag, platformId)
        if (CallNotice.isCall(platformTag)) {
            CallService.stop(this)
        }
    }
}
