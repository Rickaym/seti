package dev.seti.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.net.toUri
import com.google.androidbrowserhelper.trusted.LauncherActivity
import okhttp3.HttpUrl

/**
 * Opens a URL on the paired origin in a TWA. There is no build-time default URL: Chrome verifies
 * the origin from its own assetlinks.json and shows a Custom Tab when that does not name this app.
 */
class TwaActivity : LauncherActivity() {

    override fun getLaunchingUrl(): Uri = intent.data ?: error("TwaActivity needs a URL")

    companion object {
        fun open(context: Context, url: HttpUrl) {
            context.startActivity(Intent(context, TwaActivity::class.java).setData(url.toString().toUri()))
        }
    }
}
