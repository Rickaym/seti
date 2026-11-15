import { ChevronRight } from 'lucide-react'
import { Field } from '@/components/crud/CrudForm'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'

export interface OAuthForm {
  clientId: string
  clientSecret: string
  callbackPort: string
}

/** Your own OAuth app, for a server that does not register Claude Code on its own. */
export function OAuthFields({
  form,
  set,
  open,
}: {
  form: OAuthForm
  set: (patch: Partial<OAuthForm>) => void
  open: boolean
}) {
  return (
    <Collapsible defaultOpen={open} className="col-span-full grid gap-2">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="xs" className="group justify-self-start px-0">
          <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
          OAuth app
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-3 sm:grid-cols-2">
        <p className="col-span-full text-xs text-muted-foreground">
          Only for servers that need an app you registered with them; most sign in without one.
        </p>
        <Field label="Client ID" full>
          <Input
            aria-label="Client ID"
            autoComplete="off"
            value={form.clientId}
            onChange={(e) => {
              set({ clientId: e.target.value })
            }}
          />
        </Field>
        <Field label="Client secret">
          <Input
            aria-label="Client secret"
            type="password"
            autoComplete="off"
            value={form.clientSecret}
            onChange={(e) => {
              set({ clientSecret: e.target.value })
            }}
          />
        </Field>
        <Field label="Callback port">
          <Input
            aria-label="Callback port"
            inputMode="numeric"
            placeholder="Any free port"
            value={form.callbackPort}
            onChange={(e) => {
              set({ callbackPort: e.target.value.replace(/\D/g, '') })
            }}
          />
        </Field>
      </CollapsibleContent>
    </Collapsible>
  )
}
