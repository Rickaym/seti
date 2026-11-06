import { prListSchema, type ContextFile, type ContextPack } from '@seti/shared'
import { useMemo } from 'react'
import { useTeamChatStore } from '@/components/team/team-context'
import { useMods } from '@/hooks/useMods'
import { usePolled } from '@/hooks/usePolled'
import { useArchivedTasks, useTasks } from '@/hooks/useTasks'
import { createPolledResource } from '@/lib/polled'
import {
  agentPlaces,
  archivedPlaces,
  contextPlaces,
  prPlaces,
  sectionPlaces,
  settingsPlaces,
  type Place,
} from './places'

const NONE: readonly never[] = []

const prs = createPolledResource('/prs?scope=all', 60_000, { schema: prListSchema })
const contextFiles = createPolledResource<ContextFile[]>('/context/files', 60_000)
const contextPacks = createPolledResource<ContextPack[]>('/context/packs', 60_000)

/**
 * Every place the palette offers. Agents come from the shared task lists; the other lists poll
 * only while the palette is open and keep what they last read for the next time it opens.
 */
export function usePlaces(): Place[] {
  const team = useTeamChatStore()
  const { tasks } = useTasks()
  const { archived } = useArchivedTasks()
  const prList = usePolled(prs).data
  const files = usePolled(contextFiles).data ?? NONE
  const packs = usePolled(contextPacks).data ?? NONE
  const mods = useMods().data?.mods
  const modNames = useMemo(() => (mods ?? []).map((mod) => mod.name).join(' '), [mods])

  const sections = useMemo(
    () =>
      sectionPlaces(() => {
        team.setOpen(true)
      }),
    [team],
  )
  return useMemo(
    () => [
      ...agentPlaces(tasks),
      ...sections,
      ...prPlaces(prList),
      ...contextPlaces(files, packs),
      ...settingsPlaces(modNames),
      ...archivedPlaces(archived),
    ],
    [sections, tasks, prList, files, packs, archived, modNames],
  )
}
