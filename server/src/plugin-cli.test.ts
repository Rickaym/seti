import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  changeArgs,
  changeMessage,
  CLI_TIMEOUT_MS,
  cliErrorText,
  cliRunner,
  CliTimeout,
  createPluginCli,
  detailsArgs,
  LIST_ARGS,
  parseAvailable,
  parseDetails,
  parseInstalled,
  parseMarketplaces,
} from './plugin-cli.js'

const POSTHOG_DETAILS = `posthog 1.1.64
  Description: Access PostHog analytics.
  Source: posthog@claude-plugins-official

Component inventory
  Skills (3)  adding-warehouse-person-properties, analyzing-expensive-users, writing-streamlit-apps
  Agents (1)  error-analyzer
  Hooks (2)  SessionEnd, PreToolUse  (harness-only - no model context cost)
  MCP servers (1)  posthog  (tool schemas resolved at runtime; not counted)
  LSP servers (0)

Projected token cost
  Always-on:   ~30,164 tok   added to every session
`

const LSP_DETAILS = `typescript-lsp 1.0.0
  Source: typescript-lsp@claude-plugins-official

Component inventory
  Skills (0)
  Agents (0)
  Hooks (0)
  MCP servers (0)
  LSP servers (1)  typescript  (out-of-process tooling; no model context cost)
`

describe('CLI arguments', () => {
  it('lists installed plugins as JSON', () => {
    expect(LIST_ARGS).toEqual(['plugin', 'list', '--json'])
  })

  it('inspects an installed plugin by id after --', () => {
    expect(detailsArgs({ id: 'slack@claude-plugins-official' })).toEqual([
      'plugin',
      'details',
      '--',
      'slack@claude-plugins-official',
    ])
  })

  it('loads a local folder for one call and inspects it as name@inline', () => {
    const folder = '/home/me/my plugin; rm -rf ~'
    expect(detailsArgs({ name: 'acme', path: folder })).toEqual([
      '--plugin-dir',
      folder,
      'plugin',
      'details',
      '--',
      'acme@inline',
    ])
  })

  it('hands the runner an argument list, never a command string', async () => {
    const run = vi.fn(async (_args: string[]) => Promise.resolve(LSP_DETAILS))
    await createPluginCli(run).components({ name: 'x', path: '/srv/$(whoami)' })
    expect(run).toHaveBeenCalledWith(['--plugin-dir', '/srv/$(whoami)', 'plugin', 'details', '--', 'x@inline'])
  })
})

describe('parseInstalled', () => {
  it('splits ids into name and marketplace and keeps the enabled state', () => {
    const stdout = JSON.stringify([
      { id: 'slack@claude-plugins-official', version: '1.3.0', scope: 'user', enabled: true, installPath: '/x' },
      { id: 'acme@acme-tools', scope: 'project', enabled: false },
    ])
    expect(parseInstalled(stdout)).toEqual([
      {
        id: 'slack@claude-plugins-official',
        name: 'slack',
        marketplace: 'claude-plugins-official',
        version: '1.3.0',
        scope: 'user',
        enabled: true,
      },
      {
        id: 'acme@acme-tools',
        name: 'acme',
        marketplace: 'acme-tools',
        version: null,
        scope: 'project',
        enabled: false,
      },
    ])
  })

  it('rejects output that is not a plugin list', () => {
    expect(() => parseInstalled('{"plugins": 1}')).toThrow()
  })
})

describe('parseDetails', () => {
  it('reads names per component kind and drops the notes', () => {
    expect(parseDetails(POSTHOG_DETAILS)).toEqual({
      skills: ['adding-warehouse-person-properties', 'analyzing-expensive-users', 'writing-streamlit-apps'],
      agents: ['error-analyzer'],
      commands: [],
      hooks: ['SessionEnd', 'PreToolUse'],
      mcp_servers: ['posthog'],
      lsp_servers: [],
    })
  })

  it('reads a plugin that only has an LSP server', () => {
    expect(parseDetails(LSP_DETAILS)).toMatchObject({ skills: [], lsp_servers: ['typescript'] })
  })

  it('returns null without an inventory block', () => {
    expect(parseDetails('Plugin "x" not found.')).toBeNull()
  })
})

describe('cliErrorText', () => {
  it('explains a missing CLI and otherwise prefers stderr', () => {
    expect(cliErrorText(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))).toContain(
      'SETI_CLAUDE_BIN',
    )
    expect(cliErrorText(Object.assign(new Error('Command failed'), { stderr: 'bad\n' }))).toBe('bad')
    expect(cliErrorText(new Error('Command failed'))).toBe('Command failed')
  })
})

describe('change arguments', () => {
  it('prints JSON, installs at user scope and puts every target after --', () => {
    const id = 'datadog@claude-plugins-official'
    expect(changeArgs.install(id)).toEqual(['plugin', 'install', '--json', '--scope', 'user', '--', id])
    expect(changeArgs.uninstall(id, 'project')).toEqual([
      'plugin',
      'uninstall',
      '--json',
      '--scope',
      'project',
      '--',
      id,
    ])
    expect(changeArgs.enable(id, 'user')).toEqual(['plugin', 'enable', '--json', '--scope', 'user', '--', id])
    expect(changeArgs.disable(id, 'local')).toEqual(['plugin', 'disable', '--json', '--scope', 'local', '--', id])
    expect(changeArgs.update(id, 'user')).toEqual(['plugin', 'update', '--json', '--scope', 'user', '--', id])
    const market = (verb: string, target: string) => ['plugin', 'marketplace', verb, '--json', '--', target]
    expect(changeArgs.addMarketplace('pbakaus/impeccable')).toEqual(market('add', 'pbakaus/impeccable'))
    expect(changeArgs.updateMarketplace('impeccable')).toEqual(market('update', 'impeccable'))
    expect(changeArgs.removeMarketplace('impeccable')).toEqual(market('remove', 'impeccable'))
  })

  it('runs a change with the longer timeout and returns the last line of its message', async () => {
    const message = 'Cloning repository\nSuccessfully updated marketplace: impeccable'
    const run = vi.fn(async (_args: string[], _timeout?: number) =>
      Promise.resolve(`${JSON.stringify({ outcome: 'ok', message })}\n`),
    )
    expect(await createPluginCli(run).change(changeArgs.updateMarketplace('impeccable'))).toBe(
      'Successfully updated marketplace: impeccable',
    )
    expect(run).toHaveBeenCalledWith(changeArgs.updateMarketplace('impeccable'), CLI_TIMEOUT_MS.change)
  })

  it('throws the message of a result other than ok', () => {
    const stdout = JSON.stringify({ outcome: 'needs_confirmation', message: 'Run the shown command first' })
    expect(() => changeMessage(stdout)).toThrow('Run the shown command first')
  })
})

describe('catalog parsing', () => {
  it('reads marketplaces with their source as the user would type it', () => {
    const stdout = JSON.stringify([
      { name: 'official', source: 'github', repo: 'anthropics/claude-plugins-official', installLocation: '/m/o' },
      { name: 'team', source: 'git', url: 'https://git.example.com/team.git' },
      { name: 'local', source: 'directory', path: '/srv/market' },
    ])
    expect(parseMarketplaces(stdout)).toEqual([
      { name: 'official', source: 'anthropics/claude-plugins-official', installLocation: '/m/o' },
      { name: 'team', source: 'https://git.example.com/team.git', installLocation: null },
      { name: 'local', source: '/srv/market', installLocation: null },
    ])
  })

  it('reads the plugins on offer next to the installed ones', () => {
    const stdout = JSON.stringify({
      installed: [{ id: 'slack@official', version: '1.4.1', scope: 'user', enabled: true }],
      available: [
        {
          pluginId: 'datadog@official',
          name: 'datadog',
          marketplaceName: 'official',
          description: 'Datadog tools',
          version: '0.7.17',
          source: { source: 'url', url: 'https://github.com/DataDog/claude.git' },
          installCount: 120,
        },
        { pluginId: 'bare@official', name: 'bare', marketplaceName: 'official', source: './plugins/bare' },
      ],
    })
    const parsed = parseAvailable(stdout)
    expect(parsed.installed).toEqual([
      { id: 'slack@official', name: 'slack', marketplace: 'official', version: '1.4.1', scope: 'user', enabled: true },
    ])
    expect(parsed.available).toEqual([
      {
        id: 'datadog@official',
        name: 'datadog',
        marketplace: 'official',
        description: 'Datadog tools',
        version: '0.7.17',
        source: 'https://github.com/DataDog/claude.git',
        installCount: 120,
      },
      {
        id: 'bare@official',
        name: 'bare',
        marketplace: 'official',
        description: '',
        version: null,
        source: './plugins/bare',
        installCount: null,
      },
    ])
  })
})

describe('the CLI runner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-plugin-cli-'))
  const script = (name: string, body: string) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return file
  }

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('kills a run that outlives its timeout and says so', async () => {
    const slow = cliRunner(script('slow', 'sleep 5'))
    const failure = await slow(changeArgs.install('x@y'), 200).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(CliTimeout)
    expect(cliErrorText(failure)).toBe('claude plugin install did not finish within 0.2 s')
  })

  it('passes arguments without a shell', async () => {
    const echo = cliRunner(script('echo', 'printf "%s\\n" "$@"'))
    const marker = path.join(dir, 'pwned')
    const id = `$(touch ${marker})@y`
    expect(await echo(['plugin', 'install', '--', id])).toBe(`plugin\ninstall\n--\n${id}\n`)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('surfaces the JSON message of a failure, else its stderr', async () => {
    const loud = cliRunner(script('loud', 'echo "Plugin x not found" >&2; exit 1'))
    expect(cliErrorText(await loud(['plugin']).catch((e: unknown) => e))).toBe('Plugin x not found')
    const result = `{"outcome":"failed","message":"Marketplace nope not found"}`
    const json = cliRunner(script('json', `echo '${result}'; echo "Failed" >&2; exit 1`))
    expect(cliErrorText(await json(['plugin']).catch((e: unknown) => e))).toBe('Marketplace nope not found')
  })
})
