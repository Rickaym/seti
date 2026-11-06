package dev.seti.android.auth

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import java.util.Base64
import java.util.UUID

/** Signs bytes with SHA256withECDSA on P-256 and returns the DER signature JCA produces. */
fun interface DerSigner {
    fun sign(data: ByteArray): ByteArray
}

/** Builds the per-request `SetiDevice` proof: a compact ES256 JWS bound to method and URL. */
object DeviceProof {
    const val SCHEME = "SetiDevice"
    private const val COORDINATE_BYTES = 32
    private val base64 = Base64.getUrlEncoder().withoutPadding()

    fun authorization(
        deviceId: String,
        method: String,
        url: HttpUrl,
        signer: DerSigner,
        nowSeconds: Long = System.currentTimeMillis() / 1000,
        jti: String = UUID.randomUUID().toString(),
    ): String = "$SCHEME ${create(deviceId, method, url, signer, nowSeconds, jti)}"

    fun create(
        deviceId: String,
        method: String,
        url: HttpUrl,
        signer: DerSigner,
        nowSeconds: Long,
        jti: String,
    ): String {
        val header = buildJsonObject {
            put("alg", "ES256")
            put("typ", "seti-device+jwt")
            put("kid", deviceId)
        }
        val claims = buildJsonObject {
            put("htm", method.uppercase())
            put("htu", htu(url))
            put("iat", nowSeconds)
            put("jti", jti)
        }
        val signingInput = "${encode(header.toString().toByteArray())}.${encode(claims.toString().toByteArray())}"
        val signature = derToJose(signer.sign(signingInput.toByteArray(Charsets.US_ASCII)))
        return "$signingInput.${encode(signature)}"
    }

    /** Scheme, host, a non-default port and path; no query or fragment. */
    fun htu(url: HttpUrl): String {
        val defaultPort = HttpUrl.defaultPort(url.scheme)
        val port = if (url.port == defaultPort) "" else ":${url.port}"
        val host = if (url.host.contains(':')) "[${url.host}]" else url.host
        return "${url.scheme}://$host$port${url.encodedPath}"
    }

    fun encode(bytes: ByteArray): String = base64.encodeToString(bytes)

    /** Converts an ASN.1 DER ECDSA signature to the fixed-size r||s form JWS requires. */
    fun derToJose(der: ByteArray, size: Int = COORDINATE_BYTES): ByteArray {
        var pos = 0
        require(der[pos++] == 0x30.toByte()) { "Not a DER sequence" }
        pos += lengthBytes(der, pos)
        val out = ByteArray(size * 2)
        for (part in 0..1) {
            require(der[pos++] == 0x02.toByte()) { "Not a DER integer" }
            val length = readLength(der, pos)
            pos += lengthBytes(der, pos)
            var start = pos
            var count = length
            while (count > size && der[start] == 0.toByte()) {
                start++
                count--
            }
            require(count <= size) { "Integer too long" }
            System.arraycopy(der, start, out, part * size + (size - count), count)
            pos += length
        }
        return out
    }

    private fun lengthBytes(der: ByteArray, pos: Int): Int {
        val first = der[pos].toInt() and 0xff
        return if (first < 0x80) 1 else 1 + (first and 0x7f)
    }

    private fun readLength(der: ByteArray, pos: Int): Int {
        val first = der[pos].toInt() and 0xff
        if (first < 0x80) return first
        var length = 0
        for (i in 1..(first and 0x7f)) {
            length = (length shl 8) or (der[pos + i].toInt() and 0xff)
        }
        return length
    }
}
