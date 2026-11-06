import { createHash } from 'node:crypto'
import type { ModDefinition } from '@seti/mod-api'
import { modManifest, type Disposer } from '@seti/shared'
import { inlineScriptHashes } from './policy.js'
import { modFramePages } from './source.js'

/** A third-party mod with sandboxed views that only Seti's own tests load. */
const MANIFEST = modManifest.parse({
  id: 'view-test',
  name: 'View test',
  version: '1.0.0',
  seti: '^1.7',
  description: 'Shows sandboxed views in every place a third-party mod can, so tests can drive the bridge.',
  capabilities: [{ name: 'storage' }],
  contributes: {
    settings: { greeting: { type: 'string', title: 'Greeting', default: 'Hello' } },
    views: [
      { id: 'board', title: 'Board', where: 'section', phone: true, entry: 'views/board.html' },
      { id: 'notes', title: 'Notes', where: 'agentTab', phone: true, entry: 'views/board.html' },
      { id: 'panel', title: 'Panel', where: 'sidePanel', phone: false, entry: 'views/board.html' },
    ],
    fileViewers: [
      {
        id: 'viewer',
        title: 'View test file',
        extensions: ['viewtest'],
        text: true,
        phone: true,
        entry: 'views/file.html',
      },
    ],
  },
})

const STYLE = `<style>
  body { margin: 0; padding: 12px; font-family: var(--font-sans), system-ui; background: var(--background);
    color: var(--foreground); }
  button { border: 1px solid var(--border); border-radius: var(--radius); background: var(--primary);
    color: var(--primary-foreground); padding: 4px 10px; }
</style>`

const BOARD = `<!doctype html><html><head><meta charset="utf-8"><title>Board</title>${STYLE}</head><body>
<h1>Board</h1>
<p id="place">Waiting for Seti</p>
<p id="theme"></p>
<p id="greeting"></p>
<button id="save" type="button">Save</button>
<button id="link" type="button">Docs</button>
<p id="saved"></p>
<p id="refused"></p>
<script>
  var text = function (id, value) { document.getElementById(id).textContent = value }
  seti.on('context', function (c) {
    text('place', 'Placed in ' + c.place + (c.agentId ? ' for ' + c.agentId : '') + (c.phone ? ' on a phone' : ''))
  })
  seti.on('theme', function (t) {
    text('theme', 'Theme ' + t.scheme + ' ' + getComputedStyle(document.documentElement).getPropertyValue('--background'))
  })
  seti.settings.get().then(function (s) { text('greeting', 'Greeting ' + s.greeting) })
  document.getElementById('save').addEventListener('click', function () {
    seti.storage.set('note', { text: 'kept' })
      .then(function () { return seti.storage.get('note') })
      .then(function (v) { text('saved', 'Saved ' + v.text) }, function (e) { text('saved', 'Save refused ' + e.code) })
  })
  document.getElementById('link').addEventListener('click', function () { seti.link('https://example.test/docs') })
  seti.run('missing', {}).catch(function (e) { text('refused', 'Refused ' + e.code) })
  seti.ready()
</script>
</body></html>`

const FILE = `<!doctype html><html><head><meta charset="utf-8"><title>File</title>${STYLE}</head><body>
<pre id="text">Waiting for the file</pre>
<button id="tiny" type="button">Tiny</button>
<button id="huge" type="button">Huge</button>
<script>
  seti.on('file', function (f) { document.getElementById('text').textContent = f.name + ': ' + f.text.toUpperCase() })
  document.getElementById('tiny').addEventListener('click', function () { seti.resize(10) })
  document.getElementById('huge').addEventListener('click', function () { seti.resize(5000) })
  seti.ready()
</script>
</body></html>`

const PAGES: Readonly<Record<string, string>> = {
  'views/board.html': BOARD,
  'views/file.html': FILE,
}

const HASH = createHash('sha256').update(JSON.stringify(PAGES)).digest('hex')

export const viewTestMod: ModDefinition = { manifest: MANIFEST }

/** Serves the test mod's pages from memory, as install serves an installed mod's. */
export function startViewTestMod(): Disposer {
  return modFramePages.register({
    modId: MANIFEST.id,
    hash: HASH,
    page: (entry) => {
      const html = PAGES[entry]
      return html === undefined ? null : { html, scriptHashes: inlineScriptHashes(html) }
    },
  })
}
