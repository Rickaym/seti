import type { Connection, ConnectionTemplate } from '@seti/shared'
import { useState } from 'react'
import { NewConnectionDialog } from './NewConnectionDialog'
import { TemplateForm } from './TemplateForm'
import { TemplatePicker } from './TemplatePicker'
import { TemplateResult } from './TemplateResult'

type Step =
  | { at: 'pick' }
  | { at: 'custom' }
  | { at: 'form'; template: ConnectionTemplate }
  | { at: 'made'; template: ConnectionTemplate; made: Connection[] }

/** Adding a connection: pick the service by name, fill in its short form, then test what it made. */
export function AddConnection({
  connections,
  onClose,
  onOpen,
  onAdded,
}: {
  connections: readonly Connection[]
  onClose: () => void
  onOpen: (id: string) => void
  onAdded: () => void
}) {
  const [step, setStep] = useState<Step>({ at: 'pick' })
  const pick = () => {
    setStep({ at: 'pick' })
  }
  if (step.at === 'pick') {
    return (
      <TemplatePicker
        onClose={onClose}
        onPick={(template) => {
          setStep({ at: 'form', template })
        }}
        onCustom={() => {
          setStep({ at: 'custom' })
        }}
      />
    )
  }
  if (step.at === 'custom') {
    return <NewConnectionDialog onClose={pick} onCreated={onOpen} />
  }
  if (step.at === 'form') {
    const { template } = step
    return (
      <TemplateForm
        template={template}
        taken={{
          names: new Set(connections.map((connection) => connection.name)),
          envs: new Set(connections.map((connection) => connection.env)),
        }}
        onBack={pick}
        onCreated={(made) => {
          onAdded()
          setStep({ at: 'made', template, made })
        }}
      />
    )
  }
  return <TemplateResult title={step.template.title} made={step.made} onOpen={onOpen} onClose={onClose} />
}
