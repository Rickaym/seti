import type { DreamEnd } from '../store/dreams.js'

const section = (title: string, lines: readonly string[]) =>
  lines.length === 0 ? [] : ['', `## ${title}`, '', ...lines.map((line) => `- ${line}`)]

/** The dream's report as Markdown, kept beside its digest for the agent and the Files view. */
export function reportMarkdown(
  { title, night, prompt }: { title: string; night: string; prompt: string },
  end: DreamEnd,
): string {
  const report = end.report
  const outcome = end.reason === null ? end.state : `${end.state}: ${end.reason}`
  return [
    `# Dream: ${title}, night of ${night}`,
    '',
    report?.summary ?? 'No report.',
    '',
    `Outcome: ${outcome}. Memory files changed: ${String(end.memory_changes)}. Steps: ${String(end.steps)}. Cost: $${end.cost_usd.toFixed(2)}.`,
    ...section('Tidied', report?.tidied ?? []),
    ...section('Remembered', report?.remembered ?? []),
    ...section('Asks', report?.asks ?? []),
    ...section('Found', report?.found ?? []),
    '',
    `Prompt ${prompt}.`,
    '',
  ].join('\n')
}
