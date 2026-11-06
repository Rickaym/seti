import type { ModInfo } from '@seti/shared'
import { Search, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SettingsList } from '../layout'
import { ModRow } from './ModRow'
import {
  EMPTY_FILTER,
  FILTER_LABELS,
  MOD_FILTERS,
  filterCounts,
  inFilter,
  matchesQuery,
  type ModFilter,
} from './mod-list'

const isFilter = (value: string): value is ModFilter => (MOD_FILTERS as readonly string[]).includes(value)

function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        aria-label="Search mods"
        placeholder="Search by name, publisher or category"
        className="h-9 pr-8 pl-8"
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value !== '') {
            event.stopPropagation()
            onChange('')
          }
        }}
      />
      {value !== '' && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Clear search"
          className="absolute top-1/2 right-1 -translate-y-1/2"
          onClick={() => {
            onChange('')
          }}
        >
          <X />
        </Button>
      )}
    </div>
  )
}

function FilterTabs({
  mods,
  filter,
  onChange,
}: {
  mods: readonly ModInfo[]
  filter: ModFilter
  onChange: (filter: ModFilter) => void
}) {
  const counts = filterCounts(mods)
  return (
    <Tabs
      value={filter}
      onValueChange={(value) => {
        if (isFilter(value)) {
          onChange(value)
        }
      }}
    >
      <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none]">
        <TabsList variant="line" aria-label="Show" className="h-9">
          {MOD_FILTERS.map((name) => (
            <TabsTrigger key={name} value={name} className="flex-none px-2">
              {FILTER_LABELS[name]}
              <span className="text-2xs text-muted-foreground tabular-nums">{counts[name]}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </Tabs>
  )
}

/** Every mod, found by words and narrowed by a filter, each with its switch. */
export function ModList({
  mods,
  busy,
  onToggle,
}: {
  mods: readonly ModInfo[]
  busy: boolean
  onToggle: (mod: ModInfo, on: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ModFilter>('all')
  const shown = mods.filter((mod) => inFilter(mod, filter) && matchesQuery(mod, query))
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <SearchField value={query} onChange={setQuery} />
        <FilterTabs mods={mods} filter={filter} onChange={setFilter} />
      </div>
      <SettingsList label="Mods">
        {shown.length === 0 ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-6 text-muted-foreground">
            <span>{query === '' ? EMPTY_FILTER[filter] : `No mod matches "${query}".`}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery('')
                setFilter('all')
              }}
            >
              <X />
              Show all
            </Button>
          </div>
        ) : (
          <ul aria-label="Mods">
            {shown.map((mod) => (
              <ModRow
                key={mod.id === '' ? mod.display_name : mod.id}
                mod={mod}
                busy={busy}
                onToggle={(on) => {
                  onToggle(mod, on)
                }}
              />
            ))}
          </ul>
        )}
      </SettingsList>
    </div>
  )
}
