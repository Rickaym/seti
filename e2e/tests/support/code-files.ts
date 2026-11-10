import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

export const CODE_FILES = {
  'app.ts': "export function greet(name: string): string {\n  return 'Hello ' + name\n}\n",
  'tool.py': 'def main():\n    print("ok")\n    return 42\n',
  'data.json': '{\n  "name": "seti",\n  "private": true\n}\n',
  'huge.ts': Array.from({ length: 20_500 }, (_, n) => `const line${String(n)} = ${String(n)}`).join('\n'),
} as const

/** An idle agent whose folder holds code files in a few languages, one too big to colour. */
export async function seedCodeAgent(): Promise<{ id: string; dir: string }> {
  const id = randomUUID()
  const dir = path.join(paths.root, `code-${id.slice(0, 8)}`)
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  for (const [name, text] of Object.entries(CODE_FILES)) {
    fs.writeFileSync(path.join(dir, 'docs', name), text)
  }
  const db = openSeedDb()
  await db.idleTask(id, 'Code files', dir, new Date(Date.now() - 60_000).toISOString())
  await db.close()
  return { id, dir }
}

/** Sixty lines, with "needle" on lines 6, 26 and 46. */
export const FIND_FILE = Array.from({ length: 60 }, (_, n) =>
  n % 20 === 5 ? `const marker${String(n)} = 'needle'` : `const line${String(n)} = ${String(n)}`,
).join('\n')

/** A code agent whose docs folder also holds find.ts, the file the find specs search. */
export async function seedFindAgent(): Promise<{ id: string; dir: string }> {
  const agent = await seedCodeAgent()
  fs.writeFileSync(path.join(agent.dir, 'docs', 'find.ts'), `${FIND_FILE}\n`)
  return agent
}
