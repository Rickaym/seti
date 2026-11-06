import type { Connection } from '@seti/shared'
import { ArrowLeft, ChevronRight, CircleDashed, Plus, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { apiGet, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { PageHeader } from '@/components/crud/PageHeader'
import { Button } from '@/components/ui/button'
import { navigate } from '@/lib/route'
import { SettingsBody, SettingsHeader, SettingsList } from '../layout'
import { ConnectionDetail } from './ConnectionDetail'
import { NewConnectionDialog } from './NewConnectionDialog'
import { kindLabel, statusText } from './connection-form'

const open = (id: string) => {
  navigate('settings', `connections/${id}`, { force: true })
}

function Status({ connection }: { connection: Connection }) {
  const text = statusText(connection)
  if (text === null) {
    return null
  }
  const failed = connection.missing.length === 0
  const Icon = failed ? TriangleAlert : CircleDashed
  return (
    <p
      className={
        failed
          ? 'mt-1 flex items-start gap-1.5 text-warning-text'
          : 'mt-1 flex items-start gap-1.5 text-muted-foreground'
      }
    >
      <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  )
}

function Row({ connection }: { connection: Connection }) {
  const carriers = connection.profiles.map((profile) => profile.name).join(', ')
  return (
    <li
      aria-label={connection.name}
      className="relative border-b border-border px-3 py-3 last:border-b-0 hover:bg-accent"
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="min-w-0 truncate text-left font-mono text-sm font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
          onClick={() => {
            open(connection.id)
          }}
        >
          {connection.name}
        </button>
        <span className="shrink-0 text-2xs text-muted-foreground">{kindLabel(connection)}</span>
        <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden />
      </div>
      <p className="mt-1 text-2xs wrap-anywhere text-muted-foreground">
        {connection.hosts.length === 0 ? 'No hosts' : connection.hosts.join(', ')} -{' '}
        {carriers === '' ? 'In no credential' : `In ${carriers}`}
      </p>
      <Status connection={connection} />
    </li>
  )
}

function useConnections() {
  const [list, setList] = useState<Connection[] | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(() => {
    apiGet<Connection[]>('/connections').then(
      (next) => {
        setList(next)
        setError('')
      },
      (e: unknown) => {
        setError(errorText(e))
      },
    )
  }, [])
  useEffect(reload, [reload])
  return { list, setList, error, reload }
}

function ConnectionList() {
  const { list, error } = useConnections()
  const [adding, setAdding] = useState(false)
  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader
          title="Connections"
          description="One service's access each: its hosts, how Seti signs in and the values it holds. A credential carries connections to the agents that pick it. Saved values are never shown again."
          actions={
            <Hint text="New connection">
              <Button
                size="sm"
                onClick={() => {
                  setAdding(true)
                }}
              >
                <Plus />
                Connection
              </Button>
            </Hint>
          }
        />
      }
    >
      <SettingsList label="Connections">
        {list === null && (
          <p className={error === '' ? 'p-3 text-muted-foreground' : 'p-3 text-destructive'}>
            {error === '' ? 'Loading...' : error}
          </p>
        )}
        {list?.length === 0 && <p className="p-3 text-muted-foreground">No connections yet.</p>}
        {list !== null && list.length > 0 && (
          <ul aria-label="Connections">
            {list.map((connection) => (
              <Row key={connection.id} connection={connection} />
            ))}
          </ul>
        )}
      </SettingsList>
      {adding && (
        <NewConnectionDialog
          onClose={() => {
            setAdding(false)
          }}
          onCreated={open}
        />
      )}
    </SettingsBody>
  )
}

function Back() {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="-ml-2 shrink-0"
      aria-label="Back to connections"
      onClick={() => {
        navigate('settings', 'connections')
      }}
    >
      <ArrowLeft />
    </Button>
  )
}

function ConnectionPage({ id }: { id: string }) {
  const { list, setList, error, reload } = useConnections()
  const connection = list?.find((entry) => entry.id === id)
  const header = (title: string) => <PageHeader level={2} title={title} back={<Back />} />
  if (connection === undefined) {
    const waiting = error === '' ? 'Loading...' : error
    const text = list === null ? waiting : 'No such connection. It may have been deleted.'
    return (
      <SettingsBody narrow header={header('Connections')}>
        <p className={list === null && error === '' ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
          {text}
        </p>
      </SettingsBody>
    )
  }
  return (
    <SettingsBody narrow header={header(connection.name)}>
      <ConnectionDetail
        connection={connection}
        reload={reload}
        onChanged={(next) => {
          setList((prev) => prev?.map((entry) => (entry.id === next.id ? next : entry)) ?? null)
        }}
      />
    </SettingsBody>
  )
}

/** Every connection, or one when the route names it. */
export function ConnectionsPage({ connectionId }: { connectionId: string | null }) {
  return connectionId === null ? <ConnectionList /> : <ConnectionPage id={connectionId} />
}
