import type { ClaudeCredentialMode, ClaudeStatus } from '@seti/shared'
import { KeyRound } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useRuntimes } from '@/hooks/useRuntimes'
import { openSettingsCard } from '@/lib/route'
import { SettingRow } from './layout'

const SIGN_IN: Record<ClaudeCredentialMode, string> = {
  token: "Sandboxed agents use the Claude token in Credentials; Seti's proxy adds it.",
  login: "Sandboxed agents use this machine's login. A Claude token in Credentials stops depending on it.",
  none: 'No login and no Claude token yet, so agents cannot reach Claude.',
}

function modelLine({ default_model: model, default_effort: effort }: ClaudeStatus): string {
  const named = model ?? "Claude Code's own default"
  const level = effort === null ? '' : `, effort ${effort}`
  return `${named}${level}, from Claude Code's settings. A new agent may pick another on the start page.`
}

/** Claude Code's token, program and default model: read here, changed where they live. */
export function ClaudeRuntimeRows() {
  const claude = useRuntimes().data?.claude
  if (claude === undefined) {
    return null
  }
  return (
    <>
      <SettingRow label="Token" stack description={SIGN_IN[claude.sign_in]}>
        <Hint text="Tokens live in Credentials; this page never changes them">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              openSettingsCard('credentials', 'secrets')
            }}
          >
            <KeyRound />
            Credentials
          </Button>
        </Hint>
      </SettingRow>
      <SettingRow label="Program" stack description={<span className="font-mono break-all">{claude.program}</span>}>
        <span className="text-muted-foreground">{claude.version ?? 'Version unknown'}</span>
      </SettingRow>
      <SettingRow label="Model" description={modelLine(claude)}>
        <span className="font-mono">{claude.default_model ?? 'Default'}</span>
      </SettingRow>
    </>
  )
}
