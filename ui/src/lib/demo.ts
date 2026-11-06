/** Where the demo server signs a visitor in; it exists only on the demo. */
const DEMO_SESSION_PATH = '/demo/session'

/** When the demo resets, from the meta tag the demo server adds; null outside the demo. */
export function demoResetsAt(): Date | null {
  const content = document.querySelector('meta[name="seti-demo"]')?.getAttribute('content') ?? ''
  const at = Date.parse(content)
  return Number.isNaN(at) ? null : new Date(at)
}

/** Starts a demo session for this browser; throws with the server's reason when it refuses. */
export async function enterDemo(): Promise<void> {
  const res = await fetch(DEMO_SESSION_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { detail?: string } } | null
    throw new Error(body?.error?.detail ?? `The demo did not let you in (${String(res.status)})`)
  }
}
