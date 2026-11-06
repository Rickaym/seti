package dev.seti.android.widget

import android.content.Context
import android.content.Intent
import android.text.format.DateUtils
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.action.Action
import androidx.glance.action.ActionParameters
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.components.CircleIconButton
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import dev.seti.android.LaunchRouter
import dev.seti.android.MainActivity
import dev.seti.android.R
import dev.seti.android.SetiRoutes
import dev.seti.android.data.Freshness
import dev.seti.android.data.Problem
import dev.seti.android.data.SetiState
import dev.seti.android.data.SetiStore
import java.time.Instant
import java.time.format.DateTimeParseException

class RefreshAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        SetiStore(context).markRefreshing(System.currentTimeMillis())
        Refresh.now(context)
        Refresh.redrawWidgets(context)
    }
}

internal fun openRoute(context: Context, state: SetiState, route: String): Action {
    val pairing = state.pairing ?: return pairAction(context)
    val url = SetiRoutes.url(pairing.baseUrl, route).toString()
    val intent = Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW).setData(url.toUri())
    return actionStartActivity(intent)
}

internal fun pairAction(context: Context): Action =
    actionStartActivity(Intent(context, MainActivity::class.java).setAction(LaunchRouter.ACTION_PAIR))

internal fun relativeTime(context: Context, millis: Long, now: Long): CharSequence =
    if (now - millis < DateUtils.MINUTE_IN_MILLIS) {
        context.getString(R.string.widget_just_now)
    } else {
        DateUtils.getRelativeTimeSpanString(millis, now, DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE)
    }

internal fun parseInstant(value: String): Long? = try {
    Instant.parse(value).toEpochMilli()
} catch (_: DateTimeParseException) {
    null
}

/** "Updated 3 min. ago", or why the numbers may be old. */
internal fun statusLine(context: Context, state: SetiState, now: Long): String {
    if (state.refreshing(now)) return context.getString(R.string.widget_updating)
    val fetched = state.fetchedAt
    val ago = fetched?.let { relativeTime(context, it, now).toString() }
    return when (state.freshness(now)) {
        Freshness.FRESH -> context.getString(R.string.widget_updated, ago)
        Freshness.STALE ->
            if (ago == null) context.getString(R.string.widget_never) else context.getString(R.string.widget_stale, ago)
        Freshness.OFFLINE -> {
            val reason = problemText(context, state.problem)
            if (ago == null) reason else context.getString(R.string.widget_failed, reason, ago)
        }
    }
}

/** A few words on why the last refresh failed, so the phone itself shows what to check. */
internal fun problemText(context: Context, problem: Problem?): String = when (problem) {
    Problem.Unreachable, null -> context.getString(R.string.widget_problem_unreachable)
    Problem.Redirected -> context.getString(R.string.widget_problem_redirected)
    Problem.BadReply -> context.getString(R.string.widget_problem_bad_reply)
    Problem.SignedOut -> context.getString(R.string.widget_problem_signed_out)
    Problem.KeyLost -> context.getString(R.string.widget_problem_key_lost)
    is Problem.Status -> context.getString(R.string.widget_problem_status, problem.code)
}

@Composable
internal fun StatusText(state: SetiState, now: Long, modifier: GlanceModifier = GlanceModifier) {
    val context = LocalContext.current
    val calm = state.refreshing(now) || state.freshness(now) == Freshness.FRESH
    val color = if (calm) GlanceTheme.colors.onSurfaceVariant else GlanceTheme.colors.error
    Text(
        statusLine(context, state, now),
        maxLines = 1,
        style = TextStyle(color = color, fontSize = 11.sp),
        modifier = modifier,
    )
}

@Composable
internal fun RefreshButton() {
    CircleIconButton(
        imageProvider = ImageProvider(R.drawable.ic_refresh),
        contentDescription = LocalContext.current.getString(R.string.widget_refresh),
        onClick = actionRunCallback<RefreshAction>(),
        backgroundColor = null,
        contentColor = GlanceTheme.colors.onSurfaceVariant,
        modifier = GlanceModifier.size(36.dp),
    )
}

/** The state shown when the phone is not paired or Seti stopped accepting it. */
@Composable
internal fun PairPrompt(state: SetiState) {
    val context = LocalContext.current
    val text = if (state.pairing == null) {
        context.getString(R.string.widget_pair)
    } else {
        context.getString(R.string.widget_repair, problemText(context, state.problem ?: Problem.SignedOut))
    }
    Column(
        modifier = GlanceModifier.fillMaxSize().padding(12.dp).clickable(pairAction(context)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text,
            style = TextStyle(
                color = GlanceTheme.colors.onSurface,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center,
            ),
        )
    }
}
