import type { ContextFile, ContextPack } from '@seti/shared'
import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { DetailPane, ListPane } from '@/components/SplitPane'
import { Button } from '@/components/ui/button'
import { useLeaveGuard } from '@/hooks/useLeaveGuard'
import { useUnseenChanges } from '@/hooks/useUnseenChanges'
import { PANES } from '@/lib/pane-size'
import { navigate } from '@/lib/route'
import { ContextList } from '@/panels/context/ContextList'
import { FileEditor } from '@/panels/context/FileEditor'
import { PackEditor } from '@/panels/context/PackEditor'
import { DEFAULT_SELECTION, packSelection, parseSelection, revisionRef } from '@/panels/context/selection'
import { KnowledgePage } from '@/panels/knowledge/KnowledgePage'

export function ContextPanel({ selectedId }: { selectedId: string | null }) {
  const [files, setFiles] = useState<ContextFile[]>([])
  const [packs, setPacks] = useState<ContextPack[]>([])
  const [dirty, setDirty] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const selected = selectedId ?? DEFAULT_SELECTION
  const selection = parseSelection(selected)
  const { isUnseen, markSeen } = useUnseenChanges(packs)
  const ref = useMemo(() => revisionRef(parseSelection(selected)), [selected])
  const selectedUnseen = ref !== null && isUnseen(ref.object_type, ref.object_id)

  useEffect(() => {
    if (selectedUnseen) {
      markSeen(ref)
    }
  }, [selectedUnseen, ref, markSeen])

  const toggleHistory = () => {
    setHistoryOpen((open) => !open)
  }

  const load = useCallback(() => {
    Promise.all([apiGet<ContextFile[]>('/context/files'), apiGet<ContextPack[]>('/context/packs')])
      .then(([nextFiles, nextPacks]) => {
        setFiles(nextFiles)
        setPacks(nextPacks)
      })
      .catch((e: unknown) => toast.error(errorText(e)))
  }, [])

  useEffect(load, [load])

  useLeaveGuard(dirty)

  const select = (next: string) => {
    if (next !== selectedId) {
      navigate('context', next)
    }
  }

  return (
    <div className="flex h-full min-h-0">
      <ListPane detailOpen={selectedId !== null} pane={PANES.context} label="Resize context list">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <h1 className="text-sm font-semibold">Context</h1>
          <Hint text="Read the files and packs again">
            <Button size="icon-sm" variant="ghost" aria-label="Refresh" onClick={load}>
              <RefreshCw />
            </Button>
          </Hint>
        </div>
        <ContextList files={files} packs={packs} selected={selected} onSelect={select} agentChanged={isUnseen} />
      </ListPane>
      <DetailPane detailOpen={selectedId !== null}>
        {selection.kind === 'knowledge' && <KnowledgePage key={selection.view} view={selection.view} />}
        {selection.kind === 'file' && (
          <FileEditor
            key={selected}
            fileKey={selection.key}
            onSaved={load}
            onDirtyChange={setDirty}
            historyOpen={historyOpen}
            onToggleHistory={toggleHistory}
          />
        )}
        {selection.kind === 'pack' && (
          <PackEditor
            key={selected}
            packId={selection.id}
            newKind={selection.newKind}
            onDirtyChange={setDirty}
            historyOpen={historyOpen}
            onToggleHistory={toggleHistory}
            onSaved={(pack) => {
              load()
              navigate('context', packSelection(pack.id), { force: true })
            }}
            onDefaultChanged={load}
            onDeleted={() => {
              load()
              navigate('context', undefined, { force: true })
            }}
          />
        )}
      </DetailPane>
    </div>
  )
}
