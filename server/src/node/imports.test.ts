import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(import.meta.dirname, '..')
const ENTRY = 'node/main.ts'

/** What only the control plane may load: the database, the audit chain and the secret box. */
const controlOnly = (file: string) =>
  file === 'db.ts' || file.startsWith('store/') || file === 'audit.ts' || file === 'secret-box.ts'

/**
 * The modules of the node that still load the control plane's store, with what each loads. They
 * read task rows, settings and connections until the control plane hands the node all of it.
 */
const STILL_REACHING: Readonly<Record<string, readonly string[]>> = {
  'agent-access.ts': [
    'audit.ts',
    'db.ts',
    'store/access.ts',
    'store/change-requests.ts',
    'store/context.ts',
    'store/credentials.ts',
    'store/mcp.ts',
    'store/plugins.ts',
    'store/ssh.ts',
  ],
  'aws-access.ts': ['store/access.ts', 'store/credentials.ts', 'store/sandbox.ts'],
  'claude-logins.ts': ['audit.ts', 'db.ts', 'store/claude-logins.ts'],
  'compact.ts': ['audit.ts', 'store/compact.ts'],
  'context-changes.ts': ['audit.ts', 'store/context.ts'],
  'context-files.ts': ['db.ts'],
  'devices.ts': ['store/devices.ts'],
  'mcp-borrowed.ts': ['store/mcp.ts'],
  'mcp-presence.ts': ['audit.ts', 'store/mcp.ts'],
  'mcp-selection.ts': ['audit.ts', 'db.ts', 'store/mcp.ts'],
  'mcp-session-status.ts': ['store/sessions.ts'],
  'pg.ts': ['store/schema.ts'],
  'plugins.ts': ['audit.ts', 'store/plugins.ts'],
  'queued-prompts.ts': ['db.ts'],
  'revisions.ts': ['store/revisions.ts'],
  'secrets.ts': ['audit.ts', 'db.ts', 'secret-box.ts', 'store/secrets.ts'],
  'session-host.ts': ['db.ts'],
  'session-options.ts': ['store/credentials.ts', 'store/permissions.ts', 'store/sandbox.ts'],
  'seti-auth.ts': ['store/auth.ts'],
  'seti-guide.ts': ['db.ts', 'store/context.ts', 'store/ea.ts', 'store/sandbox.ts'],
  'shared-tools.ts': ['audit.ts', 'store/connections.ts', 'store/shared-tools.ts'],
  'ssh-files.ts': ['store/ssh.ts'],
  'task-blocked.ts': [
    'db.ts',
    'store/change-requests.ts',
    'store/permissions.ts',
    'store/questions.ts',
    'store/restart.ts',
  ],
  'task-credentials.ts': ['store/credentials.ts'],
  'worktree-restore.ts': ['audit.ts', 'store/task-location.ts'],
}

/** The relative modules a file loads when it runs; type-only imports load nothing. */
function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(SRC, file), 'utf8'), ts.ScriptTarget.Latest)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword) {
      found.push((node.moduleSpecifier as ts.StringLiteral).text)
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier !== undefined) {
      found.push((node.moduleSpecifier as ts.StringLiteral).text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [target] = node.arguments
      if (target !== undefined && ts.isStringLiteral(target)) {
        found.push(target.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => path.relative(SRC, path.resolve(SRC, path.dirname(file), specifier)).replace(/\.js$/, '.ts'))
}

/** Each edge from a node module into the control plane's store, as `importer -> imported`. */
function storeEdges(): string[] {
  const seen = new Set([ENTRY])
  const queue = [ENTRY]
  const edges: string[] = []
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const imported of runtimeImports(file)) {
      if (controlOnly(imported)) {
        edges.push(`${file} -> ${imported}`)
      } else if (!seen.has(imported)) {
        seen.add(imported)
        queue.push(imported)
      }
    }
  }
  return edges.toSorted((a, b) => a.localeCompare(b))
}

describe('the node process', () => {
  it('loads the store only through the modules named here', () => {
    const named = Object.entries(STILL_REACHING).flatMap(([file, imports]) => imports.map((to) => `${file} -> ${to}`))
    expect(storeEdges()).toEqual(named.toSorted((a, b) => a.localeCompare(b)))
  })
})
