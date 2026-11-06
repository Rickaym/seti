import { CLIENT_AUTHS, envFor } from '@seti/shared'
import { Field } from '@/components/crud/CrudForm'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { ConnectionForm } from './connection-form'

const AUTH_LABEL = {
  client_secret_post: 'Client secret in the form',
  client_secret_basic: 'Client secret as Basic auth',
  private_key_jwt: 'Private key JWT (certificate)',
  none: 'None (public client)',
} as const

type TextKey = {
  [K in keyof ConnectionForm]: ConnectionForm[K] extends string ? K : never
}[keyof ConnectionForm]

type Patch = (patch: Partial<ConnectionForm>) => void

function TextInput({
  label,
  field,
  form,
  set,
  placeholder = '',
  full = false,
}: {
  label: string
  field: TextKey
  form: ConnectionForm
  set: Patch
  placeholder?: string
  full?: boolean
}) {
  return (
    <Field label={label} full={full}>
      <Input
        aria-label={label}
        className="font-mono"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={form[field]}
        onChange={(event) => {
          set({ [field]: event.target.value })
        }}
      />
    </Field>
  )
}

function HeaderFields({ form, set }: { form: ConnectionForm; set: Patch }) {
  return (
    <>
      <Field label="Seti adds it" full>
        <div className="flex items-center gap-2">
          <Switch
            aria-label="Seti adds it"
            checked={form.addsHeader}
            onCheckedChange={(on) => {
              set({ addsHeader: on })
            }}
          />
          <span className="text-xs text-muted-foreground">
            {form.addsHeader
              ? 'The proxy sets this header on every request to its hosts.'
              : 'The agent sends the variable itself; the proxy swaps in the value.'}
          </span>
        </div>
      </Field>
      {form.addsHeader && (
        <>
          <TextInput label="Header" field="header" form={form} set={set} placeholder="Authorization" />
          <TextInput label="Header value" field="template" form={form} set={set} placeholder="Bearer {{value}}" />
        </>
      )}
    </>
  )
}

function ClientFields({ form, set }: { form: ConnectionForm; set: Patch }) {
  return (
    <>
      <TextInput label="Client ID" field="clientId" form={form} set={set} placeholder="Empty to keep it secret" />
      <Field label="Client auth">
        <NativeSelect
          aria-label="Client auth"
          className="w-full"
          value={form.clientAuth}
          onChange={(event) => {
            set({ clientAuth: CLIENT_AUTHS.find((entry) => entry === event.target.value) ?? 'client_secret_post' })
          }}
        >
          {CLIENT_AUTHS.map((auth) => (
            <NativeSelectOption key={auth} value={auth}>
              {AUTH_LABEL[auth]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      {form.clientAuth === 'private_key_jwt' && (
        <>
          <TextInput
            label="Thumbprint"
            field="thumbprint"
            form={form}
            set={set}
            placeholder="Entra certificate SHA-1"
          />
          <TextInput label="Key ID" field="keyId" form={form} set={set} placeholder="Optional kid" />
        </>
      )}
    </>
  )
}

function MintFields({ form, set }: { form: ConnectionForm; set: Patch }) {
  return (
    <>
      <TextInput
        label="Token URL"
        field="tokenUrl"
        form={form}
        set={set}
        placeholder="https://login.example.com/oauth2/token"
        full
      />
      {form.kind === 'jwt_bearer' ? (
        <>
          <TextInput label="Issuer" field="issuer" form={form} set={set} placeholder="Empty for a Google key file" />
          <TextInput label="Act as" field="subject" form={form} set={set} placeholder="Optional: user@example.com" />
          {form.issuer.trim() !== '' && (
            <TextInput label="Key ID" field="keyId" form={form} set={set} placeholder="Optional kid" />
          )}
        </>
      ) : (
        <ClientFields form={form} set={set} />
      )}
      <TextInput label="Scope" field="scope" form={form} set={set} placeholder="Optional" />
      <TextInput label="Audience" field="audience" form={form} set={set} placeholder="Optional" />
      <TextInput label="Resource" field="resource" form={form} set={set} placeholder="Optional" />
      <Field label="Extra parameters" full>
        <Textarea
          aria-label="Extra parameters"
          className="font-mono"
          rows={2}
          placeholder="name=value, one per line"
          value={form.extra}
          onChange={(event) => {
            set({ extra: event.target.value })
          }}
        />
      </Field>
    </>
  )
}

/** A connection's settings: its name and variable, hosts, header and, for OAuth, how to mint. */
export function ConnectionFields({ form, set }: { form: ConnectionForm; set: Patch }) {
  return (
    <>
      <Field label="Name">
        <Input
          aria-label="Name"
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
          placeholder="stripe"
          value={form.name}
          onChange={(event) => {
            const name = event.target.value.toLowerCase()
            set(form.envEdited ? { name } : { name, env: envFor(name) })
          }}
        />
      </Field>
      <Field label="Variable">
        <Input
          aria-label="Variable"
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
          placeholder="STRIPE"
          value={form.env}
          onChange={(event) => {
            set({ env: event.target.value.toUpperCase(), envEdited: true })
          }}
        />
      </Field>
      <TextInput label="Hosts" field="hosts" form={form} set={set} placeholder="api.example.com, *.example.com" full />
      <HeaderFields form={form} set={set} />
      {form.kind !== 'key' && <MintFields form={form} set={set} />}
    </>
  )
}
