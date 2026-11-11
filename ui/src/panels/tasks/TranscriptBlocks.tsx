import { ErrorBoundary } from '@/components/ErrorBoundary'
import type { TimedBlock } from '@/lib/transcript-blocks'

/** Blocks a mod draws among the transcript's rows, such as an aside, each behind its boundary. */
export function TranscriptBlocks({ agent, blocks }: { agent: string; blocks: readonly TimedBlock[] | undefined }) {
  return blocks?.map(({ key, id, entry }) => {
    const View = entry.source.view
    return (
      <div key={key} data-transcript-block={entry.key}>
        <ErrorBoundary name={entry.name} kind="item">
          <View agent={agent} id={id} />
        </ErrorBoundary>
      </div>
    )
  })
}
