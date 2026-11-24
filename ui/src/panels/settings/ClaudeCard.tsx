import type { AccountHealthState, AccountIdentity, AccountStatus, PlanUsage, UsageWindow } from '@seti/shared'
import { CircleAlert, CircleCheck, CircleDashed, RefreshCw } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { authSource, clockTime, level, percent, resetText, type Level } from '@/components/account/format'
import { Button } from '@/components/ui/button'
import { recheckAccount, useAccount } from '@/hooks/useAccount'
import { navigate } from '@/lib/route'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { ClaudeAgents } from './ClaudeAgents'
import { ClaudeRuntimeRows } from './ClaudeRuntimeRows'
import { LoginsCard } from './LoginsCard'
import { SettingRow, SettingsCard } from './layout'
import { useMovedCard } from './use-moved-card'

const BAR: Record<Level, string> = { normal: 'bg-primary', warning: 'bg-warning-fill', danger: 'bg-destructive' }

/** A titled part of the card, a region named by its title. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid gap-2 border-b border-border p-3 last:border-b-0">
      <h4 className="text-sm font-medium">{title}</h4>
      {children}
    </section>
  )
}

function Identity({ account }: { account: AccountIdentity }) {
  const rows: [string, string | null][] = [
    ['Email', account.email],
    ['Organization', account.organization],
    ['Plan', account.subscription_type],
    ['Token source', authSource(account)],
    ['API key source', account.api_key_source],
    ['API provider', account.api_provider],
  ]
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-0.5">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="truncate" title={value ?? undefined}>
            {value ?? '-'}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function WindowRow({ window }: { window: UsageWindow }) {
  const value = window.utilization
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_3rem] items-center gap-3">
      <span className="truncate" title={window.label}>
        {window.label}
      </span>
      <div className="grid gap-0.5">
        <div
          className="h-1.5 bg-muted"
          role="meter"
          aria-label={`${window.label} usage`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={value ?? 0}
        >
          <div className={cn('h-full', BAR[level(value)])} style={{ width: `${String(Math.min(100, value ?? 0))}%` }} />
        </div>
        <span className="text-2xs text-muted-foreground">{resetText(window.resets_at)}</span>
      </div>
      <span className="text-right tabular-nums">{percent(value)}</span>
    </div>
  )
}

const SOURCE: Record<PlanUsage['source'], (ago: string) => string> = {
  usage_api: () => 'From the Claude Code usage API.',
  task_stream: (ago) => `From the latest rate limit events of agents, ${ago}.`,
  mixed: (ago) => `From the Claude Code usage API and a rate limit event of an agent, ${ago}.`,
}

function Usage({ status }: { status: AccountStatus }) {
  const { usage, usage_note: note, rate_limit_event: event } = status
  const source = usage && SOURCE[usage.source](relativeTime(usage.observed_at))
  return (
    <Section title="Plan usage">
      {usage ? (
        <div className="grid gap-2">
          {usage.windows.map((w) => (
            <WindowRow key={w.key} window={w} />
          ))}
          <p className="text-2xs text-muted-foreground">{source}</p>
        </div>
      ) : (
        <p className="text-muted-foreground">{note ?? 'No plan usage reported.'}</p>
      )}
      {event && (
        <p className="text-2xs text-muted-foreground">
          Last agent rate limit event: {event.status}
          {event.rate_limit_type === null ? '' : ` on ${event.rate_limit_type}`} in &quot;{event.task_title}&quot;,{' '}
          {relativeTime(event.at)}.
        </p>
      )}
    </Section>
  )
}

function TaskFailure({ status, onOpenTask }: { status: AccountStatus; onOpenTask: (id: string) => void }) {
  const failure = status.task_error
  if (!failure) {
    return null
  }
  const cleared = status.health.state === 'ok'
  return (
    <Section title="Agent login failure">
      <p className={cn(cleared && 'text-muted-foreground')}>
        {failure.error} in{' '}
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0"
          onClick={() => {
            onOpenTask(failure.task_id)
          }}
        >
          {failure.task_title}
        </Button>
        , {relativeTime(failure.at)}.{cleared ? ' A later turn or check succeeded.' : ''}
      </p>
      {failure.message !== null && <p className="text-2xs break-words text-muted-foreground">{failure.message}</p>}
    </Section>
  )
}

function Code({ children }: { children: ReactNode }) {
  return <code className="bg-muted px-1 py-px">{children}</code>
}

function LoginSteps() {
  return (
    <Section title="Log in on the host">
      <ol className="grid list-decimal gap-1 pl-4">
        <li>SSH into the machine that runs Seti, as the user that runs it.</li>
        <li>
          Run <Code>claude</Code>, then type <Code>/login</Code> and choose your Claude subscription account.
        </li>
        <li>Claude Code prints a URL. Open it in your local browser, log in, and copy the code the page shows.</li>
        <li>
          Paste the code into the terminal and press Enter, then leave with <Code>/exit</Code>.
        </li>
        <li>Click Recheck, then save the login under Saved logins so you can switch back to it.</li>
      </ol>
    </Section>
  )
}

function ApiKeySteps() {
  return (
    <Section title="Use the Claude Code login">
      <ol className="grid list-decimal gap-1 pl-4">
        <li>
          Remove the key or token named above from the Seti environment and from <Code>env</Code> or{' '}
          <Code>apiKeyHelper</Code> in <Code>~/.claude/settings.json</Code>.
        </li>
        <li>
          Make sure <Code>claude</Code> is logged in with <Code>/login</Code>, restart Seti, then click Recheck.
        </li>
      </ol>
    </Section>
  )
}

const STATE_WORDS: Record<AccountHealthState, string> = {
  ok: 'Ready',
  api_key: 'API key',
  logged_out: 'Logged out',
  error: 'Unreadable',
}

const STATE_ICONS: Record<AccountHealthState, typeof CircleCheck> = {
  ok: CircleCheck,
  api_key: CircleDashed,
  logged_out: CircleAlert,
  error: CircleAlert,
}

/** The login's state in a word, its full sentence in the tooltip. */
function StateWord({ status }: { status: AccountStatus | undefined }) {
  if (status === undefined) {
    return null
  }
  const { state, message } = status.health
  const Icon = STATE_ICONS[state]
  return (
    <Hint text={message}>
      <span role="status" className="flex items-center gap-1 text-muted-foreground">
        <Icon className="size-3.5" />
        {STATE_WORDS[state]}
      </span>
    </Hint>
  )
}

function LoginRow({ status }: { status: AccountStatus }) {
  const [checking, setChecking] = useState(false)
  const recheck = async () => {
    setChecking(true)
    try {
      await recheckAccount()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setChecking(false)
    }
  }
  return (
    <SettingRow label="Login" stack description={status.health.message}>
      <span className="text-muted-foreground">Checked {clockTime(status.fetched_at)}</span>
      <Button size="sm" variant="outline" onClick={() => void recheck()} disabled={checking}>
        <RefreshCw className={cn(checking && 'animate-spin')} />
        {checking ? 'Checking...' : 'Recheck'}
      </Button>
    </SettingRow>
  )
}

function ClaudeDetails({ status }: { status: AccountStatus }) {
  const { health, account } = status
  return (
    <>
      <LoginRow status={status} />
      <Usage status={status} />
      <LoginsCard logins={status.logins} />
      {account && (
        <Section title="Current login">
          <Identity account={account} />
        </Section>
      )}
      <ClaudeRuntimeRows />
      <TaskFailure
        status={status}
        onOpenTask={(id) => {
          navigate('agents', id)
        }}
      />
      {(health.state === 'logged_out' || health.state === 'error') && <LoginSteps />}
      {health.state === 'api_key' && <ApiKeySteps />}
      <ClaudeAgents />
    </>
  )
}

/** Claude Code: the login every agent runs on, the saved logins, and the plan's usage. */
export function ClaudeCard() {
  const { data, error } = useAccount()
  useMovedCard(data !== undefined)
  return (
    <SettingsCard id="claude" title="Claude Code" actions={<StateWord status={data} />}>
      {data ? (
        <ClaudeDetails status={data} />
      ) : (
        <p className="px-3 py-3 text-muted-foreground">{error ?? 'Checking the Claude login...'}</p>
      )}
    </SettingsCard>
  )
}
