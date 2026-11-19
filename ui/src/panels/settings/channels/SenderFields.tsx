import { SENDER_ALGORITHMS, SENDER_SEPARATORS, SENDER_SIGNED } from '@seti/shared'
import type { ReactNode } from 'react'
import { Field } from '@/components/crud/CrudForm'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { SenderForm } from './sender-form'

type Set = (change: Partial<SenderForm>) => void

interface Props {
  form: SenderForm
  set: Set
}

const SEPARATOR_WORDS: Record<(typeof SENDER_SEPARATORS)[number], string> = {
  none: 'One signature',
  comma: 'Comma list',
  space: 'Space list',
}

const WHERE_WORDS = { none: 'None', header: 'Header', body: 'Body field', signature: 'Signature part' } as const

function Text({
  label,
  value,
  placeholder,
  full = false,
  onChange,
}: {
  label: string
  value: string
  placeholder: string
  full?: boolean
  onChange: (value: string) => void
}) {
  return (
    <Field label={label} full={full}>
      <Input
        aria-label={label}
        placeholder={placeholder}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
        }}
      />
    </Field>
  )
}

function Pick<T extends string>({
  label,
  value,
  options,
  words,
  onChange,
}: {
  label: string
  value: T
  options: readonly T[]
  words: (option: T) => string
  onChange: (value: T) => void
}) {
  return (
    <Field label={label}>
      <Select
        value={value}
        onValueChange={(next) => {
          onChange(next as T)
        }}
      >
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {words(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

function Toggle({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string
  detail: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        <div className="text-muted-foreground">{detail}</div>
      </div>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="col-span-full grid grid-cols-1 gap-4 border-t border-border pt-3 sm:grid-cols-2">
      <legend className="float-left col-span-full text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </legend>
      {children}
    </fieldset>
  )
}

function SignatureGroup({ form, set }: Props) {
  return (
    <Group title="Signature">
      <Toggle
        label="Signs requests"
        detail="Off for an app that only sends the secret itself in a header."
        checked={form.signs}
        onChange={(signs) => {
          set({ signs })
        }}
      />
      <Toggle
        label="App secret"
        detail="The app issues the secret and you paste it; off has Seti make one."
        checked={form.appSecret}
        onChange={(appSecret) => {
          set({ appSecret })
        }}
      />
      <Text
        label="Header"
        placeholder={form.signs ? 'X-Signature' : 'X-Webhook-Token'}
        value={form.header}
        onChange={(header) => {
          set({ header })
        }}
      />
      <Text
        label="Prefix"
        placeholder={form.signs ? 'sha256=' : 'Bearer '}
        value={form.prefix}
        onChange={(prefix) => {
          set({ prefix })
        }}
      />
      {form.signs && <HmacFields form={form} set={set} />}
    </Group>
  )
}

function HmacFields({ form, set }: Props) {
  return (
    <>
      <Pick
        label="Algorithm"
        value={form.algorithm}
        options={SENDER_ALGORITHMS}
        words={(option) => `HMAC-${option.toUpperCase().replace('SHA', 'SHA-')}`}
        onChange={(algorithm) => {
          set({ algorithm })
        }}
      />
      <Pick
        label="Signed text"
        value={form.signed}
        options={SENDER_SIGNED}
        words={(option) => option}
        onChange={(signed) => {
          set({ signed })
        }}
      />
      <Pick
        label="Signatures"
        value={form.separator}
        options={SENDER_SEPARATORS}
        words={(option) => SEPARATOR_WORDS[option]}
        onChange={(separator) => {
          set({ separator })
        }}
      />
      <div className="grid gap-3">
        <Toggle
          label="Base64"
          detail="The signature is base64; off reads it as hex."
          checked={form.base64}
          onChange={(base64) => {
            set({ base64 })
          }}
        />
        <Toggle
          label="Base64 key"
          detail="The secret is base64 bytes, as after whsec_."
          checked={form.base64Key}
          onChange={(base64Key) => {
            set({ base64Key })
          }}
        />
      </div>
    </>
  )
}

function ReplayGroup({ form, set }: Props) {
  return (
    <Group title="Replay protection">
      {form.signs && (
        <>
          <Pick
            label="Timestamp in"
            value={form.timestampIn}
            options={['none', 'header', 'body', 'signature'] as const}
            words={(option) => WHERE_WORDS[option]}
            onChange={(timestampIn) => {
              set({ timestampIn })
            }}
          />
          <Text
            label="Timestamp name"
            placeholder="X-Request-Timestamp"
            value={form.timestamp}
            onChange={(timestamp) => {
              set({ timestamp })
            }}
          />
        </>
      )}
      <Pick
        label="Delivery id in"
        value={form.idIn}
        options={['none', 'header', 'body'] as const}
        words={(option) => WHERE_WORDS[option]}
        onChange={(idIn) => {
          set({ idIn })
        }}
      />
      <Text
        label="Delivery id name"
        placeholder="X-Delivery-Id"
        value={form.id}
        onChange={(id) => {
          set({ id })
        }}
      />
      {form.signs && (
        <Text
          label="Max age (s)"
          placeholder="300"
          value={form.maxAge}
          onChange={(maxAge) => {
            set({ maxAge })
          }}
        />
      )}
    </Group>
  )
}

function EventGroup({ form, set }: Props) {
  return (
    <Group title="Update">
      <Pick
        label="Event in"
        value={form.eventIn}
        options={['none', 'header', 'body'] as const}
        words={(option) => WHERE_WORDS[option]}
        onChange={(eventIn) => {
          set({ eventIn })
        }}
      />
      <Text
        label="Event name"
        placeholder="type"
        value={form.event}
        onChange={(event) => {
          set({ event })
        }}
      />
      <Text
        label="Action field"
        placeholder="action"
        value={form.action}
        onChange={(action) => {
          set({ action })
        }}
      />
      <Text
        label="Title fields"
        placeholder="data.title, data.name"
        value={form.title}
        onChange={(title) => {
          set({ title })
        }}
      />
      <Text
        label="Link fields"
        placeholder="url, data.html_url"
        value={form.link}
        onChange={(link) => {
          set({ link })
        }}
      />
      <Text
        label="Text fields"
        placeholder="data.description"
        value={form.detail}
        onChange={(detail) => {
          set({ detail })
        }}
      />
      <Text
        label="Text limit"
        placeholder="1000"
        value={form.detailMax}
        onChange={(detailMax) => {
          set({ detailMax })
        }}
      />
    </Group>
  )
}

function CheckGroup({ form, set }: Props) {
  return (
    <Group title="URL check">
      <p className="col-span-full text-muted-foreground">
        Only for an app that sends a signed check and wants one field of it sent back, as Slack does.
      </p>
      <Text
        label="Check field"
        placeholder="type"
        value={form.checkPath}
        onChange={(checkPath) => {
          set({ checkPath })
        }}
      />
      <Text
        label="Check value"
        placeholder="url_verification"
        value={form.checkEquals}
        onChange={(checkEquals) => {
          set({ checkEquals })
        }}
      />
      <Text
        label="Echo field"
        placeholder="challenge"
        value={form.checkEcho}
        onChange={(checkEcho) => {
          set({ checkEcho })
        }}
      />
    </Group>
  )
}

/** How a custom sender signs, protects against replays and names its events, field by field. */
export function SenderFields({ form, set }: Props) {
  return (
    <>
      <SignatureGroup form={form} set={set} />
      <ReplayGroup form={form} set={set} />
      <EventGroup form={form} set={set} />
      <CheckGroup form={form} set={set} />
    </>
  )
}
