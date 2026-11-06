package dev.seti.android.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.seti.android.PairReason
import dev.seti.android.R
import dev.seti.android.pairing.PairLink
import dev.seti.android.pairing.ScanEvent
import kotlinx.coroutines.launch
import okhttp3.HttpUrl

/** What the pairing screen asks of its activity; `pair` throws [PairFailure] to show a message. */
interface PairActions {
    fun scan(onEvent: (ScanEvent) -> Unit)
    suspend fun pair(baseUrl: HttpUrl, code: String)
    fun openSeti()
}

@Composable
fun PairScreen(
    reason: PairReason,
    link: String?,
    pairedHost: String?,
    actions: PairActions,
    crash: String?,
    onDismissCrash: () -> Unit,
) {
    val initial = remember(link) { link?.let(PairLink::parse) }
    var url by remember { mutableStateOf(initial?.baseUrl?.toString()?.trimEnd('/') ?: "") }
    var code by remember { mutableStateOf(initial?.code ?: "") }
    var busy by remember { mutableStateOf(false) }
    var preparing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val invalidUrl = stringResource(R.string.pair_error_url)
    val missingCode = stringResource(R.string.pair_error_code)
    val notPairLink = stringResource(R.string.pair_error_qr)

    fun submit(rawUrl: String, rawCode: String) {
        val target = PairLink.parse(rawUrl)
        error = when {
            target == null -> invalidUrl
            rawCode.isBlank() -> missingCode
            else -> null
        }
        if (target == null || rawCode.isBlank()) return
        busy = true
        scope.launch {
            try {
                actions.pair(target.baseUrl, rawCode)
            } catch (e: PairFailure) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        Column(
            modifier = Modifier
                .safeDrawingPadding()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Spacer(Modifier.height(24.dp))
            Image(
                painter = painterResource(R.drawable.seti_moon),
                contentDescription = null,
                modifier = Modifier.size(72.dp).clip(CircleShape),
            )
            crash?.let { CrashNotice(it, onDismissCrash) }
            Text(stringResource(R.string.pair_title), style = MaterialTheme.typography.headlineSmall)
            Text(
                stringResource(R.string.pair_intro),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 480.dp),
            )
            if (reason == PairReason.NEEDS_REPAIR) {
                Card(
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
                    modifier = Modifier.widthIn(max = 480.dp).fillMaxWidth(),
                ) {
                    Text(
                        stringResource(R.string.pair_repair),
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            } else if (pairedHost != null) {
                Text(
                    stringResource(R.string.pair_switch, pairedHost),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.widthIn(max = 480.dp),
                )
            }
            Column(
                modifier = Modifier.widthIn(max = 480.dp).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                FilledTonalButton(
                    onClick = {
                        error = null
                        actions.scan { event ->
                            preparing = event == ScanEvent.Preparing
                            when (event) {
                                ScanEvent.Preparing, ScanEvent.Cancelled -> Unit
                                is ScanEvent.Failed -> error = event.message
                                is ScanEvent.Scanned -> {
                                    val scanned = PairLink.parse(event.raw)
                                    if (scanned?.code == null) {
                                        error = notPairLink
                                    } else {
                                        url = scanned.baseUrl.toString().trimEnd('/')
                                        code = scanned.code
                                        submit(url, code)
                                    }
                                }
                            }
                        }
                    },
                    enabled = !busy && !preparing,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (preparing) {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                            Text(stringResource(R.string.pair_scan_preparing))
                        }
                    } else {
                        Text(stringResource(R.string.pair_scan))
                    }
                }
                HorizontalDivider()
                OutlinedTextField(
                    value = url,
                    onValueChange = { typed ->
                        val pasted = PairLink.parse(typed)
                        val pastedCode = pasted?.code
                        if (pasted != null && pastedCode != null) {
                            url = pasted.baseUrl.toString().trimEnd('/')
                            code = pastedCode
                        } else {
                            url = typed
                        }
                    },
                    label = { Text(stringResource(R.string.pair_url)) },
                    placeholder = { Text(stringResource(R.string.pair_url_hint)) },
                    singleLine = true,
                    enabled = !busy,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it },
                    label = { Text(stringResource(R.string.pair_code)) },
                    singleLine = true,
                    enabled = !busy,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { submit(url, code) }),
                    modifier = Modifier.fillMaxWidth(),
                )
                error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
                Button(onClick = { submit(url, code) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                    if (busy) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                    } else {
                        Text(stringResource(R.string.pair_submit))
                    }
                }
                if (pairedHost != null) {
                    TextButton(onClick = actions::openSeti, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.pair_open))
                    }
                }
            }
        }
    }
}

/** A pairing failure whose message is shown to the user as is. */
class PairFailure(message: String) : Exception(message)
