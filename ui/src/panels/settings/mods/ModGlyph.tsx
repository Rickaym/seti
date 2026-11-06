import type { ModIcon } from '@seti/shared'
import {
  Bell,
  BookOpen,
  Bot,
  Calendar,
  ChartLine,
  CloudSun,
  CodeXml,
  Eye,
  FileSearch,
  FileText,
  FlaskConical,
  Ghost,
  GitPullRequest,
  Globe,
  Images,
  Keyboard,
  LayoutGrid,
  MessageCircleQuestionMark,
  Package,
  Palette,
  Plug,
  Presentation,
  Puzzle,
  Radar,
  Radio,
  Siren,
  Smile,
  Sparkles,
  Table,
  Terminal,
  type LucideIcon,
  Webhook,
  Workflow,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/** The lucide icons a manifest may name; any other name draws the puzzle piece. */
export const MOD_ICONS: Readonly<Record<string, LucideIcon>> = {
  bell: Bell,
  'book-open': BookOpen,
  bot: Bot,
  calendar: Calendar,
  'chart-line': ChartLine,
  'cloud-sun': CloudSun,
  'code-xml': CodeXml,
  eye: Eye,
  'file-search': FileSearch,
  'file-text': FileText,
  'flask-conical': FlaskConical,
  ghost: Ghost,
  'git-pull-request': GitPullRequest,
  globe: Globe,
  images: Images,
  keyboard: Keyboard,
  'layout-grid': LayoutGrid,
  'message-circle-question-mark': MessageCircleQuestionMark,
  package: Package,
  palette: Palette,
  plug: Plug,
  presentation: Presentation,
  puzzle: Puzzle,
  radar: Radar,
  radio: Radio,
  siren: Siren,
  smile: Smile,
  sparkles: Sparkles,
  table: Table,
  terminal: Terminal,
  webhook: Webhook,
  workflow: Workflow,
}

const SIZES = {
  md: { tile: 'size-10', glyph: 'size-5' },
  lg: { tile: 'size-16 max-md:size-12', glyph: 'size-8 max-md:size-6' },
} as const

/** A mod's icon on a square tile: its lucide icon, its own checked image, or the puzzle piece. */
export function ModGlyph({ icon, size = 'md' }: { icon: ModIcon | null; size?: keyof typeof SIZES }) {
  const { tile, glyph } = SIZES[size]
  const Icon = icon?.kind === 'lucide' ? (MOD_ICONS[icon.name] ?? Puzzle) : Puzzle
  return (
    <span
      aria-hidden
      className={cn('grid shrink-0 place-items-center border border-border bg-muted text-muted-foreground', tile)}
    >
      {icon?.kind === 'image' ? (
        <img src={icon.url} alt="" draggable={false} className={cn('object-contain', glyph)} />
      ) : (
        <Icon className={glyph} strokeWidth={1.75} />
      )}
    </span>
  )
}
