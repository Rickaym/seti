import {
  addPermissionRuleInput,
  PERMISSION_BEHAVIORS,
  type InheritedRule,
  type PermissionBehavior,
  type PermissionRule,
  type ReviewCoverage,
  type ReviewGap,
} from '@seti/shared'
import { Plus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiPost, errorText } from '@/api'
import { InfoTip } from '@/components/InfoTip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { cn } from '@/lib/utils'
import { ReviewChecklist } from './ReviewChecklist'
import { ReviewGaps } from './ReviewGaps'
import { hasSiblings, loadCoverage } from './review-coverage'

const BEHAVIOR_TITLE: Record<PermissionBehavior, string> = {
  allow: 'Allow',
  ask: 'Ask',
  deny: 'Deny',
  review: 'Review',
}

const BEHAVIOR_MARK: Record<PermissionBehavior, string> = {
  allow: 'bg-success',
  ask: 'bg-warning',
  deny: 'bg-muted-foreground',
  review: 'bg-primary',
}

const PLACEHOLDER: Record<PermissionBehavior, string> = {
  allow: 'Bash(pnpm test:*)',
  ask: 'Bash(git push:*)',
  deny: 'Bash(rm:*)',
  review: 'mcp__slack__send_message',
}

const REVIEW_TIP =
  'Review holds each call of an MCP tool or server for you to check and edit before it runs, in Bypass too.'

const PUSH_TIP =
  "Agents ask before they push, fork or open a pull request outside your organisations. PushTo(owner), such as PushTo(acme), lets them do it on that owner's repositories without asking."

const TIPS: Partial<Record<PermissionBehavior, { label: string; text: string }>> = {
  allow: { label: 'About pushes elsewhere', text: PUSH_TIP },
  review: { label: 'About review rules', text: REVIEW_TIP },
}

/** One rule in a list: what it does, the rule, a note such as its file, and a way to remove it. */
export interface RuleEntry {
  key: string
  behavior: PermissionBehavior
  rule: string
  note?: string
  onRemove?: () => void
}

/** A rule on one line; a long one, such as a shell command, unfolds on a press. */
function RuleRow({ entry }: { entry: RuleEntry }) {
  const [open, setOpen] = useState(false)
  const { behavior, rule, note, onRemove } = entry
  return (
    <li className="flex min-h-7 items-center gap-2 border-b border-border px-3 last:border-b-0 pointer-coarse:min-h-11">
      <button
        type="button"
        aria-expanded={open}
        title={open ? undefined : rule}
        className="min-w-0 flex-1 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          setOpen(!open)
        }}
      >
        <code className={cn('block font-mono text-2xs', open ? 'break-all whitespace-pre-wrap' : 'truncate')}>
          {rule}
        </code>
      </button>
      {note !== undefined && (
        <span title={note} className="max-w-[40%] shrink-0 truncate text-2xs text-muted-foreground">
          {note}
        </span>
      )}
      {onRemove !== undefined && (
        <Button
          size="icon-xs"
          variant="ghost"
          className="pointer-coarse:size-11"
          aria-label={`Remove ${behavior} rule ${rule}`}
          title="Remove"
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      )}
    </li>
  )
}

/** Rules grouped as allow, ask, deny and review, each group under a header with its count. */
export function RuleGroups({ entries, label }: { entries: readonly RuleEntry[]; label: string }) {
  return (
    <div aria-label={label} role="group">
      {PERMISSION_BEHAVIORS.map((behavior) => {
        const group = entries.filter((entry) => entry.behavior === behavior)
        if (group.length === 0) {
          return null
        }
        const title = BEHAVIOR_TITLE[behavior]
        return (
          <section key={behavior} aria-label={title} className="border-b border-border last:border-b-0">
            <h4 className="flex h-6 items-center gap-1.5 border-b border-border bg-muted/40 px-3 text-2xs font-semibold text-muted-foreground">
              <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', BEHAVIOR_MARK[behavior])} />
              {title}
              <span className="font-normal tabular-nums">{group.length}</span>
            </h4>
            <ul aria-label={`${title} rules`}>
              {group.map((entry) => (
                <RuleRow key={entry.key} entry={entry} />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

/** The rules the user added for one scope, each removable, and a form to add one. */
export function RuleEditor({
  rules,
  path,
  empty,
  gaps,
  onChange,
}: {
  rules: readonly PermissionRule[]
  /** Servers the scope's review rules cover in part. */
  gaps: readonly ReviewGap[]
  /** Where the scope's rules live, such as /permissions/rules. */
  path: string
  empty: string
  onChange: () => void
}) {
  const [behavior, setBehavior] = useState<PermissionBehavior>('allow')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [checklist, setChecklist] = useState<ReviewCoverage | null>(null)
  const [unlisted, setUnlisted] = useState('')
  const ruleId = useId()
  const behaviorId = useId()
  const tip = TIPS[behavior]

  const add = async () => {
    const parsed = addPermissionRuleInput.safeParse({ behavior, rule: text })
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the rule')
      return
    }
    setBusy(true)
    setUnlisted('')
    try {
      const coverage = behavior === 'review' ? await loadCoverage(path, parsed.data.rule) : null
      if (coverage !== null && hasSiblings(coverage)) {
        setChecklist(coverage)
        return
      }
      await apiPost(path, parsed.data)
      if (coverage !== null && !coverage.known) {
        setUnlisted(`Added. ${coverage.label} is not connected, so Seti cannot list its other tools.`)
      }
      setText('')
      onChange()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const choose = async (gap: ReviewGap) => {
    try {
      setChecklist(await loadCoverage(path, gap.server))
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const remove = async (rule: PermissionRule) => {
    try {
      await apiDelete(`${path}/${String(rule.id)}`)
      onChange()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  return (
    <>
      {rules.length === 0 ? (
        <p className="border-b border-border px-3 py-3 text-muted-foreground">{empty}</p>
      ) : (
        <div className="border-b border-border">
          <RuleGroups
            label="Rules"
            entries={rules.map((rule) => ({
              key: String(rule.id),
              behavior: rule.behavior,
              rule: rule.rule,
              onRemove: () => void remove(rule),
            }))}
          />
        </div>
      )}
      {gaps.length > 0 && <ReviewGaps gaps={gaps} onChoose={(gap) => void choose(gap)} />}
      <form
        className="flex flex-wrap items-center gap-2 px-3 py-2.5"
        onSubmit={(event) => {
          event.preventDefault()
          void add()
        }}
      >
        <label htmlFor={behaviorId} className="sr-only">
          Rule action
        </label>
        <NativeSelect
          id={behaviorId}
          size="sm"
          value={behavior}
          onChange={(event) => {
            const next = PERMISSION_BEHAVIORS.find((value) => value === event.target.value)
            setBehavior(next ?? 'allow')
          }}
        >
          {PERMISSION_BEHAVIORS.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {value}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <label htmlFor={ruleId} className="sr-only">
          New rule
        </label>
        <Input
          id={ruleId}
          value={text}
          placeholder={PLACEHOLDER[behavior]}
          className="h-7 min-w-40 flex-1 font-mono text-xs"
          onChange={(event) => {
            setText(event.target.value)
          }}
        />
        {tip !== undefined && <InfoTip label={tip.label} text={tip.text} />}
        <Button type="submit" size="sm" variant="outline" disabled={busy || text.trim() === ''}>
          <Plus />
          Add
        </Button>
      </form>
      {unlisted !== '' && (
        <p role="status" className="px-3 pb-2.5 text-2xs text-muted-foreground">
          {unlisted}
        </p>
      )}
      {checklist !== null && (
        <ReviewChecklist
          key={`${checklist.server} ${checklist.tool ?? ''}`}
          coverage={checklist}
          path={path}
          onClose={() => {
            setChecklist(null)
          }}
          onAdded={() => {
            setText('')
            onChange()
          }}
        />
      )}
    </>
  )
}

/**
 * Rules agents load from Claude Code's own settings files, shown with their file; Seti cannot
 * change them, so removing one means editing its file.
 */
export function InheritedRules({ rules }: { rules: readonly InheritedRule[] }) {
  return (
    <>
      <p className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-2xs text-muted-foreground">
        Claude Code, read-only
        <InfoTip
          label="About Claude Code rules"
          text="Agents load these from Claude Code's own settings too. Seti cannot change them; remove one in its file."
        />
      </p>
      <RuleGroups
        label="Claude Code rules"
        entries={rules.map((rule) => ({
          key: `${rule.source} ${rule.behavior} ${rule.rule}`,
          behavior: rule.behavior,
          rule: rule.rule,
          note: `From ${rule.source}`,
        }))}
      />
    </>
  )
}
