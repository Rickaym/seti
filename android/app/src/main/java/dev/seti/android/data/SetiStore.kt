package dev.seti.android.data

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.seti.android.api.Pairing
import dev.seti.android.api.SetiJson
import dev.seti.android.api.WidgetSummary
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

private val Context.dataStore by preferencesDataStore(name = "seti")

class SetiStore(context: Context) {
    private val store = context.applicationContext.dataStore

    val state: Flow<SetiState> = store.data.map(::toState)

    suspend fun current(): SetiState = state.first()

    suspend fun savePairing(pairing: Pairing) {
        store.edit {
            it.clear()
            it[BASE_URL] = pairing.baseUrl.toString()
            it[DEVICE_ID] = pairing.deviceId
            it[KEY_ALIAS] = pairing.keyAlias
        }
    }

    suspend fun saveSummary(summary: WidgetSummary, now: Long) {
        store.edit {
            it[SUMMARY] = SetiJson.encodeToString(WidgetSummary.serializer(), summary)
            it[FETCHED_AT] = now
            it.remove(FAILED_AT)
            it.remove(PROBLEM)
        }
    }

    /** Records a failed refresh; a problem only pairing fixes also marks the phone for re-pairing. */
    suspend fun markFailed(problem: Problem, now: Long) {
        store.edit {
            it[FAILED_AT] = now
            it[PROBLEM] = problem.encode()
            if (problem.needsRepair) it[NEEDS_REPAIR] = true
        }
    }

    suspend fun markRefreshing(now: Long) {
        store.edit { it[REFRESHING_AT] = now }
    }

    private fun toState(prefs: Preferences): SetiState {
        val base = prefs[BASE_URL]?.toHttpUrlOrNull()
        val deviceId = prefs[DEVICE_ID]
        val alias = prefs[KEY_ALIAS]
        val summary = prefs[SUMMARY]?.let {
            runCatching { SetiJson.decodeFromString(WidgetSummary.serializer(), it) }.getOrNull()
        }
        return SetiState(
            pairing = if (base != null && deviceId != null && alias != null) Pairing(base, deviceId, alias) else null,
            needsRepair = prefs[NEEDS_REPAIR] ?: false,
            summary = summary,
            fetchedAt = prefs[FETCHED_AT],
            failedAt = prefs[FAILED_AT],
            problem = Problem.decode(prefs[PROBLEM]),
            refreshingAt = prefs[REFRESHING_AT],
        )
    }

    private companion object {
        val BASE_URL = stringPreferencesKey("base_url")
        val DEVICE_ID = stringPreferencesKey("device_id")
        val KEY_ALIAS = stringPreferencesKey("key_alias")
        val NEEDS_REPAIR = booleanPreferencesKey("needs_repair")
        val SUMMARY = stringPreferencesKey("summary")
        val FETCHED_AT = longPreferencesKey("fetched_at")
        val FAILED_AT = longPreferencesKey("failed_at")
        val PROBLEM = stringPreferencesKey("problem")
        val REFRESHING_AT = longPreferencesKey("refreshing_at")
    }
}
