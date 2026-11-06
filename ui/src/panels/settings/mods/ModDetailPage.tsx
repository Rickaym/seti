import type { ModDetail, ModInfo } from '@seti/shared'
import { Trash2, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiGet, apiPost, errorText } from '@/api'
import { PageHeader } from '@/components/crud/PageHeader'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { useMods } from '@/hooks/useMods'
import { navigate } from '@/lib/route'
import { SettingsBody } from '../layout'
import { ModsBack, ModIdentity } from './ModIdentity'
import { ModBadges, ModToggle } from './ModRow'
import { ModTabs } from './ModTabs'
import { UninstallDialog } from './UninstallDialog'
import { PendingUpdate } from './UpdatePanel'
import { publisherOf, REQUIRED_NOTE, tabOf } from './mod-list'
import { useModChange } from './use-mod-change'

/** The mod's README, changelog and settings, read again whenever its state in the list changes. */
function useModDetail(mod: ModInfo | undefined) {
  const [detail, setDetail] = useState<ModDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const id = mod?.id
  const stamp = mod === undefined ? '' : `${mod.version}:${String(mod.enabled)}:${mod.install?.hash ?? ''}`
  useEffect(() => {
    if (id === undefined) {
      return
    }
    let live = true
    apiGet<ModDetail>(`/mods/${id}`).then(
      (next) => {
        if (live) {
          setDetail(next)
        }
      },
      (e: unknown) => {
        if (live) {
          setError(errorText(e))
        }
      },
    )
    return () => {
      live = false
    }
  }, [id, stamp])
  return { detail, error, setDetail }
}

/** Why the mod is off although the user turned it on, or what its switch means. */
function notesOf(mod: ModInfo): string[] {
  return [
    mod.required ? REQUIRED_NOTE : null,
    mod.problem,
    mod.held_by_safe_mode ? 'Off while safe mode is on.' : null,
    mod.restart ? 'Some of what it adds takes effect after Seti restarts.' : null,
  ].filter((note): note is string => note !== null)
}

function ThirdPartyActions({ mod }: { mod: ModInfo }) {
  const confirm = useConfirm()
  const { busy, change } = useModChange()
  const [uninstalling, setUninstalling] = useState(false)
  const install = mod.install
  if (install === null) {
    return null
  }
  const previous = install.versions[0]
  const rollBack = async () => {
    if (previous === undefined) {
      return
    }
    const ok = await confirm({
      title: `Roll ${mod.name} back`,
      message: `${mod.name} goes back to ${previous.version}, with what that version may do.`,
      detail: 'Its data stays as it is.',
      confirmLabel: 'Roll back',
      icon: Undo2,
    })
    if (ok) {
      await change(
        async () => apiPost(`/mod-admin/mods/${mod.id}/rollback`, { hash: previous.hash }),
        'Seti did not roll the mod back',
      )
    }
  }
  return (
    <>
      {previous !== undefined && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void rollBack()}>
          <Undo2 />
          Roll back
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setUninstalling(true)
        }}
      >
        <Trash2 />
        Uninstall
      </Button>
      <UninstallDialog
        mod={mod}
        install={install}
        open={uninstalling}
        onOpenChange={setUninstalling}
        onDone={() => {
          setUninstalling(false)
          navigate('settings', 'mods', { force: true })
        }}
      />
    </>
  )
}

function Missing({ id, error }: { id: string; error: string | null }) {
  return (
    <SettingsBody narrow header={<PageHeader level={2} title="Mods" back={<ModsBack />} />}>
      <p className={error === null ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
        {error ?? `Seti has no mod ${id}. It may have been uninstalled.`}
      </p>
    </SettingsBody>
  )
}

/** One mod's page: who made it, its switch and lifecycle, and tabs for everything about it. */
export function ModDetailPage({ id, tab }: { id: string; tab: string | null }) {
  const { data, error } = useMods()
  const mod = data?.mods.find((entry) => entry.id === id)
  const { detail, setDetail } = useModDetail(mod)
  const { busy, toggle } = useModChange()
  const [shown, setShown] = useState(tab)
  if (mod === undefined) {
    return data === undefined && error === null ? (
      <SettingsBody narrow header={<PageHeader level={2} title="Mods" back={<ModsBack />} />}>
        <p className="text-sm text-muted-foreground">Loading...</p>
      </SettingsBody>
    ) : (
      <Missing id={id} error={error} />
    )
  }
  const selectTab = (next: string) => {
    setShown(next)
    window.history.replaceState(window.history.state, '', `#settings/mods/${id}/${next}`)
  }
  const install = mod.install
  const notes = notesOf(mod)
  return (
    <SettingsBody
      header={
        <PageHeader
          level={2}
          title={mod.display_name}
          back={<ModsBack />}
          heading={
            <ModIdentity
              icon={mod.icon}
              title={mod.display_name}
              publisher={publisherOf(mod)}
              version={mod.version}
              extra={<ModBadges mod={mod} />}
            />
          }
          actions={
            <>
              {!mod.required && (
                <ModToggle mod={mod} busy={busy} onToggle={(on) => void toggle(mod.id, on)} iconOnly={false} />
              )}
              <ThirdPartyActions mod={mod} />
            </>
          }
        />
      }
    >
      <div className="max-w-5xl space-y-4">
        <p className="max-w-[72ch] text-sm">{mod.description}</p>
        {notes.map((note) => (
          <p key={note} className={note === mod.problem ? 'text-destructive' : 'text-muted-foreground'}>
            {note}
          </p>
        ))}
        {install !== null && <PendingUpdate mod={mod} install={install} />}
        <ModTabs
          mod={mod}
          detail={detail}
          isolated={data?.unisolated !== true}
          tab={tabOf(mod, shown)}
          onTab={selectTab}
          onDetail={setDetail}
        />
      </div>
    </SettingsBody>
  )
}
