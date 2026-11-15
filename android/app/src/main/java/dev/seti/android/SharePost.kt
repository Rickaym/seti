package dev.seti.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.trusted.sharing.ShareData
import androidx.browser.trusted.sharing.ShareTarget
import androidx.core.net.toUri
import okhttp3.HttpUrl

/**
 * Seti's web share target on the paired origin. The app works with any server, so the target is
 * built at launch from the pairing instead of the manifest's static share target metadata.
 */
object SharePost {
    const val PATH = "/share-target"

    fun target(base: HttpUrl): ShareTarget = ShareTarget(
        base.resolve(PATH).toString(),
        ShareTarget.METHOD_POST,
        ShareTarget.ENCODING_TYPE_MULTIPART,
        ShareTarget.Params("title", "text", listOf(ShareTarget.FileFormField("files", listOf("*/*")))),
    )

    /** The shared items to post, with only the files this app may read; null when nothing is left. */
    fun data(shared: ShareData, readable: (Uri) -> Boolean): ShareData? {
        val uris = shared.uris?.filter(readable)?.ifEmpty { null }
        if (uris == null && shared.title.isNullOrEmpty() && shared.text.isNullOrEmpty()) return null
        return ShareData(shared.title, shared.text, uris)
    }

    /** Hands a share intent to the TWA at `url`, passing on read access to the shared files. */
    fun forward(context: Context, share: Intent, url: HttpUrl): Intent =
        Intent(context, TwaActivity::class.java).apply {
            action = share.action
            setDataAndType(url.toString().toUri(), share.type)
            share.extras?.let(::putExtras)
            clipData = share.clipData
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
}
