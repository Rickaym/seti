package dev.seti.android.call

import android.app.Notification
import com.google.androidbrowserhelper.trusted.DelegationService

/** Shows Seti's web notifications as the app's own, and holds a live EA call's microphone. */
class SetiDelegationService : DelegationService() {

    override fun onNotifyNotificationWithChannel(
        platformTag: String,
        platformId: Int,
        notification: Notification,
        channelName: String,
    ): Boolean {
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
