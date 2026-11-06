import type { EaInboxKind, EaNotice, EaNoticeSeverity } from '@seti/shared'
import { AlarmClock, BellRing, ExternalLink, Eye, MessagesSquare, RadioTower, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

const KIND: Record<EaInboxKind, { icon: LucideIcon; label: (notice: EaNotice) => string }> = {
  followup: { icon: AlarmClock, label: () => 'Follow-up due' },
  reminder: { icon: BellRing, label: () => 'Reminder' },
  watch_event: { icon: Eye, label: (notice) => `Watching ${notice.source}` },
  channel_event: { icon: RadioTower, label: (notice) => notice.source },
  team_mention: { icon: MessagesSquare, label: (notice) => `Group chat, from ${notice.source}` },
}

const SEVERITY: Record<EaNoticeSeverity, string> = {
  info: 'border-primary text-primary',
  success: 'border-success text-success',
  warning: 'border-warning text-warning-text',
  critical: 'border-destructive text-destructive',
}

/** Something that reached the EA inbox: a follow-up or reminder when due, or an event. */
export function NoticeEntry({ notice }: { notice: EaNotice }) {
  const { icon: Icon, label } = KIND[notice.kind]
  return (
    <div
      className={cn('border-l-2 bg-muted/40 text-xs', SEVERITY[notice.severity])}
      data-kind="notice"
      data-notice={notice.kind}
      data-event={notice.event}
    >
      <div className="flex items-start gap-2 px-2 py-1.5">
        <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-2xs tracking-wider text-muted-foreground uppercase">{label(notice)}</div>
          <div className="font-medium break-words text-foreground">{notice.title}</div>
        </div>
        {notice.url !== null && (
          <a
            href={notice.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${notice.title}`}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      {notice.body !== '' && (
        <div className="max-h-40 overflow-y-auto border-t border-border px-2 py-1.5 whitespace-pre-wrap text-foreground">
          {notice.body}
        </div>
      )}
    </div>
  )
}
