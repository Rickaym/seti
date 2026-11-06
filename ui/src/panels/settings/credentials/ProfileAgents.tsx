import type { CredentialProfile } from '@seti/shared'
import { ChevronRight } from 'lucide-react'
import { navigate } from '@/lib/route'
import { SettingsCard } from '../layout'

/** The agents a credential is chosen for, each linking to the agent. */
export function ProfileAgents({ profile }: { profile: CredentialProfile }) {
  return (
    <SettingsCard title="Agents">
      <p className="border-b border-border p-3 text-muted-foreground">
        Choose an agent's credential in its details; new agents start on Default.
      </p>
      {profile.agents.length === 0 ? (
        <p className="p-3 text-muted-foreground">No agent uses this set.</p>
      ) : (
        <ul aria-label="Agents using this set">
          {profile.agents.map((agent) => (
            <li key={agent.id} className="border-b border-border last:border-b-0">
              <button
                type="button"
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent"
                onClick={() => {
                  navigate('agents', agent.id)
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{agent.title}</span>
                  {!agent.sandbox && (
                    <span className="block text-muted-foreground">
                      Unsandboxed: it uses this machine's own access, not this set
                    </span>
                  )}
                </span>
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  )
}
