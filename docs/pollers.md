# Pollers

TLDR: a webhook channel takes deliveries from an app Seti lists, such as Linear, or from one the
user describes as data; a poller is a channel for a service that sends no webhooks. Seti runs its
small JavaScript module on a schedule in an isolated engine, compares the items it returns with the
last run, and reports what is new, changed or gone to the channel's subscribers, like a webhook
would. No model runs and nothing is spent unless something changed. Each subscribed agent gets an
update at once, after its turn or with the user's next message, as its subscription says.

## Where pollers fit

A poller is a channel source next to webhooks: what it finds becomes the same events, with the same
subscribers, filters, delivery log and agent updates, so an agent cannot tell a polled event from a
sent one. It runs no model; only a change wakes the EA or a subscribed agent.
Settings, Channels, New, Poller creates one from a template, which stays a plain script to edit.
Blank is Seti's own; HTTP JSON and RSS/Atom feed come from the bundled Poller templates mod. A
poller keeps its own copy of the script, so turning that mod off only takes its templates out of
the menu and stops no poller.

## Webhook senders

Settings, Channels, New, Webhook starts with a picker of the apps that can send. Each app is a
sender: a description, as data, of how the app signs a delivery and where its event name, title
and link are. Seti verifies and reads every sender with the same code, so supporting another app
needs no mod and no code. The picker lists three kinds:

- The catalog in `shared/src/webhook-sender-catalog.ts`: Linear, Bitbucket, Cloudflare, GitLab,
  Grafana, Jira, Make, PagerDuty, Shopify, Slack, Standard Webhooks, Stripe, Svix, Vercel and
  Zapier.
- Senders a mod adds with its own code, such as GitHub and Sentry, which also track states.
- Seti signature, for a sender that can sign with `X-Seti-Signature` or send a bearer secret.

Custom, at the foot of the picker, describes an app the catalog does not list, with the same
fields a catalog entry has. Only the user describes a custom sender, pastes a secret or checks a
sample; the EA and agents create webhooks for catalog senders and leave the secret to the user.

After Create, Seti shows the URL to paste into the app with the app's own setup steps. An app that
issues the secret, as Linear does once it has the URL, gets a field for it in the same dialog, and
the webhook refuses deliveries until the secret is saved. Where the app lets the user set the
secret, Seti makes one and shows it once.

### The sender definition

| Field                     | What it says                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `signature.scheme`        | `hmac` for a signature, or `token` for an app that sends the secret itself in a header           |
| `signature.header`        | The header with the signature or the token                                                       |
| `signature.algorithm`     | `sha256`, `sha1` or `sha512`                                                                     |
| `signature.encoding`      | `hex` or `base64`                                                                                |
| `signature.prefix`        | What a signature starts with, such as `sha256=`, `v1=` or `v1,`; other entries are skipped       |
| `signature.separator`     | `none`, or `comma` or `space` for a header with several signatures; one match is enough          |
| `signature.signed`        | `{body}`, `{timestamp}.{body}`, `v0:{timestamp}:{body}` or `{id}.{timestamp}.{body}`             |
| `signature.key`           | `text` uses the secret's characters; `base64` its decoded bytes, after any `whsec_`              |
| `timestamp`               | Where the sending time is: a header, a body field, or a part of the signature header such as `t` |
| `max_age_s`               | How old the timestamp may be, 300 seconds unless set                                             |
| `id`                      | Where the delivery id is: a header or a body field; Seti takes each id once in 24 hours          |
| `secret`                  | `sender` when the app issues the secret, `generated` when Seti makes it                          |
| `event`, `action`         | Where the event name is, and a body field appended after a dot, as in `issue.create`             |
| `title`, `link`, `detail` | Body fields tried in order for the update's title, link and text                                 |
| `detail_max`              | How many characters of the text, or of the payload when no field holds text, are passed on       |
| `handshake`               | A signed URL check to answer: the field and value that mark it and the field to send back        |

A body field is a dot path such as `data.title` or `alerts.0.labels.alertname`. The signed text is
one of the four templates and nothing else: an app that signs something different, such as the
URL with its form fields, needs a mod. A timestamp is read as epoch seconds, epoch milliseconds or
an ISO time. An update's title falls back to the sender and the event name, and its link is kept
only when it is an http or https URL.

### A worked example: Linear

Linear signs the raw body with HMAC-SHA256 and sends the hex digest in `Linear-Signature`. The
body carries `webhookTimestamp` in milliseconds, which Linear recommends checking within a minute,
and each delivery has a `Linear-Delivery` id. The catalog entry is therefore:

```ts
{
  signature: { scheme: 'hmac', header: 'Linear-Signature' },
  timestamp: { in: 'body', name: 'webhookTimestamp' },
  id: { in: 'header', name: 'Linear-Delivery' },
  max_age_s: 60,
  event: { in: 'body', name: 'type' },
  action: 'action',
  title: ['data.title', 'data.name', 'data.body'],
  link: ['url'],
  detail: ['data.description', 'data.body'],
}
```

In Linear, Settings, API, New webhook takes the URL; the webhook's detail page then shows the
signing secret to paste into Seti. A new issue arrives as the event `issue.create` with the
issue's title and URL, so a subscription filtered to `issue` takes every issue event and one
filtered to `issue.create` only new issues.

### Checking a sample

Sample, on the card of a webhook with a catalog or custom sender, takes the headers and body of a
request copied from the app's delivery log. Seti checks it on the server with the stored secret
and answers whether the signature verifies and which event name, title and link it would produce.
It stores nothing and reaches no subscriber. A captured request is usually older than the
sender's limit, so the answer says a live delivery that old would be refused instead of failing.
The custom form has the same check before the webhook exists, with the secret typed beside it.

### The delivery log

Every request is recorded on the card under Activity with why it was refused: `missing signature`,
`signature mismatch`, `token mismatch`, `too old`, a duplicate delivery id, or a secret that is
not pasted yet. A refused delivery is logged without its body.

### What needs a mod

A sender is data only while Seti can verify it with a shared secret and one of the signed
templates, and answer its URL check by sending back a field of a signed request. These need code
or a different trust model and are not in the catalog: Twilio (signs the URL and form fields),
Discord (Ed25519 and a typed reply), Zoom (a computed reply to its URL check), Notion (sends its
token in an unsigned request), Intercom (checks the URL with a HEAD request), Twitch EventSub
(signs the id, timestamp and body without separators) and Supabase Auth hooks (expect a reply
body). GitHub and Sentry stay with their mods, which also follow each workflow, deployment and
monitor from failing to passing.

## When an agent gets an update

Each agent's subscription to a channel says when the agent gets its updates. The subscriber list
on the channel's card and the Channels row of the agent's settings both set it, and the Schedule
tab and the subscriber list show it as a small label. It applies to pollers, reminders and
webhooks alike.

| Delivery      | Idle agent                        | Running turn                                 |
| ------------- | --------------------------------- | -------------------------------------------- |
| Agent default | as the agent's Updates setting    | as the agent's Updates setting               |
| Now           | starts a turn                     | joins the turn at its next step              |
| After turn    | starts a turn                     | waits for the turn's end, then starts a turn |
| With message  | waits for the user's next message | waits for the user's next message            |

Now reaches a running turn the way a message typed during it does: Claude Code hands it over
between two steps, so nothing is interrupted or discarded. An update held for the user's next
message never starts a turn and stays out of the turns Seti starts for other updates; it goes
with the next message somebody writes to the agent, or joins the running turn once the user
answers the agent's question. It waits in the bar above the composer until then, where Hand over
gives it to the agent at once and Dismiss discards it.

The agent's Updates setting caps the subscription's choice: Wait for my message holds every update
for the next message, Off drops them, and only Wake the agent lets the choice apply. Agent default
follows that setting, which makes it After turn for an agent that wakes. An agent blocked on the
user, with a question or a permission request open, takes no update into its turn: Now waits until
the user answered, then joins the turn. Seti hands updates over once none has arrived for 5
seconds, and at most 30 seconds after the first, so a burst reaches the agent as one batch; a turn
takes the newest 20 waiting updates, and a batch with a Now update in it joins the running turn
whole. PR updates and group chat messages have no such choice and follow the agent's setting.

The EA and agents set it with the `delivery` argument of `subscribe_channel`: `now`, `after_turn`,
`with_message` or `agent`. Every change is audited with the old and the new value.

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
| Interval                  | 1 minute to 1 day, 5 minutes by default, jitter under 5 s      |
| Timeout                   | 5 to 120 seconds, 30 by default                                |
| Compute                   | 1 second without awaiting, 10 seconds a run                    |
| Memory                    | 48 MB engine memory; a run's responses fit even kept whole     |
| Responses                 | 4 MB each and 12 MB a run, refused before the script sees them |
| Output                    | 500 items and 1 MB; unusable items are noted, not fatal        |
| Runs at once              | 3 across all pollers, one per poller                           |
| Worker threads            | 2 by default (`SETI_POLLER_WORKERS`, 1 to 3), 128 MB heap      |
| Hard stop                 | the worker is stopped 2 seconds past the run's timeout         |
| Backoff after failures    | the interval doubled per failure, up to 6 hours, 10% jitter    |
| Keys kept for comparisons | seen in the last 30 days, the newest 10,000                    |
| Runs kept                 | 30 days per poller; the latest 50 keep their logs              |

## Who changes them

The user, the EA and agents at Seti control Full create and change pollers; other agents ask the
EA in the group chat. The EA writes scripts, test runs them, creates, changes, pauses and polls
pollers behind its confirmation gate. Seti refuses the EA and agents extra hosts, secrets, and a
new script for a poller that sends secrets: those stay the user's.

The card shows the status (pending, ok, erroring, failing, paused), the last and next run, recent
runs with their logs and errors, Poll to run now, a switch to pause, and Edit, whose Test run
executes the script once without storing or reporting anything and shows its items, notes, log and
error.

## Schedule

Settings, Channels has a Schedule tab that lists what runs next, grouped by day in the viewer's
timezone: Today, Tomorrow, then dates. It covers the next 24 hours, 7 days or 30 days and shows
three kinds of entry: pollers, reminders and the follow-ups the EA scheduled. Webhooks run on no
schedule and stay out. An entry shows its local time, its name and its timing in words, and opens
the channel's card, or the EA for a follow-up.

A channel with more than 6 runs in a day shows as one line for that day with the count, such as
"Every 5 min, 288 runs", at the time of the first one; fewer runs are listed one by one. A cron
reminder read in another timezone than the viewer's names it. Paused pollers and reminders have no
runs to come, so the tab counts and names them under the list.

Pollers always run on an interval, and reminders on an interval or a cron schedule. Cron runs are
exact. Interval runs are projected from the stored next run in steps of the interval, so a
poller's real runs differ by a few seconds of jitter, and move back while it backs off after failures.

Seti computes all of this from `nextRuns` and `runsInRange` in `shared/src/schedule.ts`. Each
poller and reminder also reports its next 5 runs as `upcoming`, which is what the EA and agents
read: `list_channels` with `upcoming` answers "what is scheduled next?" with the coming runs,
soonest first, and the paused channels.
