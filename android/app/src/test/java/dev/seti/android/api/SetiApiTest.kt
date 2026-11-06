package dev.seti.android.api

import dev.seti.android.auth.DeviceProof
import dev.seti.android.auth.SoftwareSigner
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import java.util.Base64

class SetiApiTest {
    private val server = MockWebServer()
    private val api = SetiApi()
    private val signer = SoftwareSigner(
        KeyPairGenerator.getInstance("EC").run {
            initialize(ECGenParameterSpec("secp256r1"))
            generateKeyPair()
        },
    )

    @Before
    fun start() = server.start()

    @After
    fun stop() = server.shutdown()

    private fun pairing() = Pairing(server.url("/"), "dev-1", "alias")

    @Test
    fun pairPostsTheCodeAndPublicKey() = runTest {
        server.enqueue(MockResponse().setBody("""{"data":{"device_id":"dev-9","scopes":["widget"]},"meta":{}}"""))
        val id = api.pair(server.url("/"), "123456", "Pixel", "pubkey")
        assertEquals("dev-9", id)

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/devices/pair", request.path)
        val body = Json.parseToJsonElement(request.body.readUtf8()) as JsonObject
        assertEquals(
            mapOf("code" to "123456", "name" to "Pixel", "platform" to "android", "public_key" to "pubkey"),
            body.mapValues { it.value.jsonPrimitive.content },
        )
    }

    @Test
    fun summarySendsAFreshProofEachTime() = runTest {
        val json = """
            {"data":{"needs_you":[{"task_id":"t1","title":"Fix CI","reason":"question","since":"2026-10-18T10:00:00Z"}],
             "running":2,"idle":3,"cost_today_usd":1.5,"updated_at":"2026-10-18T10:05:00Z"},"meta":{}}
        """.trimIndent()
        server.enqueue(MockResponse().setBody(json))
        server.enqueue(MockResponse().setBody(json))

        val summary = api.widgetSummary(pairing(), signer)
        api.widgetSummary(pairing(), signer)

        assertEquals(listOf(NeedsYouItem("t1", "Fix CI", "question", "2026-10-18T10:00:00Z")), summary.needsYou)
        assertEquals(2, summary.running)
        assertEquals(3, summary.idle)
        assertEquals(1.5, summary.costTodayUsd, 0.0)

        val first = server.takeRequest()
        val second = server.takeRequest()
        assertEquals("/api/widget/summary", first.path)
        val proofs = listOf(first, second).map {
            val header = it.getHeader("Authorization").orEmpty()
            assertTrue(header.startsWith("${DeviceProof.SCHEME} "))
            header.removePrefix("${DeviceProof.SCHEME} ")
        }
        assertTrue(proofs[0] != proofs[1])
        val claims = Json.parseToJsonElement(
            String(Base64.getUrlDecoder().decode(proofs[0].split('.')[1])),
        ) as JsonObject
        assertEquals(DeviceProof.htu(server.url("/api/widget/summary")), claims.getValue("htu").jsonPrimitive.content)
        assertEquals("GET", claims.getValue("htm").jsonPrimitive.content)
    }

    @Test
    fun unauthorizedMeansRepair() = runTest {
        server.enqueue(MockResponse().setResponseCode(401))
        try {
            api.widgetSummary(pairing(), signer)
            fail("expected UnauthorizedException")
        } catch (_: UnauthorizedException) {
        }
    }

    @Test
    fun serverErrorsCarryTheTitle() = runTest {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":{"title":"Code expired","detail":"x"}}"""))
        try {
            api.pair(server.url("/"), "1", "n", "k")
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals(400, e.status)
            assertEquals("Code expired", e.message)
        }
    }

    @Test
    fun redirectsAreErrorsNotFollowed() = runTest {
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://login.example/"))
        try {
            api.widgetSummary(pairing(), signer)
            fail("expected RedirectedException")
        } catch (e: RedirectedException) {
            assertEquals(302, e.status)
        }
        assertEquals(1, server.requestCount)
    }

    @Test
    fun malformedBodiesAreApiErrors() = runTest {
        server.enqueue(MockResponse().setBody("<html>"))
        try {
            api.widgetSummary(pairing(), signer)
            fail("expected BadReplyException")
        } catch (e: BadReplyException) {
            assertEquals(200, e.status)
        }
    }
}
