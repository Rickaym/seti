import type { ContextFileContent, WriteContextFileInput } from '@seti/shared'
import { RotateCw, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText, RequestError } from '@/api'
import { Button } from '@/components/ui/button'
import { Banner, CodeArea, EditorFrame } from '@/panels/context/EditorFrame'
import { HistoryAside, HistoryButton } from '@/panels/context/HistoryAside'
import { RevisionHistory } from '@/panels/revisions/RevisionHistory'

const fileUrl = (key: string) => `/context/files/${encodeURIComponent(key)}`

function ConflictBanner({ onReload, onOverwrite }: { onReload: () => void; onOverwrite: () => void }) {
  return (
    <Banner tone="danger">
      <span className="flex-1">
        This file changed on disk after you opened it. Reload to see the current version and drop your edits, or
        overwrite it with yours.
      </span>
      <Button size="xs" variant="outline" onClick={onReload}>
        <RotateCw />
        Reload
      </Button>
      <Button size="xs" variant="destructive" onClick={onOverwrite}>
        <Save />
        Overwrite
      </Button>
    </Banner>
  )
}

export function FileEditor({
  fileKey,
  onSaved,
  onDirtyChange,
  historyOpen,
  onToggleHistory,
}: {
  fileKey: string
  onSaved: () => void
  onDirtyChange: (dirty: boolean) => void
  historyOpen: boolean
  onToggleHistory: () => void
}) {
  const [file, setFile] = useState<ContextFileContent | null>(null)
  const [draft, setDraft] = useState('')
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [version, setVersion] = useState(0)
  const [saves, setSaves] = useState(0)

  const show = (loaded: ContextFileContent) => {
    setFile(loaded)
    setDraft(loaded.content)
    setConflict(false)
  }

  useEffect(() => {
    apiGet<ContextFileContent>(fileUrl(fileKey))
      .then((loaded) => {
        setFile(loaded)
        setDraft(loaded.content)
        setConflict(false)
      })
      .catch((e: unknown) => {
        setLoadError(errorText(e))
      })
  }, [fileKey, version])

  const dirty = file !== null && draft !== file.content
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  const write = async (baseHash: string | null) => {
    setSaving(true)
    try {
      const body: WriteContextFileInput = { content: draft, base_hash: baseHash }
      show(await apiPut<ContextFileContent>(fileUrl(fileKey), body))
      setSaves((n) => n + 1)
      onSaved()
      toast.success('Saved')
    } catch (e) {
      if (e instanceof RequestError && e.status === 409) {
        setConflict(true)
      } else {
        toast.error(errorText(e))
      }
    } finally {
      setSaving(false)
    }
  }

  const overwrite = async () => {
    try {
      const current = await apiGet<ContextFileContent>(fileUrl(fileKey))
      await write(current.hash)
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  if (file === null) {
    return <div className="p-6 text-sm text-muted-foreground">{loadError === '' ? 'Loading...' : loadError}</div>
  }

  const banner = conflict ? (
    <ConflictBanner
      onReload={() => {
        setVersion((v) => v + 1)
      }}
      onOverwrite={() => void overwrite()}
    />
  ) : (
    !file.exists && <Banner tone="info">This file does not exist yet. Saving creates it.</Banner>
  )

  return (
    <EditorFrame
      title={`${file.group} / ${file.label}`}
      subtitle={file.path}
      dirty={dirty}
      canSave={dirty || !file.exists}
      saving={saving}
      saveLabel={file.exists ? 'Save' : 'Create'}
      onSave={() => void write(file.hash)}
      banner={banner}
      actions={<HistoryButton open={historyOpen} onToggle={onToggleHistory} />}
      aside={
        historyOpen && (
          <HistoryAside>
            <RevisionHistory
              objectType="context_file"
              objectId={fileKey}
              version={version + saves}
              discardsEdits={dirty}
              onReverted={() => {
                setVersion((v) => v + 1)
                onSaved()
              }}
            />
          </HistoryAside>
        )
      }
    >
      <CodeArea label="File content" value={draft} onChange={setDraft} placeholder="# Instructions for Claude" />
    </EditorFrame>
  )
}
