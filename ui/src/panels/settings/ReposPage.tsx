import type { Repo, RepoInput, WarmCacheStatus } from '@seti/shared'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPost, apiPut, errorText } from '@/api'
import { CrudEditDialog, Field } from '@/components/crud/CrudForm'
import { CrudActions, CrudTable, type CrudColumn } from '@/components/crud/CrudTable'
import { useConfirm } from '@/components/ui/confirm-context'
import { Input } from '@/components/ui/input'
import { DeleteIconButton, EditIconButton } from '@/components/ui/table-action-buttons'
import { WarmCachesFields } from './WarmCachesFields'
import { SettingsBody, SettingsHeader } from './layout'
import { parseWarmCacheForm, sameWarmCacheForm, toWarmCacheForm, type WarmCacheForm } from './warm-cache-form'

const columns: CrudColumn<Repo>[] = [
  { key: 'slug', label: 'Repo' },
  { key: 'path', label: 'Local checkout' },
  { key: 'base_branch', label: 'Base branch' },
]

const EMPTY: RepoInput = { slug: '', path: '', base_branch: '' }

const FIELDS: { key: keyof RepoInput; label: string; placeholder: string; full?: boolean }[] = [
  { key: 'slug', label: 'GitHub repo', placeholder: 'acme/web', full: true },
  { key: 'path', label: 'Local checkout', placeholder: '/home/user/web' },
  { key: 'base_branch', label: 'Base branch', placeholder: 'staging-eu' },
]

export function ReposPage() {
  const confirm = useConfirm()
  const [items, setItems] = useState<Repo[]>([])
  const [loading, setLoading] = useState(true)
  const [version, setVersion] = useState(0)
  const [error, setError] = useState('')
  const [form, setForm] = useState<RepoInput>(EMPTY)
  const [editing, setEditing] = useState<Repo | 'new' | null>(null)
  const [saving, setSaving] = useState(false)
  const [warm, setWarm] = useState<{ status: WarmCacheStatus; form: WarmCacheForm } | null>(null)

  useEffect(() => {
    apiGet<Repo[]>('/repos')
      .then((repos) => {
        setItems(repos)
        setError('')
      })
      .catch((e: unknown) => {
        setError(errorText(e))
      })
      .finally(() => {
        setLoading(false)
      })
  }, [version])

  const load = useCallback(() => {
    setLoading(true)
    setVersion((v) => v + 1)
  }, [])

  const open = (repo: Repo | 'new') => {
    setForm(repo === 'new' ? EMPTY : { slug: repo.slug, path: repo.path, base_branch: repo.base_branch })
    setEditing(repo)
    setWarm(null)
    if (repo !== 'new') {
      apiGet<WarmCacheStatus>(`/repos/${repo.id}/warm-caches`).then(
        (status) => {
          setWarm({ status, form: toWarmCacheForm(status.settings) })
        },
        (e: unknown) => {
          toast.error(errorText(e))
        },
      )
    }
  }

  /** Saves warm cache changes of the repo being edited; false when the form has a problem. */
  const saveWarm = async (repo: Repo): Promise<boolean> => {
    if (warm === null || sameWarmCacheForm(warm.form, toWarmCacheForm(warm.status.settings))) {
      return true
    }
    const parsed = parseWarmCacheForm(warm.form)
    if ('error' in parsed) {
      toast.error(parsed.error)
      return false
    }
    await apiPut<WarmCacheStatus>(`/repos/${repo.id}/warm-caches`, parsed.input)
    return true
  }

  const save = async () => {
    setSaving(true)
    try {
      if (editing === 'new') {
        await apiPost<Repo>('/repos', form)
      } else if (editing !== null) {
        if (!(await saveWarm(editing))) {
          return
        }
        await apiPut<Repo>(`/repos/${editing.id}`, form)
      }
      setEditing(null)
      load()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (repo: Repo) => {
    if (!(await confirm({ message: `Remove ${repo.slug} from Seti?`, variant: 'destructive' }))) {
      return
    }
    try {
      await apiDelete(`/repos/${repo.id}`)
      load()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  return (
    <SettingsBody
      header={
        <SettingsHeader
          title="Repos"
          description="Local checkouts agents can work in. Pull requests are listed for these repos."
          actions={
            <CrudActions
              loading={loading}
              onLoad={load}
              onCreateOpen={() => {
                open('new')
              }}
            />
          }
        />
      }
    >
      <CrudTable
        columns={columns}
        items={items}
        loading={loading}
        error={error}
        rowKey={(repo) => repo.id}
        editForm={
          <CrudEditDialog
            open={editing !== null}
            title={editing === 'new' ? 'Add repo' : 'Edit repo'}
            onCancel={() => {
              setEditing(null)
            }}
            onSave={() => void save()}
            saving={saving}
          >
            {FIELDS.map((field) => (
              <Field key={field.key} label={field.label} full={field.full ?? false}>
                <Input
                  aria-label={field.label}
                  placeholder={field.placeholder}
                  value={form[field.key]}
                  onChange={(e) => {
                    setForm({ ...form, [field.key]: e.target.value })
                  }}
                />
              </Field>
            ))}
            {warm !== null && (
              <WarmCachesFields
                status={warm.status}
                form={warm.form}
                onChange={(next) => {
                  setWarm({ ...warm, form: next })
                }}
              />
            )}
          </CrudEditDialog>
        }
        actions={(repo) => (
          <>
            <EditIconButton
              onClick={() => {
                open(repo)
              }}
            />
            <DeleteIconButton onClick={() => void remove(repo)} />
          </>
        )}
      />
    </SettingsBody>
  )
}
