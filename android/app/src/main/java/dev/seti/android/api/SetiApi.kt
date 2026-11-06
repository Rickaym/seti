package dev.seti.android.api

import dev.seti.android.auth.DerSigner
import dev.seti.android.auth.DeviceProof
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/** The device key was revoked or the server no longer knows this device. */
class UnauthorizedException : IOException("Device not recognized")

/** The server answered with an error; `message` is its error title when it sent one. */
open class ApiException(val status: Int, message: String, cause: Throwable? = null) : IOException(message, cause)

/** Something in front of Seti redirected the request, such as a sign-in proxy. */
class RedirectedException(status: Int) : ApiException(status, REDIRECTED)

/** Seti answered with a body the app could not read. */
class BadReplyException(status: Int, cause: Throwable) : ApiException(status, "Unexpected response from Seti", cause)

private const val REDIRECTED = "Seti redirected the request; a proxy in front may block device requests"

/** A paired device: the Seti origin, the id the server gave it and its Keystore alias. */
data class Pairing(val baseUrl: HttpUrl, val deviceId: String, val keyAlias: String)

class SetiApi(private val http: OkHttpClient = defaultClient) {

    /** Registers the public key with a one-time pairing code and returns the new device id. */
    suspend fun pair(baseUrl: HttpUrl, code: String, name: String, publicKey: String): String {
        val body = SetiJson.encodeToString(PairRequest.serializer(), PairRequest(code, name, "android", publicKey))
        val request = Request.Builder()
            .url(baseUrl.resolve("/api/devices/pair") ?: error("Bad base URL"))
            .post(body.toRequestBody(JSON))
            .build()
        return call(request) { SetiJson.decodeFromString(Envelope.serializer(PairResponse.serializer()), it).data.deviceId }
    }

    suspend fun widgetSummary(pairing: Pairing, signer: DerSigner): WidgetSummary {
        val url = pairing.baseUrl.resolve("/api/widget/summary") ?: error("Bad base URL")
        val request = Request.Builder()
            .url(url)
            .header("Authorization", DeviceProof.authorization(pairing.deviceId, "GET", url, signer))
            .header("Accept", "application/json")
            .build()
        return call(request) { SetiJson.decodeFromString(Envelope.serializer(WidgetSummary.serializer()), it).data }
    }

    private suspend fun <T> call(request: Request, parse: (String) -> T): T = withContext(Dispatchers.IO) {
        http.newCall(request).execute().use { response ->
            val text = response.body.string()
            if (response.code == 401) throw UnauthorizedException()
            if (response.isRedirect) throw RedirectedException(response.code)
            if (!response.isSuccessful) throw ApiException(response.code, errorTitle(response, text))
            try {
                parse(text)
            } catch (e: IllegalArgumentException) {
                throw BadReplyException(response.code, e)
            }
        }
    }

    private fun errorTitle(response: Response, text: String): String {
        val title = runCatching { SetiJson.decodeFromString(ErrorBody.serializer(), text).error?.title }.getOrNull()
        return title ?: "Seti answered ${response.code}"
    }

    companion object {
        private val JSON = "application/json".toMediaType()

        val defaultClient: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .followRedirects(false)
                .build()
        }
    }
}
