import type { SharedToolChange } from '@seti/shared'
import { LineDiff } from '@/panels/revisions/FieldChange'

const HASH_CHARS = 12

/** The script exactly as Allow publishes it; it scrolls inside its box, never the page. */
export function ScriptCode({ name, content }: { name: string; content: string }) {
  return (
    <pre
      role="region"
      aria-label={`Code of ${name}`}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region needs keyboard focus
      tabIndex={0}
      className="max-h-72 max-w-full overflow-auto border border-border bg-muted/30 px-2 py-1 font-mono text-2xs leading-relaxed whitespace-pre"
    >
      {content}
    </pre>
  )
}

/** What a tool reads and where it sends it, one variable a line. */
export function ToolNeeds({ needs }: { needs: SharedToolChange['needs'] }) {
  if (needs.length === 0) {
    return <p className="text-2xs text-muted-foreground">Needs no key: every sandboxed agent gets it.</p>
  }
  return (
    <ul aria-label="Needs" className="flex flex-col gap-0.5 text-2xs text-muted-foreground">
      {needs.map((need) => (
        <li key={need.env} className="break-all">
          <code className="font-mono text-foreground">{need.env}</code> for {need.hosts.join(', ')}
        </li>
      ))}
    </ul>
  )
}

/** A proposed shared tool: what it is for, what it needs, its hash, its changes and its code. */
export function SharedToolProposal({ change }: { change: SharedToolChange }) {
  const { snapshot } = change
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="break-words whitespace-pre-wrap text-foreground">{change.description}</p>
      <ToolNeeds needs={change.needs} />
      <p className="text-2xs break-all text-muted-foreground" title={snapshot.sha256}>
        {snapshot.file}, sha256 <code className="font-mono">{snapshot.sha256.slice(0, HASH_CHARS)}</code>
      </p>
      {snapshot.replaces !== null && (
        <div role="region" aria-label={`Changes to ${change.name}`} className="flex flex-col gap-0.5">
          <span className="text-2xs text-muted-foreground">Changes to the published version</span>
          <LineDiff before={snapshot.replaces.content} after={snapshot.content} />
        </div>
      )}
      <ScriptCode name={change.name} content={snapshot.content} />
    </div>
  )
}
