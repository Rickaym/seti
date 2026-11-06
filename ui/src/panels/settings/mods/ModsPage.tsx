import type { ModList as ModListData } from '@seti/shared'
import { Code, Plus, SearchCheck, ShieldCheck } from 'lucide-react'
import { apiPost, apiPut } from '@/api'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { Button } from '@/components/ui/button'
import { useMods } from '@/hooks/useMods'
import { navigate } from '@/lib/route'
import { SettingsBody, SettingsHeader } from '../layout'
import { AddModPage } from './AddModPage'
import { ModDetailPage } from './ModDetailPage'
import { ModList } from './ModList'
import { modsRoute } from './mod-list'
import { useModChange } from './use-mod-change'

type Change = ReturnType<typeof useModChange>['change']

/** Safe mode, Developer mode, mod bisect and, with Developer mode on, Add. */
function ModsActions({ data, busy, change }: { data: ModListData | undefined; busy: boolean; change: Change }) {
  const devMode = data?.dev_mode ?? false
  return (
    <>
      <ToggleButton
        pressed={data?.safe_mode ?? false}
        disabled={busy || data === undefined || data.safe_mode_forced}
        onPressedChange={(on) => void change(async () => apiPut<ModListData>('/mods', { safe_mode: on }))}
        icon={ShieldCheck}
        label="Safe mode"
        hint={
          data?.safe_mode_forced === true
            ? 'SETI_SAFE_MODE=1 keeps safe mode on'
            : 'Keep every third-party mod off, to rule them out when something breaks'
        }
      />
      <ToggleButton
        pressed={devMode}
        disabled={busy || data === undefined}
        onPressedChange={(on) => void change(async () => apiPut<ModListData>('/mod-admin/dev-mode', { on }))}
        icon={Code}
        label="Developer mode"
        hint="Install third-party mods and load dev mods from a folder; off by default"
      />
      <Hint text="Turn half of the mods off at a time to find the one behind a problem">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || (data?.bisect ?? null) !== null}
          onClick={() => void change(async () => apiPost('/mod-admin/bisect'))}
        >
          <SearchCheck />
          Find culprit
        </Button>
      </Hint>
      {devMode && (
        <Hint text="Install a mod from a folder or a git repository">
          <Button
            size="sm"
            onClick={() => {
              navigate('settings', 'mods/add')
            }}
          >
            <Plus />
            Add
          </Button>
        </Hint>
      )}
    </>
  )
}

function Notices({ data, error }: { data: ModListData | undefined; error: string | null }) {
  return (
    <>
      {data?.safe_mode === true && <p className="mb-3 text-sm">Safe mode: every third-party mod is off.</p>}
      {data?.unisolated === true && (
        <p className="mb-3 text-sm text-muted-foreground">
          Third-party mods run without network isolation: bwrap is not installed.
        </p>
      )}
      {error !== null && <p className="mb-3 text-sm text-destructive">{error}</p>}
      {data === undefined && error === null && <p className="text-sm text-muted-foreground">Loading...</p>}
      {data?.mods.length === 0 && <p className="text-sm text-muted-foreground">Seti ships no mods yet.</p>}
    </>
  )
}

/** The mods Seti has, found by search and filters, each with its switch; safe mode and Add above. */
function ModsListPage() {
  const { data, error } = useMods()
  const { busy, change, toggle } = useModChange()
  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader
          title="Mods"
          description="Mods add to Seti through one declared API. Each says what it may do; turn one on to give it that."
          actions={<ModsActions data={data} busy={busy} change={change} />}
        />
      }
    >
      <Notices data={data} error={error} />
      {data !== undefined && data.mods.length > 0 && (
        <ModList mods={data.mods} busy={busy} onToggle={(mod, on) => void toggle(mod.id, on)} />
      )}
    </SettingsBody>
  )
}

/** Settings, Mods: the list, a mod's page at `mods/<id>`, and the add flow at `mods/add`. */
export function ModsPage({ detail }: { detail: string | null }) {
  const route = modsRoute(detail)
  if (route.kind === 'add') {
    return <AddModPage />
  }
  return route.kind === 'mod' ? <ModDetailPage key={route.id} id={route.id} tab={route.tab} /> : <ModsListPage />
}
