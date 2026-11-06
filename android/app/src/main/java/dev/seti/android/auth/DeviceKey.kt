package dev.seti.android.auth

import android.content.Context
import android.content.pm.PackageManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/** A non-exportable P-256 signing key in Android Keystore; each pairing gets its own alias. */
class DeviceKey(val alias: String) : DerSigner {

    override fun sign(data: ByteArray): ByteArray {
        val key = keyStore().getKey(alias, null) as? PrivateKey ?: error("No device key")
        return Signature.getInstance("SHA256withECDSA").run {
            initSign(key)
            update(data)
            sign()
        }
    }

    fun publicKey(): PublicKey = keyStore().getCertificate(alias)?.publicKey ?: error("No device key")

    fun delete() {
        keyStore().deleteEntry(alias)
    }

    companion object {
        private const val PREFIX = "seti-device-"
        private const val PROVIDER = "AndroidKeyStore"

        /** Generates a fresh key, in StrongBox when the device has one; no user auth so work can sign. */
        fun create(context: Context): DeviceKey {
            val alias = PREFIX + System.currentTimeMillis()
            val strongBox = context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
            if (strongBox) {
                try {
                    generate(alias, strongBox = true)
                    return DeviceKey(alias)
                } catch (_: StrongBoxUnavailableException) {
                    // Some devices list StrongBox but refuse EC keys there.
                }
            }
            generate(alias, strongBox = false)
            return DeviceKey(alias)
        }

        /** Deletes every device key except `keep`. */
        fun deleteOthers(keep: String) {
            val store = keyStore()
            store.aliases().toList().filter { it.startsWith(PREFIX) && it != keep }.forEach(store::deleteEntry)
        }

        private fun generate(alias: String, strongBox: Boolean) {
            val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .setIsStrongBoxBacked(strongBox)
                .build()
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER).run {
                initialize(spec)
                generateKeyPair()
            }
        }

        private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }
    }
}
