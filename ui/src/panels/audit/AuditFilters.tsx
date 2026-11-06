import { AUDIT_ACTOR_FILTERS, AUDIT_AREAS, type AuditActorFilter, type AuditArea } from '@seti/shared'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AREA_LABELS, isArea } from './format'

const ALL = 'all'

const isActor = (value: string): value is AuditActorFilter => (AUDIT_ACTOR_FILTERS as readonly string[]).includes(value)

export function AuditFilters({
  area,
  actor,
  search,
  onArea,
  onActor,
  onSearch,
}: {
  area: AuditArea | null
  actor: AuditActorFilter | null
  search: string
  onArea: (area: AuditArea | null) => void
  onActor: (actor: AuditActorFilter | null) => void
  onSearch: (text: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select
        value={area ?? ALL}
        onValueChange={(value) => {
          onArea(isArea(value) ? value : null)
        }}
      >
        <SelectTrigger aria-label="Area" size="sm" className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All areas</SelectItem>
          {AUDIT_AREAS.map((value) => (
            <SelectItem key={value} value={value}>
              {AREA_LABELS[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={actor ?? ALL}
        onValueChange={(value) => {
          onActor(isActor(value) ? value : null)
        }}
      >
        <SelectTrigger aria-label="Actor" size="sm" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All actors</SelectItem>
          {AUDIT_ACTOR_FILTERS.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="relative w-80">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Search audit log"
          placeholder="Search summaries, events and ids"
          className="h-7 pl-8"
          value={search}
          onChange={(e) => {
            onSearch(e.target.value)
          }}
        />
      </div>
    </div>
  )
}
