package dev.seti.android.auth

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

class DeviceProofTest {
    private val keys: KeyPair = KeyPairGenerator.getInstance("EC").run {
        initialize(ECGenParameterSpec("secp256r1"))
        generateKeyPair()
    }
    private val signer = SoftwareSigner(keys)

    @Test
    fun proofCarriesHeaderAndClaims() {
        val url = "https://seti.example.com/api/widget/summary?x=1#frag".toHttpUrl()
        val proof = DeviceProof.create("dev-1", "get", url, signer, 1_700_000_000, "jti-1")
        val (header, claims, _) = proof.split('.')

        assertEquals(
            mapOf("alg" to "ES256", "typ" to "seti-device+jwt", "kid" to "dev-1"),
            decode(header).mapValues { it.value.jsonPrimitive.content },
        )
        val body = decode(claims)
        assertEquals("GET", body.getValue("htm").jsonPrimitive.content)
        assertEquals("https://seti.example.com/api/widget/summary", body.getValue("htu").jsonPrimitive.content)
        assertEquals(1_700_000_000L, body.getValue("iat").jsonPrimitive.long)
        assertEquals("jti-1", body.getValue("jti").jsonPrimitive.content)
    }

    @Test
    fun signatureIsRawP256AndVerifies() {
        repeat(50) {
            val url = "https://seti.example.com/api/widget/summary".toHttpUrl()
            val proof = DeviceProof.create("dev-1", "GET", url, signer, 1, "jti-$it")
            val input = proof.substringBeforeLast('.')
            val raw = Base64.getUrlDecoder().decode(proof.substringAfterLast('.'))
            assertEquals(64, raw.size)
            assertTrue(verify(keys.public, input.toByteArray(), raw))
        }
    }

    @Test
    fun authorizationUsesTheSetiDeviceScheme() {
        val header = DeviceProof.authorization("dev-1", "GET", "https://a.example/x".toHttpUrl(), signer)
        assertTrue(header.startsWith("SetiDevice "))
        assertEquals(3, header.removePrefix("SetiDevice ").split('.').size)
    }

    @Test
    fun htuKeepsNonDefaultPortsOnly() {
        assertEquals("https://a.example/p", DeviceProof.htu("https://a.example:443/p?q=1".toHttpUrl()))
        assertEquals("http://localhost:3006/api/x", DeviceProof.htu("http://localhost:3006/api/x".toHttpUrl()))
    }

    @Test
    fun derToJoseStripsSignBytesAndPadsShortIntegers() {
        val r = ByteArray(33).also { it[1] = 0x80.toByte(); it[32] = 1 }
        val s = byteArrayOf(0x05)
        val der = byteArrayOf(0x30, (2 + r.size + 2 + s.size).toByte(), 0x02, r.size.toByte()) + r +
            byteArrayOf(0x02, s.size.toByte()) + s
        val jose = DeviceProof.derToJose(der)
        assertArrayEquals(r.copyOfRange(1, 33), jose.copyOfRange(0, 32))
        assertArrayEquals(ByteArray(31) + byteArrayOf(0x05), jose.copyOfRange(32, 64))
    }

    private fun decode(part: String): JsonObject =
        Json.parseToJsonElement(String(Base64.getUrlDecoder().decode(part))) as JsonObject

    private fun verify(key: PublicKey, data: ByteArray, raw: ByteArray): Boolean =
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(key)
            update(data)
            verify(joseToDer(raw))
        }

    private fun joseToDer(raw: ByteArray): ByteArray {
        fun integer(bytes: ByteArray): ByteArray {
            val value = BigInteger(1, bytes).toByteArray()
            return byteArrayOf(0x02, value.size.toByte()) + value
        }
        val body = integer(raw.copyOfRange(0, 32)) + integer(raw.copyOfRange(32, 64))
        return ByteArrayOutputStream().apply {
            write(0x30)
            write(body.size)
            write(body)
        }.toByteArray()
    }
}

/** A JCA software key standing in for the Keystore key. */
class SoftwareSigner(private val keys: KeyPair) : DerSigner {
    override fun sign(data: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
        initSign(keys.private)
        update(data)
        sign()
    }
}
