import { modTitle, shortModHash, type ModInstallPreview, type ModList } from '@seti/shared'
import { Download, Eraser, FolderOpen, GitBranch, SearchCheck, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { ToggleButton } from '@/components/ToggleButton'
import { PageHeader } from '@/components/crud/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { refreshMods } from '@/hooks/useMods'
import { withStepUp } from '@/lib/passkeys'
import { navigate } from '@/lib/route'
import { SettingsBody } from '../layout'
import { ConsentView, PreviewAdds } from './ConsentView'
import { ModIdentity, ModsBack } from './ModIdentity'
import { ModMarkdown } from './ModMarkdown'
import { allBound, kb, type Bindings } from './install-state'

const failed = (title: string) => (e: unknown) => {
  toast.error(title, { description: errorText(e), duration: Infinity })
}

interface Source {
  git: boolean
  path: string
  url: string
  ref: string
}

function SourceForm({
  source,
  busy,
  onChange,
  onCheck,
}: {
  source: Source
  busy: boolean
  onChange: (source: Source) => void
  onCheck: () => void
}) {
  const ready = source.git ? source.url.trim() !== '' && source.ref.trim() !== '' : source.path.trim() !== ''
  return (
    <section aria-label="Source" className="space-y-3 border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleButton
          pressed={source.git}
          onPressedChange={(git) => {
            onChange({ ...source, git })
          }}
          icon={source.git ? GitBranch : FolderOpen}
          label={source.git ? 'Git' : 'Folder'}
          hint={source.git ? 'Read a git repository at a branch, tag or commit' : 'Read a folder on the Seti host'}
        />
        <span className="text-xs text-muted-foreground">
          {source.git ? 'An https repository at a branch, tag or commit.' : 'A folder on the machine Seti runs on.'}
        </span>
      </div>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (ready && !busy) {
            onCheck()
          }
        }}
      >
        {source.git ? (
          <div className="grid gap-2 sm:grid-cols-[1fr_9rem]">
            <Input
              aria-label="Repository URL"
              placeholder="https://..."
              className="h-9"
              value={source.url}
              onChange={(e) => {
                onChange({ ...source, url: e.target.value })
              }}
            />
            <Input
              aria-label="Branch, tag or commit"
              className="h-9"
              value={source.ref}
              onChange={(e) => {
                onChange({ ...source, ref: e.target.value })
              }}
            />
          </div>
        ) : (
          <Input
            aria-label="Folder"
            placeholder="/path/to/mod"
            className="h-9"
            value={source.path}
            onChange={(e) => {
              onChange({ ...source, path: e.target.value })
            }}
          />
        )}
        <Button type="submit" size="sm" variant="outline" disabled={busy || !ready}>
          <SearchCheck />
          Check
        </Button>
      </form>
    </section>
  )
}

function Preview({
  preview,
  bindings,
  onBind,
}: {
  preview: ModInstallPreview
  bindings: Bindings
  onBind: (variable: string, id: string) => void
}) {
  const { manifest } = preview
  const author = manifest.author === undefined ? 'Unknown publisher (unverified)' : `by ${manifest.author} (unverified)`
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <ModIdentity icon={preview.icon} title={modTitle(manifest)} publisher={author} version={manifest.version} />
        <p className="text-xs break-all text-muted-foreground">
          {preview.source.display}, {shortModHash(preview.hash)}, {kb(preview.size)}
        </p>
      </div>
      <Tabs defaultValue="permissions" className="gap-4">
        <div className="-mx-1 overflow-x-auto border-b border-border px-1 [scrollbar-width:none]">
          <TabsList variant="line" aria-label={`${manifest.name} preview`} className="h-9">
            <TabsTrigger value="permissions" className="flex-none px-2.5">
              Permissions
            </TabsTrigger>
            <TabsTrigger value="details" className="flex-none px-2.5">
              Details
            </TabsTrigger>
            <TabsTrigger value="contributes" className="flex-none px-2.5">
              Contributes
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="permissions">
          <ConsentView preview={preview} bindings={bindings} onBind={onBind} />
        </TabsContent>
        <TabsContent value="details">
          <ModMarkdown text={preview.readme} empty="This mod has no README." />
        </TabsContent>
        <TabsContent value="contributes">
          <PreviewAdds preview={preview} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** Reads a mod from a folder or a git repository, shows what it is and may do, and installs it. */
export function AddModPage() {
  const [source, setSource] = useState<Source>({ git: false, path: '', url: '', ref: 'main' })
  const [preview, setPreview] = useState<ModInstallPreview | null>(null)
  const [bindings, setBindings] = useState<Bindings>({})
  const [fresh, setFresh] = useState(true)
  const [busy, setBusy] = useState(false)
  const reset = () => {
    setPreview(null)
    setBindings({})
    setFresh(true)
  }
  const check = async () => {
    setBusy(true)
    reset()
    const body = source.git ? { kind: 'git', url: source.url, ref: source.ref } : { kind: 'folder', path: source.path }
    await apiPost<ModInstallPreview>('/mod-admin/preview', { source: body })
      .then(setPreview, failed('Seti did not read the mod'))
      .finally(() => {
        setBusy(false)
      })
  }
  const install = async (checked: ModInstallPreview) => {
    setBusy(true)
    const body = {
      mod_id: checked.mod_id,
      hash: checked.hash,
      connections: bindings,
      delete_earlier_data: checked.earlier_data !== null && fresh,
    }
    await withStepUp(async () => apiPost<ModList>('/mod-admin/install', body))
      .then(() => {
        refreshMods()
        navigate('settings', `mods/${checked.mod_id}`, { force: true })
      }, failed('Seti did not install the mod'))
      .finally(() => {
        setBusy(false)
      })
  }
  const ready = preview !== null && preview.problem === null && allBound(preview.capabilities, bindings)
  return (
    <SettingsBody
      narrow
      header={
        <PageHeader
          level={2}
          title="Add a mod"
          description="Seti reads the package and shows what it may do. Nothing runs until you install it."
          back={<ModsBack />}
        />
      }
    >
      <div className="space-y-5">
        <SourceForm
          source={source}
          busy={busy}
          onChange={(next) => {
            setSource(next)
            reset()
          }}
          onCheck={() => void check()}
        />
        {preview !== null && (
          <section aria-label="Check" className="space-y-4">
            <Preview
              preview={preview}
              bindings={bindings}
              onBind={(variable, id) => {
                setBindings((was) => ({ ...was, [variable]: id }))
              }}
            />
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              {preview.earlier_data !== null && (
                <ToggleButton
                  pressed={fresh}
                  onPressedChange={setFresh}
                  icon={Eraser}
                  label="Fresh start"
                  hint={fresh ? 'Delete the data the earlier install left' : 'Keep the data the earlier install left'}
                />
              )}
              <div className="ml-auto flex gap-2">
                <Button variant="outline" size="sm" onClick={reset}>
                  <X />
                  Cancel
                </Button>
                <Button size="sm" disabled={busy || !ready} onClick={() => void install(preview)}>
                  <Download />
                  Install
                </Button>
              </div>
            </div>
          </section>
        )}
      </div>
    </SettingsBody>
  )
}
