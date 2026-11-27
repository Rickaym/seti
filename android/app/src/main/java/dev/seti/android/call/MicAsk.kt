package dev.seti.android.call

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.content.edit

/** Asks once for the app's own microphone permission, which the call's foreground service needs. */
object MicAsk {
    const val PERMISSION = Manifest.permission.RECORD_AUDIO
    private const val PREFS = "seti.call"
    private const val ASKED = "mic_asked"

    fun due(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
            ContextCompat.checkSelfPermission(context, PERMISSION) != PackageManager.PERMISSION_GRANTED &&
            !context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(ASKED, false)

    fun mark(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit { putBoolean(ASKED, true) }
    }
}
