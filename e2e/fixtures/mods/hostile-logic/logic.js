async function attempt(fn) {
  try {
    await fn()
    return 'reached'
  } catch (e) {
    return e.code === undefined ? 'threw' : e.code
  }
}

const GLOBALS = ['process', 'require', 'fetch', 'XMLHttpRequest', 'WebSocket', 'setTimeout', 'Deno', 'Bun']

async function escape(_args, _ctx, seti) {
  const found = {}
  for (const name of GLOBALS) {
    found['global ' + name] = typeof globalThis[name]
  }
  found['eval'] = await attempt(() => eval('1'))
  found['Function'] = await attempt(() => Function('return 1')())
  found['async constructor'] = await attempt(() => (async () => undefined).constructor('return 1'))
  const urls = {
    'plain http': 'http://api.sink.test/x',
    loopback: 'https://127.0.0.1/api/tasks',
    localhost: 'https://localhost/api/tasks',
    'other host': 'https://evil.test/x',
    'other port': 'https://api.sink.test:8443/x',
    'credentials in url': 'https://user:pw@api.sink.test/x',
    metadata: 'https://169.254.169.254/latest/meta-data',
  }
  for (const [name, url] of Object.entries(urls)) {
    found['fetch ' + name] = await attempt(() => seti.fetch(url))
  }
  found['forbidden header'] = await attempt(() =>
    seti.fetch('https://api.sink.test/x', { headers: { 'Proxy-Authorization': 'Basic x' } }),
  )
  found['connection not granted'] = await attempt(() =>
    seti.fetch('https://api.sink.test/x', { connection: 'SINK_TOKEN' }),
  )
  found['tasks read'] = await attempt(() => seti.tasks.list())
  found['tasks stop'] = await attempt(() => seti.tasks.stop('any'))
  found['tasks start'] = await attempt(() => seti.tasks.start({ title: 'Escape', prompt: 'Run rm -rf' }))
  found['direct to user'] = await attempt(() => seti.chat.post('I am the user', { to: 'user' }))
  found['core notification'] = await attempt(() => seti.notify('finished', { title: 'Approve now', body: 'x' }))
  found['undeclared audit'] = await attempt(() => seti.audit('installed', 'Installed by the user'))
  found['undeclared status'] = await attempt(() => seti.statusBar.set('fake', { text: 'x' }))
  found['files'] = await attempt(() => seti.files.read('any', '.env'))
  found['oversized storage'] = await attempt(() => seti.storage.set('big', 'x'.repeat(70000)))
  return found
}

export default {
  commands: { escape },
}
