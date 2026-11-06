import type { TeamMember } from '@seti/shared'
import { BellOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPatch, errorText } from '@/api'
import { ToggleButton } from '@/components/ToggleButton'
import { useTeamChatStore } from '@/components/team/team-context'
import { Input } from '@/components/ui/input'

/** The task's @handle in the group chat, which the user can rename, and its mute switch. */
export function TaskTeam({ taskId }: { taskId: string }) {
  const store = useTeamChatStore()
  const [member, setMember] = useState<TeamMember | null>(null)
  const [handle, setHandle] = useState('')

  useEffect(() => {
    let current = true
    apiGet<TeamMember>(`/team/members/${taskId}`)
      .then((found) => {
        if (current) {
          setMember(found)
          setHandle(found.handle)
        }
      })
      .catch((e: unknown) => toast.error(errorText(e)))
    return () => {
      current = false
    }
  }, [taskId])

  const save = async (change: { handle?: string; muted?: boolean }) => {
    try {
      const saved = await apiPatch<TeamMember>(`/team/members/${taskId}`, change)
      setMember(saved)
      setHandle(saved.handle)
      store.upsertMember(saved)
    } catch (e) {
      toast.error(errorText(e))
      setHandle(member?.handle ?? '')
    }
  }

  if (member === null) {
    return <span className="text-muted-foreground">Loading...</span>
  }
  const rename = () => {
    const next = handle.trim().replace(/^@/, '').toLowerCase()
    if (next !== '' && next !== member.handle) {
      void save({ handle: next })
    } else {
      setHandle(member.handle)
    }
  }
  return (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center">
        <span className="text-muted-foreground">@</span>
        <Input
          value={handle}
          aria-label="Group chat handle"
          className="h-6 min-w-0 px-1 text-xs"
          onChange={(e) => {
            setHandle(e.target.value)
          }}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              rename()
            }
          }}
        />
      </div>
      <ToggleButton
        pressed={member.muted}
        onPressedChange={(muted) => void save({ muted })}
        icon={BellOff}
        label="Mute"
        hint="Muted, no group chat message reaches this agent on its own; it can still read and post"
      />
    </div>
  )
}
