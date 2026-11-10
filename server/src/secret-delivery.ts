import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { QuestionSecret, Task } from '@seti/shared'
import { HttpError } from './http.js'
import { hasKey, placeKeyRequest } from './key-requests.js'
import { connectionRows } from './store/connections.js'
import { secretsDir, workspaceDir } from './workspace/dir.js'

/** The git checkout a folder sits in, or null when no folder from it up to the root has `.git`. */
export function gitCheckoutAbove(dir: string): string | null {
  let current = path.resolve(dir)
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

/** Makes the secrets folder mode 700, refusing a symlink or a file in its place. */
function ensureSecretsDir(taskId: string): string {
  const dir = secretsDir(taskId)
  fs.mkdirSync(workspaceDir(taskId), { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false })
  if (stat === undefined) {
    fs.mkdirSync(dir, { mode: 0o700 })
  } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new HttpError(409, `${dir} is not a plain folder, so Seti wrote no secret there`)
  }
  fs.chmodSync(dir, 0o700)
  return dir
}

/**
 * Writes the value to `<workspace>/secrets/<name>`, mode 600 in a folder of mode 700, through a
 * new temporary file renamed over the old one, so a reader never sees half a value. Returns the
 * file's path; refuses a workspace inside a git checkout, where the file could be committed.
 */
export function writeSecretFile(taskId: string, name: string, value: string): string {
  const checkout = gitCheckoutAbove(workspaceDir(taskId))
  if (checkout !== null) {
    throw new HttpError(409, `The agent's workspace is inside the git checkout ${checkout}; Seti wrote no secret there`)
  }
  const dir = ensureSecretsDir(taskId)
  const file = path.join(dir, name)
  const temp = path.join(dir, `.${name}.${randomUUID()}.tmp`)
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
  try {
    fs.fchmodSync(fd, 0o600)
    fs.writeFileSync(fd, value)
    fs.fsyncSync(fd)
  } catch (e) {
    fs.closeSync(fd)
    fs.unlinkSync(temp)
    throw e
  }
  fs.closeSync(fd)
  fs.renameSync(temp, file)
  return file
}

/** Why the secret store cannot take the secret for these hosts, or null when it can. */
export async function secretStoreProblem(task: Task, name: string, hosts: readonly string[]): Promise<string | null> {
  if (hosts.length === 0) {
    return (
      'You run in the sandbox, so Seti keeps the secret in its secret store and its proxy adds it on the ' +
      'hosts you name. Call ask_secret again with the hosts that need it.'
    )
  }
  if (await hasKey(task, { kind: 'api_key', env: name, hosts: [...hosts] })) {
    return `Your credential already has $${name}; its placeholder is in your environment.`
  }
  const existing = (await connectionRows.list()).find((row) => row.env === name)
  if (existing === undefined) {
    return null
  }
  const same = existing.hosts.length === hosts.length && existing.hosts.every((host) => hosts.includes(host))
  if (!same) {
    return `The connection ${existing.name} already uses ${name} on ${existing.hosts.join(', ')}; ask for those hosts.`
  }
  return existing.kind === 'key' && existing.slots.value === undefined
    ? null
    : `The connection ${existing.name} already holds ${name}; ask the user to add it to your credential instead.`
}

/** Seals the value into the connection for the name and hosts, in the agent's credential. */
export async function storeSecret(task: Task, secret: QuestionSecret, value: string): Promise<void> {
  await placeKeyRequest(task, { kind: 'api_key', env: secret.name, hosts: secret.hosts }, value)
}

/** What the agent's ask_secret call returns once the user supplied the secret; never the value. */
export function suppliedText(secret: QuestionSecret, file: string | null): string {
  if (file !== null) {
    return (
      `The value of ${secret.name} is in ${file}. Read it from there when you need it, in the command or ` +
      'code that uses it; never open it with the Read tool, print it, log it or commit it, since any of ' +
      'those puts it in your transcript.'
    )
  }
  return (
    `The user stored ${secret.name} in Seti's secret store for ${secret.hosts.join(', ')}. From your next turn ` +
    `your session has $${secret.name}, holding a placeholder that Seti's proxy swaps for the value on those ` +
    'hosts. You never see the value; never print it or ask for it.'
  )
}
