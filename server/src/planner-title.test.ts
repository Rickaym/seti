import { plannerOutput, type PlannerOutput } from '@seti/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { checkPlan } from './planner-rules.js'
import { titleFor, titleProblem } from './planner-title.js'
import { planTitle, setPlannerModel } from './planner.js'

const NO_CHOICES = { packs: [], mcp: [], ssh_hosts: [], aws: { available: false, default_enabled: false } }

const plan = (message: string, fields: Partial<PlannerOutput>) =>
  checkPlan({ raw: plannerOutput.parse(fields), message, reason: null, ms: 4300 }, NO_CHOICES)

const STEPS = [
  '1. Call the test number and wait for the greeting',
  '2. Say the ID number 12345678901 when asked',
  '3. Give the phone number 0555 000 00 00',
  '4. Ask to block the card and confirm',
].join('\n')

const TURKISH = '1. Test numarasini arayin\n2. Kimlik numarasi 12345678901 verin\n3. Karti kapatmasini isteyin'

const ANSWERED = 'The planner answered the message instead of titling it'

describe('a title that is not a name for the work', () => {
  it('names a list of steps from its first line when the model answers with a status', () => {
    const planned = plan(STEPS, { title: 'Suspended - unable to process request' })
    expect(planned.title).toBe('1. Call the test number and wait for the greeting')
    expect(planned.setup).toMatchObject({ planner: 'model', fallback_reason: ANSWERED })
  })

  it('names a message in another language from its own words when the model apologises', () => {
    const planned = plan(TURKISH, { title: "I'm sorry, I can't help with that" })
    expect(planned.title).toBe('1. Test numarasini arayin')
    expect(planned.setup.fallback_reason).toBe(ANSWERED)
  })

  it('records an empty title as the model finding nothing to name', () => {
    expect(plan(STEPS, { title: '' }).setup.fallback_reason).toBe('The planner gave no title')
  })

  it('keeps a title in the message language and one about the words the message uses', () => {
    expect(plan(TURKISH, { title: 'Test aramasi ve kart kapatma' })).toMatchObject({
      title: 'Test aramasi ve kart kapatma',
      setup: { fallback_reason: null },
    })
    expect(
      titleProblem('Fix "cannot connect" when the card is declined', 'it says cannot connect, card declined'),
    ).toBeNull()
    expect(titleProblem('Summarise the incident', 'what happened last night?')).toBeNull()
    expect(titleProblem('Find why my tests fail', 'why do my tests fail')).toBeNull()
  })
})

const OPENERS = ['', "I'm sorry, ", 'Sorry - ', 'Unfortunately ', 'Request ']
const REFUSALS = [
  'unable to process request',
  "I can't help with that",
  'I cannot assist with this',
  'suspended',
  'I apologise, but no',
  'I must decline',
  'refused: personal data',
  "I won't follow these steps",
  'Account suspended',
]

describe('refusal shapes', () => {
  it('never become a title, whatever the message about other work says', () => {
    const messages = [STEPS, TURKISH, 'fix the login page', 'deploy the API and check the logs', '']
    for (const message of messages) {
      for (const opener of OPENERS) {
        for (const refusal of REFUSALS) {
          const raw = `${opener}${refusal}`
          const { title, problem } = titleFor(raw, message)
          expect(problem, raw).not.toBeNull()
          expect(title.toLowerCase(), raw).not.toContain(refusal.toLowerCase())
        }
      }
    }
  })
})

describe('a title alone', () => {
  afterEach(() => {
    setPlannerModel(async () => Promise.reject(new Error('no model in tests')))
  })

  it('comes from the message when the model refuses', async () => {
    setPlannerModel(async () => Promise.resolve({ title: 'Unable to process request' }))
    expect(await planTitle('rename the widgets')).toBe('Rename the widgets')
  })
})
