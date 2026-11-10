import type { KnowledgeNote, KnowledgeSummary } from '@seti/shared'
import { CheckCheck, Hourglass, Inbox } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText } from '@/api'
import { BackButton, DetailHeader, DetailTitle } from '@/components/SplitPane'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { refreshKnowledgeWaiting } from '@/hooks/useKnowledgeWaiting'
import { navigate } from '@/lib/route'
import { KNOWLEDGE_VIEWS, knowledgeSelection, type KnowledgeView } from '@/panels/context/selection'
import { KnowledgeCard } from '@/panels/knowledge/KnowledgeCard'

const VIEWS = {
  proposed: { label: 'Proposed', icon: Inbox, empty: 'No proposals wait. Agents propose notes as they learn.' },
  approved: { label: 'Approved', icon: CheckCheck, empty: 'No approved notes yet.' },
  stale: { label: 'Stale', icon: Hourglass, empty: 'No stale notes. Notes go stale when checks fail or age out.' },
} as const

const isView = (value: string): value is KnowledgeView => (KNOWLEDGE_VIEWS as readonly string[]).includes(value)

function ViewTabs({ view, summary }: { view: KnowledgeView; summary: KnowledgeSummary | null }) {
  const count = (name: KnowledgeView) => (name === 'approved' ? null : (summary?.[name] ?? null))
  return (
    <Tabs
      value={view}
      onValueChange={(value) => {
        if (isView(value)) {
          navigate('context', knowledgeSelection(value))
        }
      }}
    >
      <TabsList variant="line" aria-label="Notes" className="h-9">
        {KNOWLEDGE_VIEWS.map((name) => {
          const Icon = VIEWS[name].icon
          const shown = count(name)
          return (
            <TabsTrigger key={name} value={name} className="flex-none px-2">
              <Icon />
              {VIEWS[name].label}
              {shown !== null && shown > 0 && (
                <span className="text-2xs text-muted-foreground tabular-nums">{shown}</span>
              )}
            </TabsTrigger>
          )
        })}
      </TabsList>
    </Tabs>
  )
}

/**
 * Notes agents propose, the user approves, and that go stale. A proposal never holds an agent
 * up, so it shows here and on the Context badge, never in Needs you.
 */
export function KnowledgePage({ view }: { view: KnowledgeView }) {
  const [notes, setNotes] = useState<KnowledgeNote[] | null>(null)
  const [summary, setSummary] = useState<KnowledgeSummary | null>(null)
  const load = useCallback(() => {
    Promise.all([apiGet<KnowledgeNote[]>(`/knowledge?status=${view}`), apiGet<KnowledgeSummary>('/knowledge/summary')])
      .then(([nextNotes, nextSummary]) => {
        setNotes(nextNotes)
        setSummary(nextSummary)
      })
      .catch((e: unknown) => toast.error(errorText(e)))
    refreshKnowledgeWaiting()
  }, [view])
  useEffect(load, [load])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DetailHeader below={<ViewTabs view={view} summary={summary} />}>
        <div className="flex items-center gap-2">
          <BackButton section="context" label="context" />
          <DetailTitle>Knowledge</DetailTitle>
        </div>
        <div className="text-xs text-muted-foreground">
          Lessons agents propose. Only notes you approve reach other agents, as titles in their instructions.
        </div>
      </DetailHeader>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 max-md:px-3 max-md:py-3">
        {notes?.length === 0 && <p className="text-sm text-muted-foreground">{VIEWS[view].empty}</p>}
        {notes?.map((note) => (
          <KnowledgeCard key={note.id} note={note} onChanged={load} />
        ))}
      </div>
    </div>
  )
}
