package dev.seti.android

import android.app.Application
import dev.seti.android.widget.Refresh

class SetiApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        CrashLog.install(this)
        Refresh.schedulePeriodic(this)
    }
}
