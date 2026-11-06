import { type FileSearch, type FileTextHit, secretNameProblem } from '@seti/shared'
import { currentRequestSource } from './access.js'
import { fromEa } from './ea-guard.js'
import { HttpError } from './http.js'
import { redactCredentials } from './scrub.js'
import type { Located } from './task-files.js'

/** How the refusal names a delegate reader, the EA or a mod; null for the user. */
const delegateReader = (): string | null => {
  if (fromEa()) {
    return 'the EA never reads'
  }
  return currentRequestSource()?.via === 'mod' ? 'mods never read' : null
}

/**
 * The EA and mods read agents' files, never a key, credential or env file: those are refused by
 * name, on the path asked for and on the real path it leads to.
 */
export function refuseDelegateSecretFile(at: Located): void {
  const reader = delegateReader()
  if (reader === null) {
    return
  }
  const problem = secretNameProblem(at.rel) ?? (at.real === null ? null : secretNameProblem(at.real))
  if (problem !== null) {
    throw new HttpError(403, `${at.rel} ${problem}; ${reader} those`)
  }
}

/** A file's text as its reader gets it: credentials redacted for delegates, whole for the user. */
export const textForReader = (text: string): string => (delegateReader() === null ? text : redactCredentials(text))

function eaTextHit(hit: FileTextHit): FileTextHit {
  const text = redactCredentials(hit.text)
  return text === hit.text ? hit : { ...hit, text, marks: [] }
}

/** A Files search as its reader gets it: for the EA, no secret files and no credentials in lines. */
export function searchForReader(found: FileSearch): FileSearch {
  if (delegateReader() === null) {
    return found
  }
  const allowed = <T extends { path: string }>(hits: T[]) => hits.filter((hit) => secretNameProblem(hit.path) === null)
  return found.mode === 'name'
    ? { ...found, hits: allowed(found.hits) }
    : { ...found, hits: allowed(found.hits).map(eaTextHit) }
}
