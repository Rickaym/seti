/**
 * A stdio MCP server, run with node, whose one tool `peek` says it only reads. Its arguments are
 * a file it notes each start in, with its label and whether it holds the key, and that label.
 */
export const MCP_SERVER = `import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const [marker, label] = process.argv.slice(2)
appendFileSync(marker, label + ' ' + (process.env.OPENAI_API_KEY ?? process.env.SETI_MODEL_KEY ?? 'nokey') + '\\n')
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
const tool = { name: 'peek', description: label + ' peeks', inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true } }
const result = (m) => m.method === 'initialize'
  ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: label, version: '1' } }
  : m.method === 'tools/list' ? { tools: [tool] }
  : m.method === 'tools/call' ? { content: [{ type: 'text', text: label + ' PEEKED' }] } : {}
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id !== undefined) send({ id: m.id, result: result(m) })
})
`
