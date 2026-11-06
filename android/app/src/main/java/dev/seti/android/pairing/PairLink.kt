package dev.seti.android.pairing

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** What the user typed or scanned: the Seti origin and, from a pairing link, its code. */
data class PairTarget(val baseUrl: HttpUrl, val code: String?)

object PairLink {
    private val LOCAL_HOSTS = setOf("localhost", "127.0.0.1", "10.0.2.2")

    /** Parses a Seti URL or a `https://<host>/pair#code=<code>` link; null when it is not usable. */
    fun parse(input: String): PairTarget? {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) return null
        val withScheme = if ("://" in trimmed) trimmed else "https://$trimmed"
        val url = withScheme.toHttpUrlOrNull() ?: return null
        if (url.scheme != "https" && url.host !in LOCAL_HOSTS) return null
        val code = codeFrom(url)
        return PairTarget(origin(url), code)
    }

    fun isPairLink(url: HttpUrl): Boolean = url.encodedPath.trimEnd('/') == "/pair"

    /** The origin of `url`: scheme, host and port with the root path. */
    fun origin(url: HttpUrl): HttpUrl = url.newBuilder().encodedPath("/").query(null).fragment(null).build()

    private fun codeFrom(url: HttpUrl): String? {
        if (!isPairLink(url)) return null
        val fromFragment = url.fragment?.split('&')
            ?.map { it.split('=', limit = 2) }
            ?.firstOrNull { it.size == 2 && it[0] == "code" }
            ?.get(1)
        return (fromFragment ?: url.queryParameter("code"))?.takeIf { it.isNotBlank() }
    }
}
