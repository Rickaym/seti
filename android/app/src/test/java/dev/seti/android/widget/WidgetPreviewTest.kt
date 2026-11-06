package dev.seti.android.widget

import android.app.Application
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.View
import android.widget.FrameLayout
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.compose
import androidx.test.core.app.ApplicationProvider
import dev.seti.android.api.AgentItem
import dev.seti.android.api.NeedsYouItem
import dev.seti.android.api.Pairing
import dev.seti.android.api.PrItem
import dev.seti.android.api.SubagentItem
import dev.seti.android.api.TodoCount
import dev.seti.android.api.WidgetSummary
import dev.seti.android.data.SetiStore
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.Instant
import kotlin.math.roundToInt

/** Renders both widgets at each size in light and dark; -Pseti.widgetPreviews=<dir> saves PNGs. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class, qualifiers = "xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WidgetPreviewTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val out = System.getProperty("seti.widgetPreviews")?.takeIf { it.isNotBlank() }?.let(::File)
    private val now = System.currentTimeMillis()

    private fun ago(minutes: Long) = Instant.ofEpochMilli(now - minutes * 60_000).toString()

    private val waiting = listOf(
        NeedsYouItem("a1", "Terraform the staging VPC", "blocked", ago(12), "Asks to use Bash: terraform apply", "#e4a339"),
        NeedsYouItem("a2", "Fix the flaky login test", "asking", ago(34), "Asks: Should I skip the retry or fix the race?", "#5488ec"),
        NeedsYouItem("a3", "Nightly dependency bumps", "error", ago(95), "Failed: pnpm install hit a registry timeout", null),
        NeedsYouItem("a4", "Release notes for 2.4", "asking", ago(180), "Asks: Which PRs belong in the release?", "#b066da"),
    )

    private val agents = listOf(
        AgentItem(
            "r1", "Widget overview redesign", "#3baca6", "running", "Writing the Glance previews", "Bash",
            TodoCount(2, 4),
            listOf(SubagentItem("Explore: find the widget code", "Grep"), SubagentItem("general-purpose: run the gates", "Bash")),
            1, PrItem("seti#412", "open", "pending", 0, 0), null, ago(1),
        ),
        AgentItem(
            "r2", "Postgres cutover rehearsal", "#e8605b", "running", null, "github: get_pull_request", null,
            emptyList(), 0, PrItem("seti#398", "open", "failure", 2, 1), null, ago(3),
        ),
        AgentItem("a1", "Terraform the staging VPC", "#e4a339", "waiting", "Asks to use Bash: terraform apply", since = ago(12)),
        AgentItem("c1", "Share links for PDFs", "#4eb068", "complete", null, null, null, emptyList(), 0,
            PrItem("seti#406", "merged"), null, ago(50)),
        AgentItem("i1", "Docs: channels and security", null, "idle", "Waiting on review", since = ago(130),
            pr = PrItem("seti#405", "open", "success", 1)),
    )

    private val summary = WidgetSummary(
        needsYou = waiting, needsYouTotal = 6, agents = agents, running = 2, idle = 7,
        costTodayUsd = 4.21, updatedAt = ago(2),
    )

    private val sizes = mapOf(
        "small-2x2" to DpSize(150.dp, 180.dp),
        "medium-4x2" to DpSize(300.dp, 180.dp),
        "large-4x4" to DpSize(300.dp, 400.dp),
    )

    private suspend fun seed(shown: WidgetSummary?) {
        val store = SetiStore(context)
        store.savePairing(Pairing("https://seti.example.com".toHttpUrl(), "phone", "key"))
        if (shown != null) store.saveSummary(shown, now - 2 * 60_000)
    }

    private suspend fun render(widget: GlanceAppWidget, size: DpSize, name: String) {
        val views = widget.compose(context, size = size)
        val density = context.resources.displayMetrics.density
        val width = (size.width.value * density).roundToInt()
        val height = (size.height.value * density).roundToInt()
        val host = FrameLayout(context)
        val view = views.apply(context, host)
        host.addView(view, FrameLayout.LayoutParams(width, height))
        host.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
        host.layout(0, 0, width, height)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(if (dark()) Color.rgb(32, 34, 40) else Color.rgb(214, 220, 230))
        host.draw(canvas)
        val colors = (0 until height step 6).flatMap { y -> (0 until width step 6).map { x -> bitmap.getPixel(x, y) } }
        assertTrue("$name drew nothing", colors.toSet().size > 3)
        out?.let { dir ->
            dir.mkdirs()
            File(dir, "widget-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    private fun dark() = RuntimeEnvironment.getQualifiers().contains("night")

    @Test
    fun rendersEveryWidgetAtEverySizeInLightAndDark() = runBlocking {
        RuntimeEnvironment.setQualifiers("+notnight")
        render(AgentsWidget(), sizes.getValue("small-2x2"), "agents-unpaired-light")
        seed(summary)
        for (theme in listOf("light", "dark")) {
            RuntimeEnvironment.setQualifiers(if (theme == "dark") "+night" else "+notnight")
            for ((size, dp) in sizes) {
                render(NeedsYouWidget(), dp, "needs-you-$size-$theme")
                render(AgentsWidget(), dp, "agents-$size-$theme")
            }
        }
        RuntimeEnvironment.setQualifiers("+notnight")
        seed(summary.copy(needsYou = emptyList(), needsYouTotal = 0, agents = agents.map { it.copy(title = "Agent ${it.taskId}", activity = null) }, namesHidden = true))
        render(NeedsYouWidget(), sizes.getValue("medium-4x2"), "needs-you-all-clear-light")
        render(AgentsWidget(), sizes.getValue("medium-4x2"), "agents-names-hidden-light")
    }
}
