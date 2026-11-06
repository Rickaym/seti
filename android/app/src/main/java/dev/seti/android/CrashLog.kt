package dev.seti.android

import android.content.Context
import android.os.Build
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.time.Instant

/** Keeps the stack trace of the last crash in app-private storage so the next launch can show it. */
class CrashLog(private val file: File) {

    constructor(context: Context) : this(File(context.filesDir, FILE_NAME))

    fun read(): String? = runCatching { file.readText() }.getOrNull()?.takeIf { it.isNotBlank() }

    fun clear() {
        file.delete()
    }

    fun record(about: String, thread: Thread, error: Throwable) {
        runCatching { file.writeText(format(about, thread, error, Instant.now())) }
    }

    companion object {
        private const val FILE_NAME = "last-crash.txt"

        /** Records uncaught exceptions, then lets the previous handler end the process as usual. */
        fun install(context: Context) {
            val log = CrashLog(context)
            val about = describe(context)
            val previous = Thread.getDefaultUncaughtExceptionHandler()
            Thread.setDefaultUncaughtExceptionHandler { thread, error ->
                log.record(about, thread, error)
                previous?.uncaughtException(thread, error)
            }
        }

        fun format(about: String, thread: Thread, error: Throwable, at: Instant): String {
            val trace = StringWriter().also { error.printStackTrace(PrintWriter(it)) }
            return "$about\nTime: $at\nThread: ${thread.name}\n\n$trace"
        }

        private fun describe(context: Context): String {
            val app = runCatching {
                val info = context.packageManager.getPackageInfo(context.packageName, 0)
                "${info.versionName} (${info.longVersionCode})"
            }.getOrDefault("unknown")
            return "Seti for Android $app\nAndroid ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}), " +
                "${Build.MANUFACTURER} ${Build.MODEL}"
        }
    }
}
