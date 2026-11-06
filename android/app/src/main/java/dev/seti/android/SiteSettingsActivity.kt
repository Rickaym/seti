package dev.seti.android

import android.net.Uri
import androidx.core.net.toUri
import com.google.androidbrowserhelper.trusted.ManageDataLauncherActivity
import dev.seti.android.data.SetiStore
import kotlinx.coroutines.runBlocking

/** Chrome's site settings and storage for the paired Seti, whichever server that is. */
class SiteSettingsActivity : ManageDataLauncherActivity() {

    override fun getDefaultUrlForManagingSpace(): Uri? {
        val pairing = runBlocking { SetiStore(this@SiteSettingsActivity).current().pairing }
        return pairing?.baseUrl?.toString()?.toUri()
    }
}
