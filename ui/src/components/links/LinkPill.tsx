import { Bot, ChartLine, Cloud, FileText, Hash, Link2, Settings, Share2, Sparkles, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Hint } from '@/components/Hint'
import { ServiceIcon } from '@/components/service-icon/ServiceIcon'
import { useTasks } from '@/hooks/useTasks'
import type { LinkLabel } from '@/lib/links/link-label'
import { clip, type LinkGlyph } from '@/lib/links/link-services'

const GLYPHS: Record<LinkGlyph, LucideIcon> = {
  agent: Bot,
  artifact: Sparkles,
  chart: ChartLine,
  cloud: Cloud,
  file: FileText,
  link: Link2,
  message: Hash,
  settings: Settings,
  share: Share2,
}

const TOOLTIP_LIMIT = 400

const PILL = [
  'inline-flex max-w-full items-center gap-1 align-bottom',
  'border border-primary/25 bg-primary/5 px-1.5 text-[0.9em] leading-normal text-primary no-underline',
  'hover:border-primary/60 hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-ring',
].join(' ')

function Pill({ href, info, children }: { href: string; info: LinkLabel; children: ReactNode }) {
  return (
    <Hint text={<span className="break-all">{clip(href, TOOLTIP_LIMIT)}</span>}>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={PILL}
        data-link-pill={info.service}
        data-link-url={href}
      >
        <ServiceIcon icon={info.icon} fallback={GLYPHS[info.glyph]} className="size-[1.1em]" />
        <span className="min-w-0 truncate">{children}</span>
      </a>
    </Hint>
  )
}

/** A link to one of this Seti's agents, named as the agent list names it. */
function AgentPill({ href, info, agent }: { href: string; info: LinkLabel; agent: string }) {
  const task = useTasks().tasks.find((entry) => entry.id === agent)
  return (
    <Pill href={href} info={info}>
      {task === undefined ? info.label : clip(task.title)}
    </Pill>
  )
}

/** A URL shown as a short label with its service's icon; the full URL is in its tooltip. */
export function LinkPill({ href, info }: { href: string; info: LinkLabel }) {
  return info.agent === undefined ? (
    <Pill href={href} info={info}>
      {info.label}
    </Pill>
  ) : (
    <AgentPill href={href} info={info} agent={info.agent} />
  )
}
