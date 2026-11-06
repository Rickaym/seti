import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

export function PrivateKeyField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <Textarea
      aria-label="Private key"
      autoComplete="off"
      spellCheck={false}
      className="font-mono text-2xs"
      rows={6}
      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
      value={value}
      onChange={(event) => {
        onChange(event.target.value)
      }}
    />
  )
}

export function PathField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <Input
      aria-label="Key file"
      autoComplete="off"
      className="font-mono"
      placeholder="~/.ssh/id_ed25519"
      value={value}
      onChange={(event) => {
        onChange(event.target.value)
      }}
    />
  )
}
