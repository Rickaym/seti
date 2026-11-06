import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HookCallback, HookInput, Options } from '@anthropic-ai/claude-agent-sdk'
import {
  SANDBOX_POLICY_DEFAULT,
  sandboxViolations,
  urlAllowed,
  WEBFETCH_BLOCKED,
  type SandboxPolicy,
  type Task,
} from '@seti/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { tasks } from './db.js'
import { readTokenFile } from './github-token.js'
import { builtInHidden, sandboxHooks, secretDenyRules, unsandboxedHookRules, type SandboxContext } from './sandbox.js'
import { githubTokens } from './secrets.js'
import { sessionOptions, setupKey } from './session-options.js'
import { sandboxPolicy } from './store/sandbox.js'
import { CLAUDE_PLACEHOLDER, GITHUB_PLACEHOLDER } from './task-sandbox.js'
import { clearConnections, keyConnection } from './test-connections.js'
import { trimText, WIRE_TEXT_LIMIT } from './transcript.js'

const CTX: SandboxContext = {
  home: '/home/me',
  setiHome: '/home/me/.seti',
  claudeHome: '/home/me/.claude',
  sockets: ['/run/postgresql', '/run/seti-redis'],
  credentials: ['/run/user/1000/credentials'],
}

const FAKE_TOKEN = ['github', 'pat', 'fake0123456789'].join('_')
const policy = (patch: Partial<SandboxPolicy> = {}): SandboxPolicy => ({ ...SANDBOX_POLICY_DEFAULT, ...patch })

function guard(hooks: ReturnType<typeof sandboxHooks>): HookCallback {
  const [matcher] = hooks.PreToolUse ?? []
  const [hook] = matcher?.hooks ?? []
  if (matcher?.matcher !== 'WebFetch' || hook === undefined) {
    throw new Error('No WebFetch hook')
  }
  return hook
}

const fetchInput = (url: string): HookInput => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'WebFetch',
  tool_input: { url, prompt: 'read it' },
  tool_use_id: 'toolu_1',
  session_id: 's',
  transcript_path: 'transcript.jsonl',
  cwd: '/work',
})

async function decide(hook: HookCallback, url: string): Promise<string | undefined> {
  const output = await hook(fetchInput(url), 'toolu_1', { signal: new AbortController().signal })
  if (!('hookSpecificOutput' in output) || output.hookSpecificOutput.hookEventName !== 'PreToolUse') {
    return undefined
  }
  return output.hookSpecificOutput.permissionDecision
}

describe('sandboxHooks', () => {
  it('holds WebFetch to the allowlist setting, with a reason the transcript shows', async () => {
    const hook = guard(sandboxHooks(async () => Promise.resolve(['example.org', '*.corp.test:8443'])))
    expect(await decide(hook, 'https://example.org/page')).toBeUndefined()
    expect(await decide(hook, 'https://api.corp.test:8443/x')).toBeUndefined()
    expect(await decide(hook, 'https://api.corp.test/x')).toBe('deny')
    expect(await decide(hook, 'https://github.com/')).toBe('deny')
    expect(await decide(hook, 'not a url')).toBe('deny')
    const output = await hook(fetchInput('https://evil.test/'), 't', { signal: new AbortController().signal })
    expect(JSON.stringify(output)).toContain(`${WEBFETCH_BLOCKED}: https://evil.test/`)
  })

  it('keeps sandboxed agents from editing files whose hooks run outside the sandbox', () => {
    expect(unsandboxedHookRules()).toEqual(
      expect.arrayContaining(['Edit(//**/.claude/settings.json)', 'Edit(//**/.mcp.json)']),
    )
  })
})

describe('secretDenyRules', () => {
  it('hides the default Seti home too when SETI_HOME points elsewhere', () => {
    expect(secretDenyRules(policy(), { ...CTX, setiHome: '/srv/seti' })).toEqual(
      expect.arrayContaining(['Read(//srv/seti/*.env)', 'Read(//home/me/.seti/*.env)']),
    )
  })

  it('keeps file tools away from credentials and Seti secrets but not worktrees', () => {
    const rules = secretDenyRules(policy({ hidden_paths: ['~/notes/keys.txt'] }), CTX)
    expect(rules).toEqual(
      expect.arrayContaining([
        'Read(//home/me/.ssh/**)',
        'Edit(//home/me/.ssh/**)',
        'Read(//home/me/.config/gh)',
        'Read(//home/me/.seti/*.env)',
        'Read(//home/me/.seti/seti.db*)',
        'Read(//home/me/.seti/backups/**)',
        'Read(//home/me/.claude/.credentials.json)',
        'Read(//home/me/notes/keys.txt)',
      ]),
    )
    expect(rules.some((rule) => rule.includes('worktrees'))).toBe(false)
  })

  it('lists what every task hides with the home directory as ~', () => {
    expect(builtInHidden(CTX)).toEqual(
      expect.arrayContaining(['~/.ssh', '~/.seti/*.env', '~/.seti/backups', '/run/postgresql']),
    )
  })
})

describe('urlAllowed and sandboxViolations', () => {
  it('matches wildcards on subdomains only, and ports when an entry names one', () => {
    expect(urlAllowed('https://objects.githubusercontent.com/x', ['*.githubusercontent.com'])).toBe(true)
    expect(urlAllowed('https://githubusercontent.com/x', ['*.githubusercontent.com'])).toBe(false)
    expect(urlAllowed('https://GitHub.com./x', ['github.com'])).toBe(true)
    expect(urlAllowed('http://example.org/', ['example.org:443'])).toBe(false)
    expect(urlAllowed('https://example.org/', ['example.org:443'])).toBe(true)
  })

  it('reads the refused accesses Claude Code appends to command output', () => {
    const output = 'curl failed\n<sandbox_violations>\ndeny network-outbound example.com:443\n</sandbox_violations>'
    expect(sandboxViolations(output)).toEqual(['deny network-outbound example.com:443'])
    expect(sandboxViolations('all good')).toEqual([])
  })

  it('keeps violations at the end of output that is trimmed for display', () => {
    const block = '<sandbox_violations>\ndeny file-read /home/me/.ssh\n</sandbox_violations>'
    const trimmed = trimText(`${'x'.repeat(WIRE_TEXT_LIMIT * 2)}\n${block}`)
    expect(trimmed.length).toBeLessThan(WIRE_TEXT_LIMIT + 500)
    expect(sandboxViolations(trimmed)).toEqual(['deny file-read /home/me/.ssh'])
  })
})

describe('readTokenFile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-token-'))
  const file = path.join(dir, 'agent.env')

  it('reads GH_TOKEN with or without export and quotes', () => {
    fs.writeFileSync(file, `# scoped\nOTHER=1\nexport GH_TOKEN="${FAKE_TOKEN}"\n`)
    expect(readTokenFile(file)).toBe(FAKE_TOKEN)
    fs.writeFileSync(file, `GH_TOKEN=${FAKE_TOKEN}\n`)
    expect(readTokenFile(file)).toBe(FAKE_TOKEN)
  })

  it('is null for a missing file or an empty value', () => {
    expect(readTokenFile(path.join(dir, 'missing.env'))).toBeNull()
    fs.writeFileSync(file, 'GH_TOKEN=\n')
    expect(readTokenFile(file)).toBeNull()
  })
})

describe('sessionOptions', () => {
  let count = 0
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-sandbox-work-'))
  async function newTask(sandbox: boolean): Promise<Task> {
    const id = `sandbox-task-${String(++count)}`
    await tasks.insert({ id, title: id, repo_id: null, cwd: work, worktree: false, sandbox, pr_urls: [] })
    const task = await tasks.get(id)
    if (!task) {
      throw new Error('Task was not stored')
    }
    return task
  }
  const options = async (task: Task): Promise<Options> => sessionOptions(task, new AbortController())
  const denies = (opts: Options) => (typeof opts.settings === 'object' ? (opts.settings.permissions?.deny ?? []) : [])

  afterEach(async () => {
    await sandboxPolicy.save(SANDBOX_POLICY_DEFAULT)
    await githubTokens('default').clearDefault()
  })

  it('runs sandboxed tasks through the launcher with placeholders for every credential', async () => {
    const opts = await options(await newTask(true))
    expect(opts.spawnClaudeCodeProcess).toBeTypeOf('function')
    expect(opts.sandbox).toBeUndefined()
    expect(opts.hooks?.PreToolUse?.map((hook) => hook.matcher)).toEqual(['Bash', 'WebFetch'])
    expect(denies(opts)).toContain('Edit(//**/.claude/settings.json)')
    expect(opts.permissionMode).toBe('auto')
    expect(opts.allowDangerouslySkipPermissions).toBeUndefined()
    expect(opts.canUseTool).toBeTypeOf('function')
    expect(opts.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:3128',
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_PLACEHOLDER,
      HTTPS_PROXY: 'http://127.0.0.1:3128',
      SETI_SANDBOX: '1',
    })
    expect(opts.env?.GH_TOKEN).toBeUndefined()
    expect(opts.env?.DATABASE_URL).toBeUndefined()
    expect(Object.keys(opts.env ?? {}).filter((key) => key.startsWith('SETI_') && key !== 'SETI_SANDBOX')).toEqual([
      'SETI_TASK_ID',
      'SETI_WORKSPACE',
    ])
  })

  it('gives gh a placeholder, never the token, when a fine-grained token is configured', async () => {
    await githubTokens('default').setDefault(FAKE_TOKEN)
    const opts = await options(await newTask(true))
    expect(opts.env?.GH_TOKEN).toBe(GITHUB_PLACEHOLDER)
    expect(JSON.stringify(opts.env)).not.toContain(FAKE_TOKEN)
  })

  it('uses the saved hidden paths for the file tools', async () => {
    await sandboxPolicy.save({ enabled: true, allowed_domains: ['example.org'], hidden_paths: ['/srv/secret'] })
    expect(denies(await options(await newTask(true)))).toContain('Read(//srv/secret)')
  })

  it('runs a task that opted out without the sandbox, but still hides credentials', async () => {
    const opts = await options(await newTask(false))
    expect(opts.spawnClaudeCodeProcess).toBeUndefined()
    expect(opts.hooks?.PreToolUse?.map((hook) => hook.matcher)).toEqual(['Bash'])
    expect(opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(denies(opts)).toEqual(
      expect.arrayContaining([`Read(/${os.homedir()}/.ssh/**)`, `Edit(/${os.homedir()}/.config/**)`]),
    )
    expect(denies(opts)).not.toContain('Edit(//**/.claude/settings.json)')
  })

  it('names the task in the environment of its process, sandboxed or not', async () => {
    for (const sandbox of [true, false]) {
      const task = await newTask(sandbox)
      expect((await options(task)).env?.SETI_TASK_ID).toBe(task.id)
    }
  })

  it("sets a connection's variable to its placeholder, sandboxed or not, never to the key", async () => {
    const key = ['xi', 'live', 'Kq72'].join('-')
    await keyConnection('elevenlabs_api_key', key, { hosts: ['api.elevenlabs.io'], profile_ids: ['default'] })
    try {
      for (const sandbox of [true, false]) {
        const env = (await options(await newTask(sandbox))).env ?? {}
        expect(env.ELEVENLABS_API_KEY).toMatch(/^seti-secret-elevenlabs_api_key-[0-9a-f]{32}$/)
        expect(JSON.stringify(env)).not.toContain(key)
      }
    } finally {
      await clearConnections()
    }
  })

  it('lets background commands of a task run up to a day, sandboxed or not', async () => {
    for (const sandbox of [true, false]) {
      expect((await options(await newTask(sandbox))).env?.BASH_MAX_TIMEOUT_MS).toBe('86400000')
    }
  })

  it("turns on Claude Code's own todo tools for every task, sandboxed or not", async () => {
    for (const sandbox of [true, false]) {
      expect((await options(await newTask(sandbox))).env?.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1')
    }
  })

  it("runs agent commands in bash whatever the user's login shell, and leaves the server's own", async () => {
    const serverShell = process.env.SHELL
    for (const sandbox of [true, false]) {
      expect((await options(await newTask(sandbox))).env).toMatchObject({
        CLAUDE_CODE_SHELL: '/bin/bash',
        SHELL: '/bin/bash',
      })
    }
    expect(process.env.SHELL).toBe(serverShell)
    expect(process.env.CLAUDE_CODE_SHELL).toBeUndefined()
  })

  it('runs every task unsandboxed while the setting is off', async () => {
    await sandboxPolicy.save({ ...SANDBOX_POLICY_DEFAULT, enabled: false })
    expect((await options(await newTask(true))).spawnClaudeCodeProcess).toBeUndefined()
  })

  it('refuses to sandbox a task whose directory holds the home directory', async () => {
    const task = { ...(await newTask(true)), cwd: path.dirname(os.homedir()) }
    await expect(options(task)).rejects.toThrow(/holds your home directory/)
  })

  it('restarts the process when the sandbox setting or the GitHub token changes', async () => {
    const task = await newTask(true)
    const before = await setupKey(task)
    expect(await setupKey(task)).toBe(before)
    await sandboxPolicy.save({ ...SANDBOX_POLICY_DEFAULT, allowed_domains: ['example.org'] })
    const edited = await setupKey(task)
    expect(edited).not.toBe(before)
    await githubTokens('default').setDefault(FAKE_TOKEN)
    expect(await setupKey(task)).not.toBe(edited)
  })
})
