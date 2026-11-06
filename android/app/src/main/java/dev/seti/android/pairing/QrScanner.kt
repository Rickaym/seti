package dev.seti.android.pairing

import android.app.Activity
import dev.seti.android.R
import com.google.android.gms.common.moduleinstall.InstallStatusListener
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallClient
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.android.gms.common.moduleinstall.ModuleInstallStatusUpdate
import com.google.android.gms.common.moduleinstall.ModuleInstallStatusUpdate.InstallState
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

/** What a scan reports back to the pairing screen. */
sealed interface ScanEvent {
    /** Google Play services is downloading the scanner module. */
    data object Preparing : ScanEvent

    data class Scanned(val raw: String) : ScanEvent

    /** The scanner failed; `message` is ready to show. */
    data class Failed(val message: String) : ScanEvent

    data object Cancelled : ScanEvent
}

/** Google's code scanner, made safe to call: every failure becomes a [ScanEvent.Failed]. */
class QrScanner(private val activity: Activity) {

    fun scan(onEvent: (ScanEvent) -> Unit) {
        guarded(onEvent) {
            val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
            val scanner = GmsBarcodeScanning.getClient(activity, options)
            val modules = ModuleInstall.getClient(activity)
            modules.areModulesAvailable(scanner)
                .addOnSuccessListener { response ->
                    if (response.areModulesAvailable()) start(scanner, onEvent) else install(modules, scanner, onEvent)
                }
                .addOnFailureListener { onEvent(failed(it.message)) }
        }
    }

    private fun install(modules: ModuleInstallClient, scanner: GmsBarcodeScanner, onEvent: (ScanEvent) -> Unit) {
        guarded(onEvent) {
            onEvent(ScanEvent.Preparing)
            var done = false
            fun finish(event: ScanEvent?) {
                if (done) return
                done = true
                if (event == null) start(scanner, onEvent) else onEvent(event)
            }
            val listener = object : InstallStatusListener {
                override fun onInstallStatusUpdated(update: ModuleInstallStatusUpdate) {
                    val event = when (update.installState) {
                        InstallState.STATE_COMPLETED -> null
                        InstallState.STATE_FAILED -> failed("download error ${update.errorCode}")
                        InstallState.STATE_CANCELED -> ScanEvent.Cancelled
                        else -> return
                    }
                    modules.unregisterListener(this)
                    finish(event)
                }
            }
            val request = ModuleInstallRequest.newBuilder().addApi(scanner).setListener(listener).build()
            modules.installModules(request)
                .addOnSuccessListener { response ->
                    if (response.areModulesAlreadyInstalled()) {
                        modules.unregisterListener(listener)
                        finish(null)
                    }
                }
                .addOnFailureListener {
                    modules.unregisterListener(listener)
                    finish(failed(it.message))
                }
        }
    }

    private fun start(scanner: GmsBarcodeScanner, onEvent: (ScanEvent) -> Unit) {
        guarded(onEvent) {
            scanner.startScan()
                .addOnSuccessListener { barcode ->
                    onEvent(ScanEvent.Scanned(barcode.rawValue.orEmpty()))
                }
                .addOnCanceledListener { onEvent(ScanEvent.Cancelled) }
                .addOnFailureListener { onEvent(failed(it.message)) }
        }
    }

    private fun failed(detail: String?): ScanEvent.Failed {
        val reason = detail?.trim()?.trimEnd('.')?.takeIf { it.isNotEmpty() }
        val message = reason?.let { activity.getString(R.string.pair_error_scanner_detail, it) }
        return ScanEvent.Failed(message ?: activity.getString(R.string.pair_error_scanner))
    }

    private inline fun guarded(onEvent: (ScanEvent) -> Unit, block: () -> Unit) {
        try {
            block()
        } catch (e: Exception) {
            onEvent(failed(e.message ?: e.javaClass.name))
        }
    }
}
