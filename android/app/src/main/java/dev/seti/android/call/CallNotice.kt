package dev.seti.android.call

/** The web notification a live EA call shows; Chrome ends its platform tag with the web tag. */
object CallNotice {
    const val TAG = "seti-ea-call"

    fun isCall(platformTag: String): Boolean = platformTag.endsWith(TAG)
}
