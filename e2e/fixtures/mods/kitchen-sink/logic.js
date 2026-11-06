const SINK = 'https://api.sink.test/v1/summarize'

async function target(seti, wanted) {
  if (typeof wanted === 'string' && wanted !== '') {
    return seti.tasks.get(wanted)
  }
  const [first] = await seti.tasks.list({ limit: 20 })
  if (first === undefined) {
    throw new Error('No agent the mod may read')
  }
  return first
}

async function readPlan(seti, id) {
  try {
    const file = await seti.files.read(id, 'notes/plan.md')
    return file.text
  } catch (e) {
    return 'no plan (' + e.code + ')'
  }
}

async function summarize(args, ctx, seti) {
  const task = await target(seti, args.task)
  const transcript = await seti.tasks.transcript(task.id, { limit: 5 })
  const plan = await readPlan(seti, task.id)
  const response = await seti.fetch(SINK, {
    connection: 'SINK_TOKEN',
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer mod-made-up' },
    body: JSON.stringify({ title: task.title, entries: transcript.messages.length, plan }),
  })
  const answer = await response.json()
  const { team } = await seti.settings.get()
  const count = Number((await seti.storage.get('count')) ?? 0) + 1
  const note = typeof args.note === 'string' && args.note !== '' ? ' (' + args.note + ')' : ''
  const summary = {
    task: task.id,
    title: task.title,
    summary: answer.summary,
    echo: answer.echo,
    plan: plan.split('\n')[0],
    by: ctx.caller,
  }
  await seti.storage.set('summary:' + task.id, summary)
  await seti.storage.set('count', count)
  const text = 'Sink summary of ' + task.title + ' for team ' + team + ': ' + answer.summary + note
  await seti.chat.post(text)
  if (task.handle !== null) {
    await seti.chat.post('Your sink summary: ' + answer.summary, { to: task.handle })
  }
  await seti.notify('digest', { title: 'Sink digest', body: text.slice(0, 200), url: '/#kitchen-sink.board' })
  await seti.audit('summarized', 'Summarized ' + task.title, { task: task.id, count })
  await seti.statusBar.set('count', { text: count + ' summaries' }).catch((e) => {
    seti.log('status not set:', e.code)
  })
  seti.log('summarized', task.id, 'for', ctx.caller)
  return { text, count, echo: answer.echo, plan: summary.plan }
}

async function askStart(_args, _ctx, seti) {
  const asked = await seti.tasks.start({ title: 'Sink helper', prompt: 'Tidy the sink notes and report back.' })
  return { text: 'Asked you to start Sink helper', asked: asked.asked }
}

export default {
  commands: {
    summarize,
    'ask-start': askStart,
  },
  webhooks: {
    sink: async (delivery, _ctx, seti) => {
      const payload = JSON.parse(delivery.body)
      if (payload.event === 'ping') {
        return null
      }
      await seti.storage.set('last-webhook', { event: payload.event, at: delivery.receivedAt })
      return {
        title: 'Sink ' + payload.event + ': ' + payload.text,
        body: 'From the sink service',
        kind: 'sink.' + payload.event,
        severity: payload.event === 'failed' ? 'warning' : 'info',
      }
    },
  },
  schedules: {
    digest: async (tick, _ctx, seti) => {
      const count = Number((await seti.storage.get('count')) ?? 0)
      await seti.storage.set('last-digest', { since: tick.since, at: tick.now, count })
      await seti.chat.post('Sink digest: ' + count + ' summaries so far')
    },
  },
  taskEvents: async (event, _ctx, seti) => {
    const turns = Number((await seti.storage.get('turns')) ?? 0) + 1
    await seti.storage.set('turns', turns)
    await seti.storage.set('last-turn', { task: event.taskId, type: event.type })
  },
}
