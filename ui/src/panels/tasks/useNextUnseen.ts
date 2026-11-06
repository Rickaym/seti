import { CircleDot } from 'lucide-react'
import { toast } from 'sonner'
import { useCommands } from '@/components/palette/useCommands'
import { chordLabel, CHORDS, useChords } from '@/components/shortcuts/chords'
import { useTasks } from '@/hooks/useTasks'
import { navigate, type Route } from '@/lib/route'
import { nextUnseen } from './agent-list'

/** Alt+U and the palette open the newest agent that finished since the user last looked. */
export function useNextUnseen(route: Route): void {
  const { tasks } = useTasks()
  const next = nextUnseen(tasks, route.section === 'agents' ? route.id : null)
  const open = () => {
    if (next === null) {
      toast('No unseen agents')
    } else {
      navigate('agents', next)
    }
  }
  useChords([{ chord: CHORDS.nextUnseen, run: open }])
  useCommands([
    {
      id: 'agent.next-unseen',
      title: 'Next unseen agent',
      icon: CircleDot,
      group: 'General',
      keywords: 'unseen unread finished done new jump',
      shortcut: chordLabel(CHORDS.nextUnseen),
      when: () => next !== null,
      run: open,
    },
  ])
}
