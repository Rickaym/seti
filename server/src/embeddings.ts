import fs from 'node:fs'
import os from 'node:os'
import { parseEnv } from 'node:util'
import { EA_ENV_PATH } from './config.js'
import { credential } from './credentials.js'

/** Short vectors keep the index small; text-embedding-3 models shorten without losing much. */
export const EMBEDDING_DIMENSIONS = 512
const MODEL = 'text-embedding-3-small'
const ENDPOINT = 'https://api.openai.com/v1/embeddings'
const BATCH_TIMEOUT_MS = 30_000
const QUERY_TIMEOUT_MS = 3_000
const QUERY_CACHE_MAX = 200

/** Turns texts into unit vectors of EMBEDDING_DIMENSIONS numbers, in input order. */
export interface Embedder {
  embed: (texts: readonly string[], timeoutMs?: number) => Promise<number[][]>
}

interface EmbeddingResponse {
  data: { index: number; embedding: number[] }[]
}

/** OpenAI's embeddings API; the key stays in this closure, never in the process environment. */
export function openAiEmbedder(key: string, endpoint = ENDPOINT): Embedder {
  return {
    embed: async (texts, timeoutMs = BATCH_TIMEOUT_MS) => {
      if (texts.length === 0) {
        return []
      }
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, input: texts, dimensions: EMBEDDING_DIMENSIONS }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        throw new Error(`the embeddings API answered ${String(res.status)}`)
      }
      const body = (await res.json()) as EmbeddingResponse
      return body.data.toSorted((a, b) => a.index - b.index).map((item) => item.embedding)
    },
  }
}

const expandHome = (file: string) => (file.startsWith('~/') ? `${os.homedir()}${file.slice(1)}` : file)

/** OPENAI_API_KEY from the environment, the openai-api-key credential or the EA's env file. */
export function readEmbeddingKey(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  envFile = EA_ENV_PATH,
): string | null {
  const direct = environment.OPENAI_API_KEY?.trim() ?? ''
  if (direct !== '') {
    return direct
  }
  const stored = credential('openai-api-key')
  if (stored !== null) {
    return stored
  }
  try {
    const key = parseEnv(fs.readFileSync(expandHome(envFile), 'utf8')).OPENAI_API_KEY?.trim() ?? ''
    return key === '' ? null : key
  } catch {
    return null
  }
}

/** Embeds search queries with a short deadline, remembering recent ones. */
export function queryEmbedder(embedder: Embedder) {
  const recent = new Map<string, number[]>()
  return async (query: string): Promise<number[]> => {
    const known = recent.get(query)
    if (known !== undefined) {
      return known
    }
    const [vector] = await embedder.embed([query], QUERY_TIMEOUT_MS)
    if (vector === undefined) {
      throw new Error('the embeddings API returned no vector')
    }
    if (recent.size >= QUERY_CACHE_MAX) {
      recent.delete(recent.keys().next().value ?? query)
    }
    recent.set(query, vector)
    return vector
  }
}
