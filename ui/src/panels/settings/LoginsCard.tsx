import { LOGIN_NAME_MAX, type ClaudeLogin, type ClaudeLogins, type SignInStart } from '@seti/shared'
import { ArrowLeftRight, Check, ExternalLink, LogIn, Pencil, Save, Trash2, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { planName } from '@/components/account/format'
import { chordLabel, CHORDS } from '@/components/shortcuts/chords'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { Input } from '@/components/ui/input'
import {
  cancelSignIn,
  finishSignIn,
  removeLogin,
  renameLogin,
  saveLogin,
  startSignIn,
  switchLogin,
} from '@/hooks/useAccount'
import { useBusy } from '@/hooks/useBusy'
import { cn } from '@/lib/utils'
import { SettingsCard } from './layout'

const ROW = 'flex items-center gap-3 border-b border-border px-3 py-2.5 max-md:flex-wrap'

function NameForm({
  label,
  initial = '',
  submit,
  icon,
  busy,
  onCancel,
  children,
}: {
  label: string
  initial?: string
  submit: (name: string) => void
  icon: ReactNode
  busy: boolean
  onCancel?: () => void
  children: string
}) {
  const [name, setName] = useState(initial)
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-2 max-md:basis-full"
      onSubmit={(event) => {
        event.preventDefault()
        submit(name.trim())
      }}
    >
      <Input
        aria-label={label}
        autoComplete="off"
        className="w-44 max-md:w-full max-md:flex-1"
        placeholder="Name"
        maxLength={LOGIN_NAME_MAX}
        value={name}
        onChange={(event) => {
          setName(event.target.value)
        }}
      />
      <Button type="submit" size="sm" disabled={busy || name.trim() === ''}>
        {icon}
        {children}
      </Button>
      {onCancel && (
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          <X />
          Cancel
        </Button>
      )}
    </form>
  )
}

function detailOf(login: Pick<ClaudeLogin, 'email' | 'organization' | 'plan'>): string {
  const plan = login.plan === null ? null : planName(login.plan)
  const parts = [login.email, login.organization, plan].filter((part) => part !== null && part !== '')
  return parts.length === 0 ? 'No account details recorded' : parts.join(', ')
}

function LoginRow({ login, active }: { login: ClaudeLogin; active: boolean }) {
  const confirm = useConfirm()
  const { busy, run } = useBusy()
  const [renaming, setRenaming] = useState(false)

  const remove = async () => {
    const message = `Remove the saved login ${login.name}? Seti forgets its tokens; log in to it again to bring it back.`
    if (await confirm({ message, confirmLabel: 'Remove', variant: 'destructive' })) {
      await run(async () => removeLogin(login.id))
    }
  }

  return (
    <div className={ROW} data-testid="saved-login" data-active={active}>
      <div className="grid min-w-0 flex-1 gap-0.5">
        {renaming ? (
          <NameForm
            label={`New name for ${login.name}`}
            initial={login.name}
            busy={busy}
            icon={<Save />}
            submit={(name) => {
              void run(async () => renameLogin(login.id, name)).then((done) => {
                setRenaming(!done)
              })
            }}
            onCancel={() => {
              setRenaming(false)
            }}
          >
            Save
          </NameForm>
        ) : (
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <span className={cn('truncate', active && 'font-semibold')}>{login.name}</span>
            {active && (
              <span className="flex shrink-0 items-center gap-1 text-2xs text-success">
                <Check className="size-3" />
                In use
              </span>
            )}
          </span>
        )}
        <span className="truncate text-muted-foreground">{detailOf(login)}</span>
      </div>
      {!renaming && (
        <div className="flex shrink-0 items-center gap-1 max-md:basis-full max-md:justify-end">
          {!active && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(async () => switchLogin(login))}
            >
              <ArrowLeftRight />
              Use
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setRenaming(true)
            }}
          >
            <Pencil />
            Rename
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || active}
            title={active ? 'Switch to another login before removing this one' : undefined}
            onClick={() => void remove()}
          >
            <Trash2 />
            Remove
          </Button>
        </div>
      )}
    </div>
  )
}

function UnsavedRow({ email }: { email: string | null }) {
  const { busy, run } = useBusy()
  return (
    <div className={cn(ROW, 'bg-warning/10')} data-testid="unsaved-login">
      <p className="min-w-0 flex-1 basis-56">
        Claude Code is logged in to <span className="font-semibold">{email ?? 'an account'}</span>, which Seti has not
        saved. Name it to keep it.
      </p>
      <NameForm
        label="Current login name"
        busy={busy}
        icon={<Save />}
        submit={(name) => {
          void run(async () => {
            const login = await saveLogin(name)
            toast.success(`Saved ${login.name}`)
          })
        }}
      >
        Save
      </NameForm>
    </div>
  )
}

function AddLogin({ onDone }: { onDone: () => void }) {
  const { busy, run } = useBusy()
  const [started, setStarted] = useState<SignInStart | null>(null)
  const [code, setCode] = useState('')

  const cancel = () => {
    if (started !== null) {
      void cancelSignIn(started.id).catch(() => undefined)
    }
    onDone()
  }

  if (started === null) {
    return (
      <div className={ROW}>
        <p className="min-w-0 flex-1 basis-56">Name the login, then log in to its account on claude.ai.</p>
        <NameForm
          label="New login name"
          busy={busy}
          icon={<LogIn />}
          submit={(name) => {
            void run(async () => {
              setStarted(await startSignIn(name))
            })
          }}
          onCancel={onDone}
        >
          {busy ? 'Starting...' : 'Start'}
        </NameForm>
      </div>
    )
  }

  const finish = () => {
    void run(async () => {
      const { login, created } = await finishSignIn(started.id, code.trim())
      toast.success(created ? `Saved ${login.name}` : `Updated ${login.name}`, {
        description: created ? 'Switch to it whenever you like.' : 'That account was already saved.',
      })
      onDone()
    })
  }

  return (
    <div className={cn(ROW, 'flex-col items-stretch')}>
      <ol className="grid list-decimal gap-1 pl-4">
        <li>
          <a
            href={started.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
          >
            Open the login page
            <ExternalLink className="size-3" />
          </a>{' '}
          and log in to the account you want to add.
        </li>
        <li>Copy the code the page shows and paste it here.</li>
      </ol>
      <form
        className="flex items-center gap-2 max-md:flex-wrap"
        onSubmit={(event) => {
          event.preventDefault()
          finish()
        }}
      >
        <Input
          aria-label="Login code"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 font-mono"
          placeholder="Paste the code"
          value={code}
          onChange={(event) => {
            setCode(event.target.value)
          }}
        />
        <Button type="submit" size="sm" disabled={busy || code.trim() === ''}>
          <Check />
          {busy ? 'Checking...' : 'Finish'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={cancel} disabled={busy}>
          <X />
          Cancel
        </Button>
      </form>
    </div>
  )
}

/** The Claude logins Seti keeps, which one Claude Code uses, and adding another. */
export function LoginsCard({ logins }: { logins: ClaudeLogins }) {
  const [adding, setAdding] = useState(false)
  const { accounts, active_id: activeId, unsaved } = logins
  const signedOut = activeId === null && unsaved === null
  return (
    <SettingsCard
      title="Saved logins"
      actions={
        !adding && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setAdding(true)
            }}
          >
            <LogIn />
            Log in
          </Button>
        )
      }
    >
      <p className="border-b border-border p-3 text-muted-foreground">
        Claude Code on this machine runs on one login at a time. Switch here, from the account item in the status bar (
        {chordLabel(CHORDS.switchLogin)}) or with Ctrl+K; each agent moves to the new login when its next turn starts.
        Agent credentials hold no Claude login, so every agent uses this one, except that sandboxed agents use the
        Claude token in Credentials when one is set.
      </p>
      {unsaved !== null && <UnsavedRow email={unsaved.email} />}
      {signedOut && accounts.length > 0 && (
        <p className={cn(ROW, 'text-muted-foreground')}>
          Claude Code is logged out. Use a saved login to log it back in.
        </p>
      )}
      {accounts.map((login) => (
        <LoginRow key={login.id} login={login} active={login.id === activeId} />
      ))}
      {accounts.length === 0 && unsaved === null && !adding && (
        <p className={cn(ROW, 'text-muted-foreground')}>
          No saved logins yet. Log in here, or log in with claude in a terminal and save the login here.
        </p>
      )}
      {adding && (
        <AddLogin
          onDone={() => {
            setAdding(false)
          }}
        />
      )}
    </SettingsCard>
  )
}
