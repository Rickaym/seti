import { LOCAL_TOKEN_FILE, type AuthState, type LocalSession } from '@seti/shared'
import { KeyRound, LogIn, TicketCheck } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { apiGet, apiPost, errorText, SIGN_IN_REQUIRED } from '@/api'
import { DemoNotice } from '@/components/DemoNotice'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { demoResetsAt, enterDemo } from '@/lib/demo'
import { passkeysWork, setUpPasskey, signInWithPasskey } from '@/lib/passkeys'

/** Runs one sign-in attempt at a time and keeps its error for the alert. */
function useAttempt(onSignedIn: () => void) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (attempt: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await attempt()
      onSignedIn()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return { error, busy, run }
}

function LocalTokenForm({ busy, run }: { busy: boolean; run: (attempt: () => Promise<unknown>) => Promise<void> }) {
  const [token, setToken] = useState('')
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        void run(async () => apiPost<LocalSession>('/local-session', { token }))
      }}
    >
      <p className="text-muted-foreground">
        On this machine the local token signs you in too. Paste it from{' '}
        <code className="font-mono">{LOCAL_TOKEN_FILE}</code>.
      </p>
      <Input
        type="password"
        aria-label="Local token"
        autoComplete="current-password"
        value={token}
        onChange={(event) => {
          setToken(event.target.value)
        }}
      />
      <Button type="submit" variant="outline" disabled={busy || token.trim() === ''}>
        <LogIn />
        {busy ? 'Signing in...' : 'Sign in'}
      </Button>
    </form>
  )
}

function SetupCodeForm({ busy, run }: { busy: boolean; run: (attempt: () => Promise<unknown>) => Promise<void> }) {
  const [code, setCode] = useState('')
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        void run(async () => setUpPasskey(code))
      }}
    >
      <p className="text-muted-foreground">
        To add the first passkey, run <code className="font-mono">pnpm setup-code</code> on the Seti host and enter the
        code it prints. It works once, for 15 minutes.
      </p>
      <Input
        aria-label="Setup code"
        autoComplete="one-time-code"
        autoCapitalize="characters"
        spellCheck={false}
        className="font-mono"
        value={code}
        onChange={(event) => {
          setCode(event.target.value)
        }}
      />
      <Button type="submit" variant="outline" disabled={busy || code.trim() === ''}>
        <TicketCheck />
        Add passkey
      </Button>
    </form>
  )
}

/** The demo's door: one button, no passkeys or tokens, since the demo holds nothing of anyone's. */
function DemoSignInPage({ onSignedIn }: { onSignedIn: () => void }) {
  const { error, busy, run } = useAttempt(onSignedIn)
  return (
    <div className="flex h-dvh flex-col bg-background">
      <DemoNotice />
      <main className="flex flex-1 items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="space-y-5 text-sm">
            <h1 className="text-base font-semibold">Seti demo</h1>
            <p className="text-muted-foreground">
              Look around a made-up team's Seti: agents at work, a permission prompt, pull requests and the EA. The
              agents follow a script and nothing runs anywhere.
            </p>
            <Button className="w-full" disabled={busy} onClick={() => void run(enterDemo)}>
              <LogIn />
              {busy ? 'Entering...' : 'Enter demo'}
            </Button>
            {error !== '' && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}

function SignInPage({ state, onSignedIn }: { state: AuthState; onSignedIn: () => void }) {
  const { error, busy, run } = useAttempt(onSignedIn)
  const webauthn = passkeysWork()
  const [setup, setSetup] = useState(!state.passkeys && !state.local)
  return (
    <main className="flex h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-5 text-sm">
          <h1 className="text-base font-semibold">Sign in to Seti</h1>
          {state.passkeys && webauthn && (
            <Button className="w-full" disabled={busy} onClick={() => void run(signInWithPasskey)}>
              <KeyRound />
              Passkey
            </Button>
          )}
          {!state.passkeys && !state.local && (
            <p className="text-muted-foreground">No passkey signs in to this address yet.</p>
          )}
          {!webauthn && !state.local && (
            <p className="text-muted-foreground">This browser cannot use passkeys here; open Seti over https.</p>
          )}
          {state.local && <LocalTokenForm busy={busy} run={run} />}
          {webauthn &&
            (setup ? (
              <SetupCodeForm busy={busy} run={run} />
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSetup(true)
                }}
              >
                <TicketCheck />
                Setup code
              </Button>
            ))}
          {error !== '' && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  )
}

/** Shows the sign-in page in place of Seti when this browser has no session, or loses it. */
export function SignInGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    const check = () => {
      apiGet<AuthState>('/auth')
        .then(setState, () => {
          setState(null)
        })
        .finally(() => {
          setChecked(true)
        })
    }
    check()
    window.addEventListener(SIGN_IN_REQUIRED, check)
    return () => {
      window.removeEventListener(SIGN_IN_REQUIRED, check)
    }
  }, [])

  const demo = demoResetsAt() !== null
  if (demo && !checked) {
    return null
  }
  if (state !== null && !state.signed_in) {
    const signedIn = () => {
      setState({ ...state, signed_in: true })
    }
    if (demo) {
      return <DemoSignInPage onSignedIn={signedIn} />
    }
    return <SignInPage state={state} onSignedIn={signedIn} />
  }
  return <>{children}</>
}
