package dev.seti.android

import okhttp3.HttpUrl

/** Seti UI routes; the web app routes by hash, so `/agent/<id>` links open `#agents/<id>`. */
object SetiRoutes {
    const val HOME = ""
    const val NEW_AGENT = "agents/new"
    const val EA = "ea"

    fun agent(taskId: String): String = "agents/$taskId"

    fun url(base: HttpUrl, route: String): HttpUrl =
        base.newBuilder().encodedPath("/").query(null).fragment(route.ifEmpty { null }).build()

    /** The UI route for an App Link path such as `/agent/<id>`, or null when it is not one. */
    fun fromAppLinkPath(segments: List<String>): String? {
        val parts = segments.filter { it.isNotEmpty() }
        return when {
            parts.size == 2 && parts[0] in setOf("agent", "agents") -> agent(parts[1])
            else -> null
        }
    }
}
