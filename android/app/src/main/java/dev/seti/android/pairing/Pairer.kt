package dev.seti.android.pairing

import android.content.Context
import android.os.Build
import android.provider.Settings
import dev.seti.android.api.Pairing
import dev.seti.android.api.SetiApi
import dev.seti.android.auth.DeviceKey
import dev.seti.android.auth.DeviceProof
import dev.seti.android.data.SetiStore
import dev.seti.android.widget.Refresh
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl

/** Pairs this phone: a fresh Keystore key, the server's device id, then a widget refresh. */
class Pairer(private val context: Context, private val api: SetiApi = SetiApi()) {

    suspend fun pair(baseUrl: HttpUrl, code: String): Pairing {
        val key = withContext(Dispatchers.Default) { DeviceKey.create(context) }
        val publicKey = DeviceProof.encode(key.publicKey().encoded)
        val deviceId = try {
            api.pair(baseUrl, code.trim(), deviceName(), publicKey)
        } catch (e: Exception) {
            withContext(Dispatchers.Default) { key.delete() }
            throw e
        }
        val pairing = Pairing(baseUrl, deviceId, key.alias)
        SetiStore(context).savePairing(pairing)
        withContext(Dispatchers.Default) { DeviceKey.deleteOthers(key.alias) }
        Refresh.now(context)
        return pairing
    }

    private fun deviceName(): String =
        Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
            ?.takeIf { it.isNotBlank() }
            ?: "${Build.MANUFACTURER} ${Build.MODEL}"
}
