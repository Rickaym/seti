import { describe, expect, it } from 'vitest'
import {
  environValue,
  hostCpuPercent,
  listeningInodes,
  mountOf,
  parseBootTime,
  parseCpuTimes,
  parseMeminfo,
  parseRedisInfo,
  parseStat,
  parseStatus,
  postmasterDataDir,
  processCpuPercent,
} from './proc.js'

const STAT =
  '58996 (claude) S 4168838 58996 4168819 0 -1 4194560 812903 1270 0 0 41020 5315 3 1 20 0 21 0 189412345 ' +
  '75403264 98139 18446744073709551615 1 1 0 0 0 0 0 16781312 17442 0 0 0 17 5 0 0 0 0 0'

const STATUS = `Name:\tclaude
State:\tS (sleeping)
Tgid:\t58996
PPid:\t4168838
VmRSS:\t  392556 kB
RssAnon:\t  310000 kB
RssFile:\t   80000 kB
RssShmem:\t    2556 kB
VmSwap:\t   12288 kB
Threads:\t21
`

const PROC_STAT = `cpu  64667132 50133486 21398890 1367033793 5525265 0 345976 5734 0 0
cpu0 8083391 6266685 2674861 170879224 690658 0 43247 716 0 0
intr 1
ctxt 2
btime 1757000000
processes 3
`

const MEMINFO = `MemTotal:       32309464 kB
MemFree:         1203936 kB
MemAvailable:   11890888 kB
Buffers:          102400 kB
SwapCached:        40000 kB
SwapTotal:       8388604 kB
SwapFree:         263008 kB
`

const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0BBF 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 555001 1 0 100 0 0 10 0
   1: 0100007F:0BBF 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 555002 1 0 20 4 30 10 -1
   2: 0100007F:0BBE 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 555003 1 0 100 0 0 10 0
`

describe('/proc parsing', () => {
  it('reads a process stat line', () => {
    expect(parseStat(STAT)).toEqual({
      pid: 58996,
      comm: 'claude',
      state: 'S',
      ppid: 4168838,
      flags: 4194560,
      cpuTicks: 41020 + 5315,
      threads: 21,
      startTicks: 189412345,
    })
  })

  it('keeps a command name with spaces and parentheses whole', () => {
    const stat = parseStat('77 (tmux: server (1)) R 1 77 77 0 -1 0 0 0 0 0 9 1 0 0 20 0 1 0 500 0 0')
    expect(stat).toMatchObject({
      pid: 77,
      comm: 'tmux: server (1)',
      ppid: 1,
      cpuTicks: 10,
      threads: 1,
      startTicks: 500,
    })
  })

  it('rejects a truncated stat line', () => {
    expect(parseStat('12 claude')).toBeNull()
  })

  it('reads memory, swap and threads from status', () => {
    expect(parseStatus(STATUS)).toEqual({
      rssBytes: 392556 * 1024,
      anonBytes: 310000 * 1024,
      sharedBytes: 82556 * 1024,
      swapBytes: 12288 * 1024,
      threads: 21,
      nsPid: null,
    })
    expect(parseStatus('Name:\tsleep\nNSpid:\t4100\t7\n').nsPid).toBe(7)
    expect(parseStatus('Name:\tnode\nNSpid:\t4100\n').nsPid).toBe(4100)
  })

  it('reads a kernel thread status with no memory lines as zero', () => {
    expect(parseStatus('Name:\tkworker/0:1\nThreads:\t1\n')).toMatchObject({ rssBytes: 0, swapBytes: 0, threads: 1 })
  })

  it('reads the aggregate cpu line and the boot time', () => {
    const busy = 64667132 + 50133486 + 21398890 + 0 + 345976 + 5734
    expect(parseCpuTimes(PROC_STAT)).toEqual({ busy, total: busy + 1367033793 + 5525265 })
    expect(parseBootTime(PROC_STAT)).toBe(1757000000)
  })

  it('reads meminfo in bytes', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      totalBytes: 32309464 * 1024,
      availableBytes: 11890888 * 1024,
      swapTotalBytes: 8388604 * 1024,
      swapFreeBytes: 263008 * 1024,
    })
  })

  it('finds only listening sockets on the port', () => {
    expect(listeningInodes(TCP, 3007)).toEqual(['555001'])
    expect(listeningInodes(TCP, 3006)).toEqual(['555003'])
    expect(listeningInodes(TCP, 9)).toEqual([])
  })

  it('reads one environment variable and nothing else', () => {
    const environ = 'HOME=/home/me\0SETI_TASK_ID=abc-123\0GH_TOKEN=secret\0'
    expect(environValue(environ, 'SETI_TASK_ID')).toBe('abc-123')
    expect(environValue(environ, 'SETI_TASK')).toBeNull()
  })

  it('reads the postmaster data directory in both spellings', () => {
    const cmd = ['/usr/lib/postgresql/16/bin/postgres', '-D', '/var/lib/postgresql/16/main', '-c', 'x=y', '']
    expect(postmasterDataDir(cmd.join('\0'))).toBe('/var/lib/postgresql/16/main')
    expect(postmasterDataDir('postgres\0-D/srv/pg\0')).toBe('/srv/pg')
    expect(postmasterDataDir('postgres: checkpointer ')).toBeNull()
  })

  it('reads Redis INFO fields', () => {
    const info = parseRedisInfo(
      '# Server\r\nprocess_id:3036994\r\nuptime_in_seconds:34443\r\n# Memory\r\nused_memory:2529424\r\n',
    )
    expect(info.get('process_id')).toBe('3036994')
    expect(info.get('used_memory')).toBe('2529424')
    expect(info.has('# Memory')).toBe(false)
  })

  it('finds the mount point holding a path', () => {
    const mounts = [
      '/dev/root / ext4 rw 0 0',
      '/dev/nvme1n1 /home/me/data ext4 rw 0 0',
      'tmpfs /home/me/data\\040two tmpfs rw 0 0',
    ].join('\n')
    expect(mountOf(mounts, '/home/me/.seti')).toBe('/')
    expect(mountOf(mounts, '/home/me/data/pg')).toBe('/home/me/data')
    expect(mountOf(mounts, '/home/me/data two/x')).toBe('/home/me/data two')
    expect(mountOf(mounts, '/home/me/database')).toBe('/')
  })
})

describe('CPU deltas', () => {
  it('computes host CPU from two readings and refuses without a delta', () => {
    expect(hostCpuPercent(null, { busy: 10, total: 20 })).toBeNull()
    expect(hostCpuPercent({ busy: 100, total: 1000 }, { busy: 175, total: 1100 })).toBe(75)
    expect(hostCpuPercent({ busy: 100, total: 1000 }, { busy: 100, total: 1000 })).toBeNull()
  })

  it('computes a process share of one CPU over the interval', () => {
    expect(processCpuPercent(1000, 1700, 10_000)).toBe(70)
    expect(processCpuPercent(1000, 3000, 10_000)).toBe(200)
    expect(processCpuPercent(1000, 1000, 10_000)).toBe(0)
  })

  it('gives no reading for a reused pid or no elapsed time', () => {
    expect(processCpuPercent(5000, 10, 10_000)).toBeNull()
    expect(processCpuPercent(10, 20, 0)).toBeNull()
  })
})
