package dev.seti.android.data

import dev.seti.android.api.ApiException
import dev.seti.android.api.BadReplyException
import dev.seti.android.api.RedirectedException
import dev.seti.android.api.UnauthorizedException
import java.io.IOException
import java.security.GeneralSecurityException
import kotlin.coroutines.cancellation.CancellationException

/** Why the last widget refresh failed, kept so the widget can say it. */
sealed interface Problem {
    /** No answer: no network, a DNS or TLS failure, or a timeout. */
    data object Unreachable : Problem

    /** Something in front of Seti redirected the request, such as a sign-in proxy. */
    data object Redirected : Problem

    /** Seti answered, but not with a summary the app can read. */
    data object BadReply : Problem

    /** Seti or a proxy in front of it answered with this HTTP status. */
    data class Status(val code: Int) : Problem

    /** Seti no longer accepts this phone's key. */
    data object SignedOut : Problem

    /** The phone's device key is gone or unusable. */
    data object KeyLost : Problem

    /** Only pairing again fixes these. */
    val needsRepair: Boolean get() = this == SignedOut || this == KeyLost

    fun encode(): String = when (this) {
        Unreachable -> UNREACHABLE
        Redirected -> REDIRECTED
        BadReply -> BAD_REPLY
        SignedOut -> SIGNED_OUT
        KeyLost -> KEY_LOST
        is Status -> "$STATUS$code"
    }

    companion object {
        private const val UNREACHABLE = "unreachable"
        private const val REDIRECTED = "redirected"
        private const val BAD_REPLY = "bad_reply"
        private const val SIGNED_OUT = "signed_out"
        private const val KEY_LOST = "key_lost"
        private const val STATUS = "status:"

        fun decode(value: String?): Problem? = when (value) {
            null -> null
            UNREACHABLE -> Unreachable
            REDIRECTED -> Redirected
            BAD_REPLY -> BadReply
            SIGNED_OUT -> SignedOut
            KEY_LOST -> KeyLost
            else -> value.removePrefix(STATUS).takeIf { value.startsWith(STATUS) }?.toIntOrNull()?.let(::Status)
        }

        /** The problem a refresh failure stands for; null for failures the worker should not catch. */
        fun of(e: Exception): Problem? = when (e) {
            is UnauthorizedException -> SignedOut
            is RedirectedException -> Redirected
            is BadReplyException -> BadReply
            is ApiException -> Status(e.status)
            is IOException -> Unreachable
            is GeneralSecurityException -> KeyLost
            is CancellationException -> null
            is IllegalStateException -> KeyLost
            else -> null
        }
    }
}
