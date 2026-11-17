import {
  definitionText,
  proposedDefinition,
  type SharedToolChange,
  type SharedToolDefinition,
  type ToolInputProperty,
} from '@seti/shared'
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
export function ToolNeeds({ needs }: { needs: SharedToolDefinition['needs'] }) {
  if (needs.length === 0) {
    return <p className="text-2xs text-muted-foreground">Needs no key: every agent gets it.</p>
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

function typeOf(property: ToolInputProperty): string {
  if (property.enum !== undefined) {
    return property.enum.join(' | ')
  }
  return property.type === 'array' && property.items !== undefined ? `${typeOf(property.items)}[]` : property.type
}

/** The arguments an agent passes: each with its type, whether it is required and what it means. */
export function ToolArguments({ input }: { input: SharedToolDefinition['input'] }) {
  const entries = Object.entries(input.properties)
  if (entries.length === 0) {
    return <p className="text-2xs text-muted-foreground">Takes no arguments.</p>
  }
  return (
    <ul aria-label="Arguments" className="flex flex-col gap-0.5 text-2xs text-muted-foreground">
      {entries.map(([name, property]) => (
        <li key={name} className="break-words">
          <code className="font-mono text-foreground">{name}</code> {typeOf(property)}
          {input.required.includes(name) ? ', required' : ', optional'}
          {property.description === undefined ? '' : `: ${property.description}`}
        </li>
      ))}
    </ul>
  )
}

/** Whether the tool only reads, as its proposer declared, and how long a call may run. */
export function ToolEffect({ tool }: { tool: Pick<SharedToolDefinition, 'writes' | 'timeout_seconds'> }) {
  return (
    <p className="text-2xs text-muted-foreground">
      {tool.writes ? 'Declared to change or send things outside the workspace' : 'Declared read-only'}, stopped after{' '}
      {tool.timeout_seconds} s
    </p>
  )
}

/** A proposed shared tool: what it does, its arguments, what it needs, its hash, changes and code. */
export function SharedToolProposal({ change }: { change: SharedToolChange }) {
  const { snapshot } = change
  const definition = definitionText(proposedDefinition(change))
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="break-words whitespace-pre-wrap text-foreground">{change.description}</p>
      <ToolArguments input={change.input} />
      <ToolEffect tool={change} />
      <ToolNeeds needs={change.needs} />
      <p className="text-2xs break-all text-muted-foreground" title={snapshot.sha256}>
        {snapshot.file}, sha256 <code className="font-mono">{snapshot.sha256.slice(0, HASH_CHARS)}</code>
      </p>
      {snapshot.replaces !== null && (
        <div role="region" aria-label={`Changes to ${change.name}`} className="flex flex-col gap-0.5">
          {snapshot.replaces.definition !== definition && (
            <>
              <span className="text-2xs text-muted-foreground">Changes to the published definition</span>
              <LineDiff before={snapshot.replaces.definition} after={definition} />
            </>
          )}
          {snapshot.replaces.content !== snapshot.content && (
            <>
              <span className="text-2xs text-muted-foreground">Changes to the published script</span>
              <LineDiff before={snapshot.replaces.content} after={snapshot.content} />
            </>
          )}
        </div>
      )}
      <ScriptCode name={change.name} content={snapshot.content} />
    </div>
  )
}
