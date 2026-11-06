import { parseArgs } from 'node:util'

const USAGE = `Usage:
  ea-index backfill [--env-file <seti.env>]
      Indexes every task message and open PR text the EA's search has not read yet, then embeds
      new documents when the EA's OpenAI key is available.
  ea-index status [--env-file <seti.env>]
      Prints how many documents the index holds and how search runs.
`

const say = (text: string) => process.stdout.write(`${text}\n`)

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { 'env-file': { type: 'string' } },
  })
  const [command] = positionals
  if (command !== 'backfill' && command !== 'status') {
    process.stdout.write(USAGE)
    process.exitCode = command === undefined ? 0 : 1
    return
  }
  if (values['env-file'] !== undefined) {
    process.loadEnvFile(values['env-file'])
  }
  const { closeDatabase, openDatabase } = await import('./db.js')
  const { backfillIndex, configureDefaultIndex, indexPrs, indexStatus } = await import('./ea-index.js')
  const { cachedOpenPrs } = await import('./prs.js')
  const { closeRedis } = await import('./redis.js')
  try {
    await openDatabase()
    const status = await configureDefaultIndex()
    if (command === 'backfill') {
      say(
        `Search: ${status.vector ? 'vector and full text' : 'full text only'}; embeddings ${status.embeddings ? 'on' : 'off'}.`,
      )
      const prs = await indexPrs(await cachedOpenPrs()).catch(() => 0)
      const result = await backfillIndex((done, total) => {
        if (done === total || done % 25 === 0) {
          say(`Indexed ${String(done)} of ${String(total)} tasks`)
        }
      })
      say(
        `Added ${String(result.added + prs)} documents from ${String(result.tasks)} tasks and open PRs; ` +
          `embedded ${String(result.embedded)}.`,
      )
    }
    const counts = await indexStatus()
    say(
      `${String(counts.documents)} documents, ${String(counts.embedded)} embedded; ` +
        `vector search ${counts.vector ? 'on' : 'off'}, embeddings ${counts.embeddings ? 'on' : 'off'}.`,
    )
  } finally {
    await Promise.all([closeDatabase(), closeRedis()])
  }
}

await main()
