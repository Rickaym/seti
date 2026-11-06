import { defineLogic } from '@seti/mod-api/logic'

export default defineLogic({
  commands: {
    hello: async (_args, _ctx, seti) => {
      const { greeting } = await seti.settings.get()
      const count = Number((await seti.storage.get('count')) ?? 0) + 1
      await seti.storage.set('count', count)
      return { text: `${String(greeting)} (${String(count)})` }
    },
  },
})
