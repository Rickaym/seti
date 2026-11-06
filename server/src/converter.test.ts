import net from 'node:net'
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { converterBwrapArgs, converterLimitArgs, runConverter, type ConverterLimits } from './converter.js'

const MB = 1024 * 1024
const LIMITS: ConverterLimits = {
  timeoutMs: 10_000,
  cpuSeconds: 10,
  memoryBytes: 512 * MB,
  fileBytes: 4 * MB,
  outputBytes: 8 * MB,
}

const sh = async (script: string, limits: Partial<ConverterLimits> = {}, inputs = new Map<string, Buffer>()) =>
  runConverter({ program: 'sh', args: ['-c', script], inputs, limits: { ...LIMITS, ...limits } })

describe('converter sandbox arguments', () => {
  it('unshares every namespace, drops capabilities and mounts no home or Seti data', () => {
    const args = converterBwrapArgs({ input: '/w/in', output: '/w/out' }, '/usr/bin/pdftoppm')
    expect(args.slice(0, 5)).toEqual(['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL'])
    expect(args.join(' ')).not.toMatch(/\/home|\.seti|--share-net|--bind \/ /)
    expect(args).toContain('--clearenv')
    const binds = args.flatMap((arg, n) => (arg === '--bind' ? [args[n + 1]] : []))
    expect(binds).toEqual(['/w/out'])
  })

  it('mounts a program from outside /usr read-only at a fixed place', () => {
    const args = converterBwrapArgs({ input: '/i', output: '/o' }, '/home/u/.local/bin/resvg')
    expect(args.join(' ')).toContain('--ro-bind /home/u/.local/bin/resvg /opt/seti-bin/resvg')
  })

  it('mounts the extra configuration of a job read-only and sizes its /tmp when asked', () => {
    const extra = { system: ['/etc/libreoffice/registry'], tmpBytes: MB }
    const args = converterBwrapArgs({ input: '/i', output: '/o' }, '/usr/bin/sh', extra).join(' ')
    expect(args).toContain('--ro-bind-try /etc/libreoffice/registry /etc/libreoffice/registry')
    expect(args).toContain(`--size ${String(MB)} --tmpfs /tmp`)
    expect(converterBwrapArgs({ input: '/i', output: '/o' }, '/usr/bin/sh').join(' ')).not.toContain('--size')
  })

  it('caps memory, CPU time, file size and open files, with no core dumps', () => {
    expect(converterLimitArgs(LIMITS)).toEqual([
      `--as=${String(512 * MB)}`,
      '--cpu=10',
      `--fsize=${String(4 * MB)}`,
      '--nofile=256',
      '--core=0',
    ])
  })
})

describe('runConverter', () => {
  it('reads the input copy and returns what lands in /out', async () => {
    const result = await sh('cat /in/a.txt > /out/b.txt && echo done', {}, new Map([['a.txt', Buffer.from('hi')]]))
    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.files.get('b.txt')?.toString()).toBe('hi')
    expect(result.ok && result.stdout.toString()).toBe('done\n')
  })

  it('cannot see the home directory or write to the input', async () => {
    const script = `test -e ${os.homedir()} && echo home; touch /in/x 2>/dev/null && echo wrote; echo end`
    const result = await sh(script, {}, new Map([['a', Buffer.from('a')]]))
    expect(result.ok && result.stdout.toString()).toBe('end\n')
  })

  it('has no network: a connection to a host listener never arrives', async () => {
    let connections = 0
    const server = net.createServer((socket) => {
      connections += 1
      socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const result = await runConverter({
      program: 'bash',
      args: ['-c', `exec 3<>/dev/tcp/127.0.0.1/${String(port)} && echo connected`],
      inputs: new Map(),
      limits: LIMITS,
    })
    server.close()
    expect(result.ok).toBe(false)
    expect(connections).toBe(0)
  })

  it('kills a run at its timeout', async () => {
    const started = Date.now()
    const result = await sh('sleep 30', { timeoutMs: 500 })
    expect(result).toEqual({ ok: false, error: 'sh ran over its 0.5 s timeout' })
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('stops a process that asks for more memory than its cap', async () => {
    const result = await runConverter({
      program: 'python3',
      args: ['-c', 'x = bytearray(1024 * 1024 * 1024); print("allocated")'],
      inputs: new Map(),
      limits: { ...LIMITS, memoryBytes: 256 * MB },
    })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toMatch(/MemoryError|failed/)
  })

  it('stops a file past the file size cap', async () => {
    const result = await sh('head -c 3000000 /dev/zero > /out/big', { fileBytes: MB })
    expect(result.ok).toBe(false)
  })

  it('fills a sized /tmp no further than its size', async () => {
    const result = await sh('head -c 3000000 /dev/zero > /tmp/big', { tmpBytes: MB })
    expect(result.ok).toBe(false)
  })

  it('refuses output past the total cap', async () => {
    const script = 'for n in 1 2 3 4 5 6; do head -c 900000 /dev/zero > /out/f$n; done'
    const result = await sh(script, { outputBytes: 2 * MB })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/wrote over 2 MB/) as unknown })
  })

  it('says when a program is missing instead of running anything', async () => {
    const result = await runConverter({ program: 'no-such-converter', args: [], inputs: new Map(), limits: LIMITS })
    expect(result).toEqual({ ok: false, error: 'no-such-converter is not installed on this host' })
  })
})
