# Pollers

TLDR: a poller is a channel for a service that sends no webhooks. Seti runs its small JavaScript
module on a schedule in an isolated engine, compares the items it returns with the last run, and
reports what is new, changed or gone to the channel's subscribers, like a webhook would. No model
runs and nothing is spent unless something changed.

## Where pollers fit

A poller is a channel source next to webhooks: what it finds becomes the same events, with the same
subscribers, filters, delivery log and agent updates, so an agent cannot tell a polled event from a
sent one. It runs no model; only a change wakes the EA or a subscribed agent.
Settings, Channels, New, Poller creates one from a template, which stays a plain script to edit.
Blank is Seti's own; HTTP JSON and RSS/Atom feed come from the bundled Poller templates mod. A
poller keeps its own copy of the script, so turning that mod off only takes its templates out of
the menu and stops no poller.

## The script

```js
export default async function poll({ fetch, parseFeed, log, state, since }) {
  const res = await fetch('https://api.example.com/items', {
    secretHeaders: { Authorization: 'Bearer {{my_token}}' },
  })
  const data = await res.json()
  return data.items.map((item) => ({ key: String(item.id), title: item.name, url: item.url }))
}
```

It returns an array of items, or `{ items, state }` to keep up to 16 KB of JSON for the next run.
An item has `key` (required, a stable id) and optionally `title`, `kind`, `url`, `body` or
`summary`, `fields` (an object) and `fingerprint`.

The script runs in a QuickJS engine (WebAssembly) on one of the server's poller worker threads,
never in a process: it has no Node APIs, files, environment, timers or CLIs such as `gh` or `aws`,
only what it is given. A busy script therefore never holds up the server's own requests.

- `fetch(url, init)` takes `method`, `headers`, `body`, `secretHeaders` and `secretQuery`, and
  returns `status`, `ok`, `url`, `headers.get()`, `text()` and `json()`. It reaches http and https
  hosts on the sandbox allowlist plus the poller's extra hosts, follows up to 5 redirects on them,
  and refuses loopback, private, link-local and similar addresses, connecting to the address it
  checked. A run makes at most 20 requests of 15 seconds and 4 MB each, 12 MB in all. Parsed
  JSON takes several times its text size, so a script that runs out of memory should keep less.
- `secretHeaders` and `secretQuery` take templates such as `'Bearer {{my_token}}'`. Seti fills in
  the values the poller may use (connections from Settings, Connections, by name, and the Default
  credential's GitHub tokens) and sends them only to the origin the script named. The script never sees a
  value: Seti replaces secret values in responses, logs, items and errors with `[secret]`.
- `parseFeed(text)` reads RSS 2.0, RSS 1.0 or Atom into entries with `id`, `title`, `link`,
  `summary`, `published` and `updated`.
- `log(...)` keeps up to 50 lines per run, and `since` is the time of the last good run.

## Change detection

The first successful run records what is there and reports nothing. After that a new key reports
the item's kind or `new`; a key whose fingerprint changed reports `<kind>.changed` or `changed`,
with the fields that changed; with Report gone items on, a key a complete run no longer returns
reports `<kind>.gone` or `gone`. The fingerprint is the item's own, else a hash of the fingerprint
fields set on the poller, else a hash of the whole item. A run that fails five times in a row
reports `poller_failed` once, and the next good run reports `poller_recovered`.

A key dropped from the store after 30 days unseen, or past the newest 10,000, counts as new if it
comes back. A run with unusable or left-out items reports nothing as gone.

## Limits

| Limit                     | Value                                                          |
| ------------------------- | -------------------------------------------------------------- |
| Interval                  | 1 minute to 1 day, 5 minutes by default, 10% jitter            |
| Timeout                   | 5 to 120 seconds, 30 by default                                |
| Compute                   | 1 second without awaiting, 10 seconds a run                    |
| Memory                    | 48 MB engine memory; a run's responses fit even kept whole     |
| Responses                 | 4 MB each and 12 MB a run, refused before the script sees them |
| Output                    | 500 items and 1 MB; unusable items are noted, not fatal        |
| Runs at once              | 3 across all pollers, one per poller                           |
| Worker threads            | 2 by default (`SETI_POLLER_WORKERS`, 1 to 3), 128 MB heap      |
| Hard stop                 | the worker is stopped 2 seconds past the run's timeout         |
| Backoff after failures    | the interval doubled per failure, up to 6 hours                |
| Keys kept for comparisons | seen in the last 30 days, the newest 10,000                    |
| Runs kept                 | the latest 50 per poller                                       |

## Who changes them

Only the user and the EA create and change pollers; agents ask the EA in the group chat. The EA
writes scripts, test runs them, creates, changes, pauses and polls pollers behind its confirmation
gate, but Seti refuses it extra hosts, secrets, and a new script for a poller that sends secrets.

The card shows the status (pending, ok, erroring, failing, paused), the last and next run, recent
runs with their logs and errors, Poll to run now, a switch to pause, and Edit, whose Test run
executes the script once without storing or reporting anything and shows its items, notes, log and
error.
