import path from 'node:path'
import type { KnowledgeFields, KnowledgeSource } from '@seti/shared'
import { HttpError } from './http.js'
import { credentialFindings } from './scrub.js'

/** Absolute or home paths inside a command, after a space, quote or equals sign. */
const PATH_IN_COMMAND = /(?:^|[\s='"(])([/~][^\s'"()]*)/g

/**
 * Refuses text that holds a credential, by Seti's share secret scan, naming where and what kind
 * but never the value.
 */
export function refuseSecrets(fields: Record<string, string>): void {
  for (const [name, text] of Object.entries(fields)) {
    const [found] = credentialFindings(text)
    if (found !== undefined) {
      throw new HttpError(
        400,
        `The ${name} looks like it holds a secret (${found.kind}, line ${String(found.line)}); ` +
          'notes reach every agent, so leave secrets out and name where the user keeps them instead.',
      )
    }
  }
}

/** The text fields of a note and its sources, for the secret scan. */
export const noteTexts = (fields: KnowledgeFields): Record<string, string> => ({
  title: fields.title,
  body: fields.body,
  'verify step': fields.verify,
  ...Object.fromEntries(fields.sources.map((source, index) => [`source ${String(index + 1)}`, source.ref])),
})

const inside = (target: string, roots: readonly string[]) =>
  roots.some((root) => target === root || target.startsWith(`${root}${path.sep}`))

function checkPath(ref: string, roots: readonly string[]): void {
  if (ref.startsWith('~')) {
    throw new HttpError(400, `The source ${ref} is a home path; name it relative to the repo instead.`)
  }
  if (
    ref.startsWith('/') &&
    !inside(
      path.resolve(ref),
      roots.map((root) => path.resolve(root)),
    )
  ) {
    throw new HttpError(400, `The source ${ref} is outside your own folders; notes may only name those.`)
  }
}

function checkUrl(ref: string): void {
  let url: URL
  try {
    url = new URL(ref)
  } catch {
    throw new HttpError(400, `The source ${ref} is not a URL.`)
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new HttpError(400, `The source ${ref} must be an https URL without a user or password.`)
  }
}

/**
 * Refuses a source that names a private path: a home path, or an absolute path outside `roots`,
 * the folders of the proposer. Relative paths are read against the repo and pass.
 */
export function refusePrivateSources(sources: readonly KnowledgeSource[], roots: readonly string[]): void {
  for (const source of sources) {
    switch (source.kind) {
      case 'url':
        checkUrl(source.ref)
        break
      case 'path':
        checkPath(source.ref, roots)
        break
      case 'command':
        for (const match of source.ref.matchAll(PATH_IN_COMMAND)) {
          checkPath(match[1] ?? '', roots)
        }
        break
    }
  }
}
