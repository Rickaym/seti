/** Why this page cannot capture audio at all, or null when it can ask for the microphone. */
export function mediaIssue(): string | null {
  if ('mediaDevices' in navigator) {
    return null
  }
  if (!window.isSecureContext) {
    return (
      `Microphone access needs a secure context, and ${window.location.origin} is plain HTTP. ` +
      'Open Seti on http://localhost or http://seti.localhost, or through the public hostname.'
    )
  }
  return 'This browser offers no media devices. Check that no permissions policy or extension blocks them.'
}

const MIC_ERRORS: Record<string, string> = {
  NotAllowedError: 'Microphone permission denied. Allow the microphone for this site, then connect again.',
  SecurityError: 'Microphone permission denied. Allow the microphone for this site, then connect again.',
  NotFoundError: 'No microphone found. Connect one and try again.',
  DevicesNotFoundError: 'No microphone found. Connect one and try again.',
  NotReadableError: 'Another application is using the microphone. Close it and try again.',
  TrackStartError: 'Another application is using the microphone. Close it and try again.',
  OverconstrainedError: 'The chosen microphone is not available. Choose another in Settings, EA.',
}

export function micError(e: unknown): string {
  const name = e instanceof Error ? e.name : ''
  const known = MIC_ERRORS[name]
  if (known !== undefined) {
    return known
  }
  return name === '' ? 'Could not open the microphone.' : `Could not open the microphone (${name}).`
}

/** Asks for the microphone once, since the transport hides the real reason when it fails. */
export async function probeMicrophone(audio: MediaTrackConstraints | true = true): Promise<string | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio })
    for (const track of stream.getTracks()) {
      track.stop()
    }
    return null
  } catch (e) {
    return micError(e)
  }
}

const SERVICE_LABELS: Record<string, string> = {
  tts: 'The voice (TTS) service',
  stt: 'The speech recognition (STT) service',
  llm: 'The language model (LLM) service',
}

const MAX_ERROR_CHARS = 200

/** Provider errors can be whole HTML pages; keep only the text between tags, on one line. */
function withoutMarkup(text: string): string {
  let depth = 0
  let out = ''
  for (const char of text) {
    if (char === '<') {
      depth += 1
    } else if (char === '>' && depth > 0) {
      depth -= 1
      out += ' '
    } else if (depth === 0) {
      out += char
    }
  }
  return out
    .split(/\s+/)
    .filter((word) => word !== '')
    .join(' ')
}

/** A short sentence for an RTVI error, which can arrive as a raw provider error page. */
export function describeBotError(data: unknown): string | null {
  const payload = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  const raw = [payload.error, payload.message].find((value) => typeof value === 'string')
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') {
    return null
  }
  const service = /^(tts|stt|llm)\b/i.exec(text)?.[1]?.toLowerCase()
  const label = service === undefined ? undefined : SERVICE_LABELS[service]
  if (label !== undefined) {
    const status = /\bstatus[ :]+(\d{3})\b/i.exec(text)?.[1]
    return status === undefined ? `${label} failed.` : `${label} failed (HTTP ${status}).`
  }
  const flat = withoutMarkup(text)
  return flat.length > MAX_ERROR_CHARS ? `${flat.slice(0, MAX_ERROR_CHARS)}...` : flat
}
