package dev.seti.android

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsCallback
import androidx.browser.trusted.TrustedWebActivityIntentBuilder
import androidx.browser.trusted.sharing.ShareData
import androidx.browser.trusted.sharing.ShareTarget
import androidx.core.net.toUri
import com.google.androidbrowserhelper.trusted.LauncherActivity
import com.google.androidbrowserhelper.trusted.SessionStore
import com.google.androidbrowserhelper.trusted.SharedPreferencesTokenStore
import com.google.androidbrowserhelper.trusted.SharingUtils
import com.google.androidbrowserhelper.trusted.TwaLauncher
import com.google.androidbrowserhelper.trusted.splashscreens.SplashScreenStrategy
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Opens a URL on the paired origin in a TWA. There is no build-time default URL: Chrome verifies
 * the origin from its own assetlinks.json and shows a Custom Tab when that does not name this app.
 * A share intent also carries its files and text, which Chrome posts to Seti's share target.
 */
class TwaActivity : LauncherActivity() {

    override fun getLaunchingUrl(): Uri = intent.data ?: error("TwaActivity needs a URL")

    override fun createTwaLauncher(): TwaLauncher = ShareLauncher(this, sharedPost())

    private fun sharedPost(): Pair<ShareTarget, ShareData>? {
        val shared = SharingUtils.retrieveShareDataFromIntent(intent) ?: return null
        val origin = intent.data?.toString()?.toHttpUrlOrNull() ?: return null
        val data = SharePost.data(shared, ::isTrustedContentUri) ?: return null
        return SharePost.target(origin) to data
    }

    companion object {
        fun open(context: Context, url: HttpUrl) {
            context.startActivity(Intent(context, TwaActivity::class.java).setData(url.toString().toUri()))
        }

        fun share(context: Context, share: Intent, url: HttpUrl) {
            context.startActivity(SharePost.forward(context, share, url))
        }
    }
}

/** The library's launcher, plus the share target and items for a launch that shares. */
private class ShareLauncher(
    activity: Activity,
    private val post: Pair<ShareTarget, ShareData>?,
) : TwaLauncher(
    activity,
    null,
    SessionStore.makeSessionId(activity.taskId),
    SharedPreferencesTokenStore(activity),
) {
    override fun launch(
        builder: TrustedWebActivityIntentBuilder,
        callback: CustomTabsCallback?,
        splash: SplashScreenStrategy?,
        onLaunched: Runnable?,
        fallback: TwaLauncher.FallbackStrategy,
    ) {
        post?.let { (target, data) -> builder.setShareParams(target, data) }
        super.launch(builder, callback, splash, onLaunched, fallback)
    }
}
