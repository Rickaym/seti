import type { DreamProposal } from '@seti/shared'
import { Check, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'

const KIND_WORDS: Record<DreamProposal['kind'], string> = {
  trash: 'Trash',
  remove_worktree: 'Remove worktree',
  delete_branch: 'Delete branch',
}

/**
 * The clean-ups the agent's dreams proposed that wait for the user, each with Allow and Deny;
 * read again whenever `latest` (the last dream and its state) changes.
 */
export function DreamProposals({ taskId, open, latest }: { taskId: string; open: boolean; latest: string }) {
  const [pending, setPending] = useState<DreamProposal[]>([])
  const load = useCallback(() => {
    apiGet<DreamProposal[]>(`/dreams/proposals?task=${taskId}`).then(setPending, (e: unknown) =>
      toast.error(errorText(e)),
    )
  }, [taskId])
  useEffect(() => {
    if (open) {
      load()
    }
  }, [open, load, latest])

  const decide = (proposal: DreamProposal, decision: 'allow' | 'deny') => {
    apiPost<DreamProposal>(`/dreams/proposals/${String(proposal.id)}`, { decision })
      .then((decided) => {
        if (decided.state === 'failed') {
          toast.error(`Not cleaned: ${decided.detail ?? 'it is no longer safe'}`)
        }
        load()
      })
      .catch((e: unknown) => toast.error(errorText(e)))
  }

  if (pending.length === 0) {
    return null
  }
  return (
    <ul aria-label="Clean-ups" className="grid gap-1">
      {pending.map((proposal) => (
        <li key={proposal.id} className="grid gap-1 text-2xs">
          <Hint text={proposal.reason}>
            <span className="min-w-0 truncate">
              {KIND_WORDS[proposal.kind]}: <span className="font-mono">{proposal.target}</span>
            </span>
          </Hint>
          <span className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                decide(proposal, 'allow')
              }}
            >
              <Check />
              Allow
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                decide(proposal, 'deny')
              }}
            >
              <X />
              Deny
            </Button>
          </span>
        </li>
      ))}
    </ul>
  )
}
