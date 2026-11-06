import type { ComponentResources } from '@seti/shared'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useNarrow } from '@/hooks/useMedia'
import { cn } from '@/lib/utils'
import { ageLabel, bytesLabel, percentLabel } from '@/panels/resources/format'
import { SettingsCard } from '@/panels/settings/layout'

const STATE_DOT: Record<ComponentResources['state'], string> = {
  up: 'bg-success',
  down: 'bg-destructive',
  off: 'bg-muted-foreground/50',
}

function State({ component }: { component: ComponentResources }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('size-2 shrink-0', STATE_DOT[component.state])} aria-hidden />
      <span className={cn(component.state === 'down' && 'font-semibold text-destructive')}>{component.state}</span>
    </span>
  )
}

const measured = (c: ComponentResources) => c.state === 'up' && c.pid !== null

const memoryText = (c: ComponentResources) => (measured(c) ? bytesLabel(c.rss_bytes) : '-')

const detailText = (c: ComponentResources) =>
  c.detail === null ? '' : `${c.detail.label} ${bytesLabel(c.detail.bytes)}`

function ComponentList({ components }: { components: readonly ComponentResources[] }) {
  return (
    <ul>
      {components.map((c) => (
        <li key={c.id} aria-label={c.name} className="border-b border-border px-3 py-2 last:border-b-0">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">{c.name}</span>
            <State component={c} />
          </div>
          {c.state === 'up' && (
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-muted-foreground tabular-nums">
              {measured(c) && <span>{memoryText(c)}</span>}
              {c.cpu_percent !== null && <span>{percentLabel(c.cpu_percent)} CPU</span>}
              {c.uptime_s !== null && <span>up {ageLabel(c.uptime_s)}</span>}
              {c.detail !== null && <span>{detailText(c)}</span>}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function ComponentTable({ components }: { components: readonly ComponentResources[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Component</TableHead>
          <TableHead>State</TableHead>
          <TableHead className="text-right">Memory</TableHead>
          <TableHead className="text-right">CPU</TableHead>
          <TableHead className="text-right">Uptime</TableHead>
          <TableHead className="text-right">PID</TableHead>
          <TableHead>Detail</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {components.map((c) => (
          <TableRow key={c.id} aria-label={c.name}>
            <TableCell className="font-medium">{c.name}</TableCell>
            <TableCell>
              <State component={c} />
            </TableCell>
            <TableCell className="text-right tabular-nums">{memoryText(c)}</TableCell>
            <TableCell className="text-right tabular-nums">{percentLabel(c.cpu_percent)}</TableCell>
            <TableCell className="text-right tabular-nums">{ageLabel(c.uptime_s)}</TableCell>
            <TableCell
              className="text-right text-muted-foreground tabular-nums"
              title={`${String(c.processes)} processes`}
            >
              {c.pid ?? '-'}
            </TableCell>
            <TableCell className="text-muted-foreground tabular-nums">{detailText(c)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function ComponentsCard({ components }: { components: readonly ComponentResources[] }) {
  const narrow = useNarrow()
  return (
    <SettingsCard title="Seti components">
      {narrow ? <ComponentList components={components} /> : <ComponentTable components={components} />}
    </SettingsCard>
  )
}
