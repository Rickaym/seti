import type { ModCapabilityName, ModConsentLine, ModInstallPreview } from '@seti/shared'
import {
  Bell,
  Database,
  Eye,
  FileText,
  Globe,
  Info,
  KeyRound,
  LayoutGrid,
  MessageCircleQuestionMark,
  MessageSquare,
  ScrollText,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { Hint } from '@/components/Hint'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { kb, type Bindings } from './install-state'

const ICONS: Readonly<Record<ModCapabilityName, LucideIcon>> = {
  'tasks.read': Eye,
  'tasks.manage': Wrench,
  'chat.post': MessageSquare,
  'files.read': FileText,
  'net.fetch': Globe,
  connection: KeyRound,
  storage: Database,
  notify: Bell,
  'agents.context': ScrollText,
  'seti.version': Info,
  'workspaces.layout': LayoutGrid,
  'tasks.ask': MessageCircleQuestionMark,
}

function ConnectionPicker({
  line,
  bindings,
  onBind,
}: {
  line: ModConsentLine
  bindings: Bindings
  onBind: (variable: string, id: string) => void
}) {
  if (line.capability.name !== 'connection') {
    return null
  }
  const variable = line.capability.variable
  const choices = line.connections ?? []
  if (choices.length === 0) {
    return <p className="text-muted-foreground">Add a {variable} connection in Settings, Connections first.</p>
  }
  return (
    <NativeSelect
      size="sm"
      aria-label={`Connection for ${variable}`}
      value={bindings[variable] ?? ''}
      onChange={(event) => {
        onBind(variable, event.target.value)
      }}
    >
      <NativeSelectOption value="">Pick a connection</NativeSelectOption>
      {choices.map((choice) => (
        <NativeSelectOption key={choice.id} value={choice.id}>
          {choice.name}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  )
}

/** One capability in Seti's words, its detail in a tooltip, and a picker to bind a connection. */
export function ConsentLine({
  line,
  bindings = {},
  onBind,
}: {
  line: ModConsentLine
  bindings?: Bindings
  onBind?: (variable: string, id: string) => void
}) {
  const Icon = ICONS[line.capability.name]
  const quoted = line.capability.name === 'agents.context' && line.detail !== null
  return (
    <li className="flex gap-2">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-1">
        <p>
          {line.text}
          {line.detail !== null && !quoted && (
            <Hint text={line.detail}>
              <Info aria-label="More" className="ml-1 inline size-3 text-muted-foreground" />
            </Hint>
          )}
        </p>
        {quoted && (
          <blockquote className="border-l-2 border-border pl-2 whitespace-pre-wrap text-muted-foreground">
            {line.detail}
          </blockquote>
        )}
        {onBind !== undefined && <ConnectionPicker line={line} bindings={bindings} onBind={onBind} />}
      </div>
    </li>
  )
}

/** What installing a package means, in Seti's words; the mod's own text is always quoted. */
export function ConsentView({
  preview,
  bindings,
  onBind,
}: {
  preview: ModInstallPreview
  bindings: Bindings
  onBind: (variable: string, id: string) => void
}) {
  const { manifest } = preview
  return (
    <div className="max-w-[72ch] space-y-4 text-sm" data-testid="mod-consent">
      <div className="space-y-1">
        <p className="text-muted-foreground">The mod says:</p>
        <blockquote className="border-l border-border pl-3">{manifest.description}</blockquote>
      </div>
      <div className="space-y-2">
        <p className="text-muted-foreground">It can:</p>
        {preview.capabilities.length === 0 ? (
          <p>It can only show its settings and its own views.</p>
        ) : (
          <ul aria-label={`What ${manifest.name} can do`} className="space-y-3">
            {preview.capabilities.map((line) => (
              <ConsentLine key={line.capability.name} line={line} bindings={bindings} onBind={onBind} />
            ))}
          </ul>
        )}
      </div>
      {preview.warnings.length > 0 && (
        <ul aria-label="Warnings" className="space-y-2">
          {preview.warnings.map((warning) => (
            <li key={warning} className="flex gap-2">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      )}
      {preview.earlier_data !== null && (
        <p>
          Seti has {kb(preview.earlier_data.bytes)} of data and {preview.earlier_data.settings} settings from{' '}
          {preview.earlier_data.source} of {manifest.name}.
        </p>
      )}
      {preview.problem !== null && <p className="text-destructive">{preview.problem}</p>}
    </div>
  )
}

/** What the package adds to Seti, in Seti's words. */
export function PreviewAdds({ preview }: { preview: ModInstallPreview }) {
  return preview.adds.length === 0 ? (
    <p className="text-muted-foreground">It adds nothing beyond its settings.</p>
  ) : (
    <ul aria-label={`What ${preview.manifest.name} adds`} className="list-disc space-y-1 pl-4 text-sm">
      {preview.adds.map((add) => (
        <li key={add}>{add}</li>
      ))}
    </ul>
  )
}
