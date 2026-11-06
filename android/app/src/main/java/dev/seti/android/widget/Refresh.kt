package dev.seti.android.widget

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.glance.appwidget.updateAll
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.seti.android.api.SetiApi
import dev.seti.android.api.WidgetSummary
import dev.seti.android.auth.DeviceKey
import dev.seti.android.data.Problem
import dev.seti.android.data.SetiStore
import java.util.concurrent.TimeUnit
import kotlin.coroutines.cancellation.CancellationException

/** Widget refreshes; each job requires a network, or Android 15+ blocks a background app's calls. */
object Refresh {
    private const val PERIODIC = "seti-widget-refresh"
    private const val NOW = "seti-widget-refresh-now"
    private const val SOON = "seti-widget-refresh-soon"

    /** While agents run, the widgets refresh this often instead of every 15 minutes. */
    const val ACTIVE_EVERY_MINUTES = 5L

    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedulePeriodic(context: Context) {
        val request = PeriodicWorkRequestBuilder<RefreshWorker>(15, TimeUnit.MINUTES).setConstraints(online).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /** Refreshes soon; a refresh already queued or running answers this request too. */
    fun now(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.KEEP, nowRequest())
    }

    internal fun nowRequest(sdk: Int = Build.VERSION.SDK_INT): OneTimeWorkRequest {
        val builder = OneTimeWorkRequestBuilder<RefreshWorker>().setConstraints(online)
        // Expedited work before Android 12 needs a foreground notification.
        if (sdk >= Build.VERSION_CODES.S) builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        return builder.build()
    }

    /** Asks for one more refresh a few minutes after this one, replacing any that waits. */
    fun soon(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork(SOON, ExistingWorkPolicy.REPLACE, soonRequest())
    }

    internal fun soonRequest(): OneTimeWorkRequest = OneTimeWorkRequestBuilder<RefreshWorker>()
        .setConstraints(online)
        .setInitialDelay(ACTIVE_EVERY_MINUTES, TimeUnit.MINUTES)
        .build()

    /** Running agents change what the widgets show within minutes; waiting ones wait on the user. */
    internal fun active(summary: WidgetSummary): Boolean = summary.running > 0

    suspend fun redrawWidgets(context: Context) {
        NeedsYouWidget().updateAll(context)
        AgentsWidget().updateAll(context)
    }
}

class RefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val store = SetiStore(applicationContext)
        val state = store.current()
        val pairing = state.pairing
        if (pairing != null && !state.needsRepair) {
            try {
                val summary = SetiApi().widgetSummary(pairing, DeviceKey(pairing.keyAlias))
                store.saveSummary(summary, System.currentTimeMillis())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val problem = Problem.of(e) ?: throw e
                Log.w(TAG, "Widget refresh failed: ${problem.encode()}", e)
                store.markFailed(problem, System.currentTimeMillis())
            }
        }
        Refresh.redrawWidgets(applicationContext)
        // Last, since replacing the queued refresh may cancel this very worker.
        if (state.paired && store.current().summary?.let(Refresh::active) == true) Refresh.soon(applicationContext)
        return Result.success()
    }

    private companion object {
        const val TAG = "SetiRefresh"
    }
}
