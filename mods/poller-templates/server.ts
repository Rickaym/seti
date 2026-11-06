import { defineMod } from '@seti/mod-api'
import manifest from './seti-mod.json' with { type: 'json' }

const HTTP_JSON_SCRIPT = `const URL = 'https://api.example.com/items'
const LIST = 'items'
const KEY = 'id'
const TITLE = 'title'

export default async function poll({ fetch }) {
  const res = await fetch(URL, {
    secretHeaders: {},
  })
  if (!res.ok) {
    throw new Error(\`\${URL} answered \${res.status}\`)
  }
  const data = await res.json()
  const list = LIST === '' ? data : LIST.split('.').reduce((value, part) => value?.[part], data)
  return list.map((item) => ({
    key: String(item[KEY]),
    title: String(item[TITLE] ?? item[KEY]),
    url: item.html_url ?? item.url,
    fields: item,
  }))
}
`

const FEED_SCRIPT = `const FEED = 'https://example.com/feed.xml'

export default async function poll({ fetch, parseFeed }) {
  const res = await fetch(FEED)
  if (!res.ok) {
    throw new Error(\`\${FEED} answered \${res.status}\`)
  }
  return parseFeed(await res.text()).map((entry) => ({
    key: entry.id,
    title: entry.title,
    url: entry.link,
    summary: entry.summary,
  }))
}
`

/** Scripts a new poller starts from; each poller keeps its own copy, so turning off stops none. */
export const pollerTemplatesServer = defineMod({
  manifest,
  server: (api) => {
    api.registerPollerTemplate('http_json', { script: HTTP_JSON_SCRIPT })
    api.registerPollerTemplate('feed', { script: FEED_SCRIPT })
  },
})
