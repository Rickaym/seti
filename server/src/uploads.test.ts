import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  ATTACHMENT_FILE_MAX,
  auditQuery,
  type MessageRow,
  type PromptPayload,
  type StagedUpload,
  type Task,
} from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { SETI_HOME } from './config.js'
import { messages, tasks } from './db.js'
import { setPlannerModel } from './planner.js'
import { auditEvents } from './store/audit.js'
import { USER_AUTH } from './test-auth.js'
import { imageSize, sniff } from './upload-sniff.js'
import { checkStaged, safeName } from './uploads.js'
import { waitIdle } from './wait-idle.js'
import { workspaceDir } from './workspace/dir.js'

const sdk = await vi.hoisted(async () => {
  const fakes = await import('./fake-sdk.js')
  const fake = new fakes.FakeSdk(function* ({ text }) {
    yield fakes.fakeAssistant(`read ${String(text.length)} characters`)
    yield fakes.fakeResult()
  })
  return { fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
const auth = { host: 'localhost', ...USER_AUTH }

/** A PNG header that says how big the image is; the rest of the file does not matter here. */
function png(width: number, height: number): Buffer {
  const head = Buffer.alloc(64)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'latin1')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return head
}

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n')
const JSON_PASTE = JSON.stringify({ a: 1, b: [1, 2] }, null, 2)

async function upload(
  body: string | Uint8Array<ArrayBuffer>,
  name: string,
  source: 'paste' | 'file' = 'file',
): Promise<{ status: number; data: StagedUpload; detail: string | undefined }> {
  const query = new URLSearchParams({ name, source })
  const res = await app.request(`/api/uploads?${query.toString()}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/octet-stream' },
    body,
  })
  const json = (await res.json()) as { data: StagedUpload; error?: { detail: string } }
  return { status: res.status, data: json.data, detail: json.error?.detail }
}

async function post(url: string, body: unknown): Promise<{ status: number; detail: string | undefined }> {
  const res = await app.request(`/api${url}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as { error?: { detail: string } }
  return { status: res.status, detail: json.error?.detail }
}

let count = 0

async function newTask(): Promise<string> {
  count += 1
  const id = `uploads-task-${String(count)}`
  await tasks.insert({
    id,
    title: `Uploads ${String(count)}`,
    repo_id: null,
    cwd: '/tmp',
    worktree: false,
    pr_urls: [],
  })
  return id
}

async function prompts(taskId: string): Promise<PromptPayload[]> {
  const page = await messages.page(taskId, 100)
  return page.messages.flatMap((row: MessageRow) => (row.kind === 'prompt' ? [row.payload] : []))
}

afterEach(() => {
  setPlannerModel(async () => Promise.reject(new Error('no model in tests')))
})

describe('POST /api/uploads', () => {
  it('stages a paste under its detected type, with its lines', async () => {
    const { status, data } = await upload(JSON_PASTE, 'paste-1.json', 'paste')
    expect(status).toBe(200)
    expect(data).toMatchObject({ name: 'paste.json', source: 'paste', kind: 'text', type: 'JSON', lines: 7 })
    expect(data.mime).toBe('application/json')
    const back = await app.request(`/api/uploads/${data.id}`, { headers: auth })
    expect(await back.text()).toBe(JSON_PASTE)
  })

  it('names the type from the content, not the name, and keeps the name', async () => {
    const image = (await upload(new Uint8Array(png(640, 480)), 'notes.txt')).data
    expect(image).toMatchObject({ name: 'notes.txt', kind: 'image', mime: 'image/png', shown: true })
    const pdf = (await upload(new Uint8Array(PDF), 'report')).data
    expect(pdf).toMatchObject({ name: 'report.pdf', kind: 'file', type: 'PDF', mime: 'application/pdf' })
    const big = (await upload(new Uint8Array(png(3024, 1964)), 'screen.png')).data
    expect(big).toMatchObject({ kind: 'image', shown: false })
  })

  it('refuses empty files and files over the cap, and keeps nothing of them', async () => {
    expect((await upload('', 'empty.txt')).status).toBe(400)
    const over = await upload(new Uint8Array(ATTACHMENT_FILE_MAX + 1), 'huge.bin')
    expect(over.status).toBe(413)
    expect(over.detail).toBe('huge.bin is over the 25 MB limit for one file')
    const staged = fs.readdirSync(path.join(SETI_HOME, 'uploads'))
    expect(staged.filter((name) => !name.endsWith('.json')).length * 2).toBe(staged.length)
  })

  it('takes raw bodies only on the upload route', async () => {
    const asJson = await app.request('/api/uploads?name=a.txt', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(asJson.status).toBe(415)
    const raw = await app.request('/api/tasks/start', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      body: 'x',
    })
    expect(raw.status).toBe(415)
  })
})

describe('safeName', () => {
  it.each([
    ['../../etc/passwd', null, 'passwd'],
    ['C:\\Users\\ada\\shot.png', null, 'shot.png'],
    ['.env', null, 'env'],
    ['my report (final).pdf', null, 'my-report-final.pdf'],
    ['\u00dcn\u00efcode \u0444\u0430\u0439\u043b.txt', null, '\u00dcn\u00efcode-\u0444\u0430\u0439\u043b.txt'],
    ['', 'png', 'file.png'],
    ['scan', 'pdf', 'scan.pdf'],
  ])('makes %j safe', (name, ext, safe) => {
    expect(safeName(name, ext)).toBe(safe)
  })

  it('keeps long names short, with their extension', () => {
    const name = safeName(`${'a'.repeat(300)}.json`, null)
    expect(name.length).toBeLessThanOrEqual(100)
    expect(name.endsWith('.json')).toBe(true)
  })
})

describe('sniff', () => {
  it('reads image sizes from PNG, GIF, JPEG and WebP headers', () => {
    expect(imageSize('image/png', png(800, 600))).toEqual([800, 600])
    const gif = Buffer.from('GIF89a\x20\x03\x58\x02', 'latin1')
    expect(imageSize('image/gif', gif)).toEqual([800, 600])
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03,
    ])
    expect(imageSize('image/jpeg', jpeg)).toEqual([800, 600])
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'latin1')
    webp.write('WEBPVP8X', 8, 'latin1')
    webp.writeUIntLE(799, 24, 3)
    webp.writeUIntLE(599, 27, 3)
    expect(imageSize('image/webp', webp)).toEqual([800, 600])
  })

  it('treats UTF-8 without NUL bytes as text, and the rest by magic or as binary', () => {
    const text = (body: string) => () => body
    expect(sniff(Buffer.from('print(1)\n'), 'run.py', false, text('print(1)\n'))).toMatchObject({
      kind: 'text',
      type: 'Python',
    })
    expect(sniff(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]), 'deck.pptx', false, text(''))).toMatchObject({
      kind: 'file',
      type: 'PowerPoint deck',
    })
    expect(sniff(Buffer.from([0, 1, 2, 3]), 'blob.dat', false, text(''))).toMatchObject({
      kind: 'file',
      type: 'DAT file',
      mime: 'application/octet-stream',
    })
  })
})

describe('attachments on messages', () => {
  it('moves each file into the workspace, points the prompt at it and shows the agent the image', async () => {
    const id = await newTask()
    const paste = (await upload(JSON_PASTE, 'paste-1.json', 'paste')).data
    const image = (await upload(new Uint8Array(png(64, 64)), 'shot.png')).data
    const pdf = (await upload(new Uint8Array(PDF), 'report.pdf')).data
    const sent = await post(`/tasks/${id}/messages`, {
      prompt: 'Compare [paste-1.json] with [shot.png], please.',
      attachments: [
        { id: paste.id, token: '[paste-1.json]' },
        { id: image.id, token: '[shot.png]' },
        { id: pdf.id, token: '[report.pdf]' },
      ],
    })
    expect(sent.status).toBe(200)
    await waitIdle(id)

    const uploads = path.join(workspaceDir(id), 'uploads')
    const [payload] = await prompts(id)
    const files = payload?.attachments ?? []
    const [json, shot, report] = files.map((file) => file.path)
    expect(files.map((file) => path.dirname(file.path))).toEqual([uploads, uploads, uploads])
    expect(path.basename(String(json))).toMatch(/^\d{8}-\d{6}-1\.json$/)
    expect(files.slice(1).map((file) => file.name)).toEqual(['shot.png', 'report.pdf'])
    expect(fs.readFileSync(String(json), 'utf8')).toBe(JSON_PASTE)
    expect(fs.readFileSync(String(report))).toEqual(PDF)
    expect(payload?.text).toBe(
      `Compare Pasted as ${String(json)} (JSON, 7 lines, 39 B) with ` +
        `Attached ${String(shot)} (PNG image, 64 B; the image follows this message), please.\n\n` +
        `Attached ${String(report)} (PDF, 36 B)`,
    )

    const content = sdk.fake.last?.inputs.at(-1)?.message.content
    const blocks = Array.isArray(content) ? content : []
    expect(blocks.map((block) => block.type)).toEqual(['text', 'image'])
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: png(64, 64).toString('base64') },
    })

    const gone = await app.request(`/api/uploads/${paste.id}`, { headers: auth })
    expect(gone.status).toBe(404)
    const page = await auditEvents.page(auditQuery.parse({ kind: 'task.files_attached' }))
    const event = page.events.find((item) => item.subject_id === id)
    expect(event?.detail).toMatchObject({ count: 3, bytes: 39 + 64 + 36 })
    expect(JSON.stringify(event)).not.toContain('"a": 1')
  })

  it('names a second file of the same name apart, never over the first', async () => {
    const id = await newTask()
    for (let n = 0; n < 2; n += 1) {
      const pdf = (await upload(new Uint8Array(PDF), 'report.pdf')).data
      await post(`/tasks/${id}/messages`, {
        prompt: 'Read [report.pdf]',
        attachments: [{ id: pdf.id, token: '[report.pdf]' }],
      })
      await waitIdle(id)
    }
    expect(fs.readdirSync(path.join(workspaceDir(id), 'uploads')).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'report-2.pdf',
      'report.pdf',
    ])
  })

  it('replaces a planted uploads link with a real folder, so nothing lands outside', async () => {
    const id = await newTask()
    const outside = fs.mkdtempSync(path.join(SETI_HOME, 'outside-'))
    fs.mkdirSync(workspaceDir(id), { recursive: true })
    fs.symlinkSync(outside, path.join(workspaceDir(id), 'uploads'))
    const pdf = (await upload(new Uint8Array(PDF), 'report.pdf')).data
    await post(`/tasks/${id}/messages`, {
      prompt: '[report.pdf]',
      attachments: [{ id: pdf.id, token: '[report.pdf]' }],
    })
    await waitIdle(id)
    expect(fs.readdirSync(outside)).toEqual([])
    expect(fs.lstatSync(path.join(workspaceDir(id), 'uploads')).isDirectory()).toBe(true)
  })

  it('refuses gone attachments, attachments with commands and bad requests', async () => {
    const id = await newTask()
    const gone = await post(`/tasks/${id}/messages`, {
      prompt: 'Read [x.pdf]',
      attachments: [{ id: randomUUID(), token: '[x.pdf]' }],
    })
    expect(gone).toEqual({ status: 400, detail: 'An attachment expired or was removed; attach it again' })
    const pdf = (await upload(new Uint8Array(PDF), 'report.pdf')).data
    const command = await post(`/tasks/${id}/messages`, {
      prompt: '/compact [report.pdf]',
      attachments: [{ id: pdf.id, token: '[report.pdf]' }],
    })
    expect(command).toEqual({ status: 400, detail: 'Attachments go with messages, not with commands' })
    const twice = await post(`/tasks/${id}/messages`, {
      prompt: 'Read it',
      attachments: [
        { id: pdf.id, token: '[a]' },
        { id: pdf.id, token: '[b]' },
      ],
    })
    expect(twice.status).toBe(400)
    const notUuid = await post(`/tasks/${id}/messages`, { prompt: 'x', attachments: [{ id: '../x', token: '[x]' }] })
    expect(notUuid.status).toBe(400)
    expect(await prompts(id)).toEqual([])
  })

  it('refuses a message whose files are over 50 MB together', () => {
    const staging = path.join(SETI_HOME, 'uploads')
    fs.mkdirSync(staging, { recursive: true })
    const refs = [1, 2].map((n) => {
      const id = randomUUID()
      const meta = { id, name: `${String(n)}.bin`, source: 'file', kind: 'file', size: 26 * 1024 * 1024 }
      fs.writeFileSync(path.join(staging, `${id}.json`), JSON.stringify(meta))
      return { id, token: `[${String(n)}.bin]` }
    })
    expect(() => checkStaged(refs)).toThrow('Attachments are limited to 50 MB a message')
  })
})

describe('attachments on a new agent', () => {
  it('writes the files once the agent exists, before its first turn', async () => {
    const paste = (await upload('a,b\n1,2\n3,4\n', 'paste-1.csv', 'paste')).data
    const res = await app.request('/api/tasks/start', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Sum [paste-1.csv]', attachments: [{ id: paste.id, token: '[paste-1.csv]' }] }),
    })
    const task = ((await res.json()) as { data: Task }).data
    await waitIdle(task.id)
    const [first] = await prompts(task.id)
    const file = first?.attachments?.[0]
    expect(file?.path.startsWith(path.join(workspaceDir(task.id), 'uploads'))).toBe(true)
    expect(first?.text).toBe(`Sum Pasted as ${file?.path ?? ''} (CSV, 3 lines, 12 B)`)
    expect(fs.readFileSync(file?.path ?? '', 'utf8')).toBe('a,b\n1,2\n3,4\n')
    expect(sdk.fake.last?.prompts.at(-1)).toContain(file?.path ?? 'missing')
  })

  it('checks the files before it creates the agent', async () => {
    const before = (await tasks.list()).length
    const refused = await post('/tasks/start', { prompt: 'x', attachments: [{ id: randomUUID(), token: '[x]' }] })
    expect(refused.status).toBe(400)
    expect(await tasks.list()).toHaveLength(before)
  })
})
