package dev.seti.android

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.browser.trusted.sharing.ShareData
import androidx.browser.trusted.sharing.ShareTarget
import androidx.test.core.app.ApplicationProvider
import dev.seti.android.api.Pairing
import dev.seti.android.data.SetiState
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class SharePostTest {
    private val base = "https://seti.example.com/".toHttpUrl()
    private val photo = Uri.parse("content://media/external/images/1")
    private val elsewhere = Uri.parse("content://other.app/secret")

    @Test
    fun theTargetIsTheShareTargetOnThePairedOrigin() {
        val target = SharePost.target(base)
        assertEquals("https://seti.example.com/share-target", target.action)
        assertEquals(ShareTarget.METHOD_POST, target.method)
        assertEquals(ShareTarget.ENCODING_TYPE_MULTIPART, target.encodingType)
        assertEquals("text", target.params.text)
        assertEquals(listOf("files"), target.params.files?.map { it.name })
    }

    @Test
    fun onlyReadableFilesGoAlong() {
        val shared = ShareData("Title", "Look", listOf(photo, elsewhere))
        val data = SharePost.data(shared) { it == photo }
        assertEquals(listOf(photo), data?.uris)
        assertEquals("Look", data?.text)
        assertNull(SharePost.data(ShareData(null, null, listOf(elsewhere))) { false })
        assertNull(SharePost.data(ShareData(null, "Link", listOf(elsewhere))) { false }?.uris)
    }

    @Test
    fun aShareOpensTheTwaOnThePairedOriginWithItsFiles() {
        val context = ApplicationProvider.getApplicationContext<Application>()
        val share = Intent(Intent.ACTION_SEND)
            .setType("image/png")
            .putExtra(Intent.EXTRA_STREAM, photo)
            .putExtra(Intent.EXTRA_TEXT, "Look")
        val launch = LaunchRouter.decide(share.action, null, SetiState(pairing = Pairing(base, "dev-1", "alias")))
        val url = (launch as Launch.Open).url
        val forwarded = SharePost.forward(context, share, url)
        assertEquals(TwaActivity::class.java.name, forwarded.component?.className)
        assertEquals(Intent.ACTION_SEND, forwarded.action)
        assertEquals("https://seti.example.com/", forwarded.data.toString())
        assertEquals("image/png", forwarded.type)
        assertEquals("Look", forwarded.getStringExtra(Intent.EXTRA_TEXT))
        assertTrue(forwarded.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
    }
}
