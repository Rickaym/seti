package dev.seti.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import dev.seti.android.api.ApiException
import dev.seti.android.api.UnauthorizedException
import dev.seti.android.data.SetiStore
import dev.seti.android.pairing.Pairer
import dev.seti.android.pairing.QrScanner
import dev.seti.android.pairing.ScanEvent
import dev.seti.android.ui.CrashScreen
import dev.seti.android.ui.PairActions
import dev.seti.android.ui.PairFailure
import dev.seti.android.ui.PairScreen
import dev.seti.android.ui.SetiTheme
import dev.seti.android.widget.Refresh
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.IOException
import java.security.GeneralSecurityException

/** Entry point: opens Seti in a TWA when paired, otherwise shows pairing. */
class MainActivity : ComponentActivity() {
    private val crashLog by lazy { CrashLog(this) }
    private var crash by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        crash = crashLog.read()
        lifecycleScope.launch {
            val state = SetiStore(this@MainActivity).current()
            val data = intent.data?.toString()?.toHttpUrlOrNull()
            when (val launch = LaunchRouter.decide(intent.action, data, state)) {
                is Launch.Open -> crash?.let { showCrash(it, launch.url) } ?: open(launch.url)
                is Launch.Pair -> showPairing(launch, state.pairing?.baseUrl)
            }
        }
    }

    private fun dismissCrash() {
        crashLog.clear()
        crash = null
    }

    private fun showCrash(trace: String, next: HttpUrl) {
        enableEdgeToEdge()
        setContent {
            SetiTheme {
                CrashScreen(trace) {
                    dismissCrash()
                    open(next)
                }
            }
        }
    }

    private fun open(url: HttpUrl) {
        Refresh.now(this)
        TwaActivity.open(this, url)
        finish()
    }

    private fun showPairing(launch: Launch.Pair, pairedBase: HttpUrl?) {
        enableEdgeToEdge()
        val actions = object : PairActions {
            override fun scan(onEvent: (ScanEvent) -> Unit) = QrScanner(this@MainActivity).scan(onEvent)

            override suspend fun pair(baseUrl: HttpUrl, code: String) {
                pairOrExplain(baseUrl, code)
                open(SetiRoutes.url(baseUrl, SetiRoutes.HOME))
            }

            override fun openSeti() {
                pairedBase?.let { open(SetiRoutes.url(it, SetiRoutes.HOME)) }
            }
        }
        setContent {
            SetiTheme { PairScreen(launch.reason, launch.link, pairedBase?.host, actions, crash, ::dismissCrash) }
        }
    }

    private suspend fun pairOrExplain(baseUrl: HttpUrl, code: String) {
        try {
            Pairer(this).pair(baseUrl, code)
        } catch (_: UnauthorizedException) {
            throw PairFailure(getString(R.string.pair_error_rejected))
        } catch (e: ApiException) {
            throw PairFailure(e.message ?: getString(R.string.pair_error_network))
        } catch (_: GeneralSecurityException) {
            throw PairFailure(getString(R.string.pair_error_key))
        } catch (_: IOException) {
            throw PairFailure(getString(R.string.pair_error_network))
        }
    }
}
