import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryStore, databasePath } from './store.js'
import { explicitPeriods, normalizeTrigger, renderRecall, selectRecall, terms } from './recall.js'

export const name = 'fount-memory'
export const inject = ['tools']
export const Config = z.object({
  dataDir: z.string().default(''),
  namespace: z.string().default('default'),
  scope: z.union(['workspace', 'global']).default('workspace'),
  recallCount: z.number().step(1).min(0).default(3),
  relevanceThreshold: z.number().default(5),
  sameSessionCooldownMinutes: z.number().min(0).default(20)
})

const textOf = message => (message?.content || []).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
const sessionId = session => String(session?.header?.id || session?.id || '')
const cwdOf = session => session?.header?.cwd
const human = message => message?.source?.kind === 'user'
const resultSchema = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) })
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

function formatContext(record, limit = 4) {
  return record?.messages?.slice(-limit).map(message => `${message.role} (${message.source}): ${message.text}`).join('\n') || ''
}

export function apply(ctx, config) {
  const settings = {
    ...config,
    namespace: config.namespace || 'default',
    scope: config.scope || 'workspace',
    recallCount: config.recallCount ?? 3,
    relevanceThreshold: config.relevanceThreshold ?? 5,
    sameSessionCooldownMinutes: config.sameSessionCooldownMinutes ?? 20
  }
  const stores = new Map()
  const turns = new Map()

  function storeFor(session) {
    const cwd = cwdOf(session)
    if (typeof cwd !== 'string' || !cwd) return null
    const filename = databasePath(settings, cwd)
    if (!stores.has(filename)) stores.set(filename, new MemoryStore(filename))
    return stores.get(filename)
  }

  function toolStore(exec) {
    const session = exec.agent?.session
    if (!session) throw new Error('fount-memory requires an active agent session')
    const store = storeFor(session)
    if (!store) throw new Error('fount-memory requires a workspace path')
    return { store, session, record: turns.get(sessionId(session)) }
  }

  ctx.effect(() => () => {
    for (const store of stores.values()) store.close()
    stores.clear()
    turns.clear()
  })

  ctx.on('session/event', (session, event) => {
    const id = sessionId(session)
    if (!id || session?.header?.origin === 'subagent') return
    if (event.type === 'turn/start') {
      turns.set(id, { turn: event.data.turn, messages: [], hasHuman: false })
      return
    }
    const record = turns.get(id)
    if (!record) return
    if (event.type === 'user/message') {
      if (!human(event.data)) return
      const text = textOf(event.data)
      if (text) record.messages.push({ role: 'user', source: event.data.source.kind, text })
      record.hasHuman = true
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data.message)
      if (text) record.messages.push({ role: 'assistant', source: 'model', text })
    } else if (event.type === 'turn/end') {
      turns.delete(id)
      if (event.data.reason?.kind !== 'completed' || !record.hasHuman) return
      const assistant = record.messages.filter(message => message.role === 'assistant')
      if (!assistant.length) return
      const snapshot = formatContext(record, 10)
      const latestUser = [...record.messages].reverse().find(message => message.role === 'user')?.text || ''
      try {
        storeFor(session)?.saveEpisode({
          sessionId: id, turn: record.turn, text: snapshot,
          terms: terms(snapshot), focus: terms(latestUser), eventDates: explicitPeriods(latestUser)
        })
      } catch (error) {
        ctx.logger.warn(`fount-memory: could not save episode: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || signal.aborted || step !== 1 || agent.session?.header?.origin === 'subagent') return decision
    const user = [...decision.messages].reverse().find(human)
    if (!user) return decision
    const query = textOf(user)
    if (!query.trim()) return decision
    try {
      const store = storeFor(agent.session)
      if (!store) return decision
      const recall = selectRecall(store.allMemories(), store.episodes(), query, {
        count: settings.recallCount,
        threshold: settings.relevanceThreshold,
        sameSessionCooldownMs: settings.sameSessionCooldownMinutes * 60_000,
        sessionId: sessionId(agent.session)
      })
      const text = renderRecall(recall)
      if (!text) return decision
      if (recall.episodes.length) store.reinforce(recall.episodes.map(item => item.id), recall.episodes.map((_item, index) => index === 0 ? 5 : 2))
      const snapshot = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: name, form: 'snapshot', sections: [{ name, text }] }
      })
      const index = decision.messages.lastIndexOf(user)
      return { ...decision, messages: [...decision.messages.slice(0, index), snapshot, ...decision.messages.slice(index)] }
    } catch (error) {
      ctx.logger.warn(`fount-memory: recall failed: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  const register = tool => ctx.tools.register(tool)
  register({
    name: 'fount_memory_remember',
    description: 'Create or revise a named, durable memory. Use for confirmed facts or explicit corrections. Matching names replace the current fact and preserve a revision history.',
    parameters: resultSchema({
      name: { type: 'string', description: 'Unique memory name' },
      content: { type: 'string', description: 'Objective fact or preference, including who it concerns' },
      trigger: { type: 'object', additionalProperties: false, properties: {
        any: { type: 'array', items: { type: 'string' }, description: 'Any keyword activates the memory' },
        all: { type: 'array', items: { type: 'string' }, description: 'All keywords activate the memory' },
        onDates: { type: 'array', items: { type: 'string' }, description: 'Calendar dates in MM-DD format' }
      }, description: 'Optional activation conditions; defaults to keywords from the name' }
    }, ['name', 'content']),
    output: { schema: resultSchema({ name: { type: 'string' }, revision: { type: 'integer' }, changed: { type: 'boolean' } }), render: renderJson },
    async execute(args, exec) {
      const { store, record } = toolStore(exec)
      const trigger = normalizeTrigger(args.trigger, args.name)
      return store.putMemory({ name: args.name, content: args.content, trigger, context: formatContext(record) })
    }
  })

  register({
    name: 'fount_memory_search',
    description: 'Search named memories and previous conversation snapshots. Use when more context is needed than automatic recall supplied.',
    parameters: resultSchema({ query: { type: 'string', description: 'Case-insensitive search text; empty lists recent records' }, limit: { type: 'integer', description: 'Optional positive result limit' } }),
    output: { schema: resultSchema({ memories: { type: 'array', items: { type: 'object' } }, episodes: { type: 'array', items: { type: 'object' } } }), render: renderJson },
    async execute(args, exec) {
      const { store } = toolStore(exec)
      const query = String(args.query || '').toLocaleLowerCase()
      const filter = item => JSON.stringify(item).toLocaleLowerCase().includes(query)
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) throw new Error('limit must be a positive integer')
      const limit = args.limit || Infinity
      return {
        memories: store.allMemories().filter(filter).slice(0, limit),
        episodes: store.episodes().filter(filter).slice(0, limit)
      }
    }
  })

  register({
    name: 'fount_memory_context',
    description: 'Inspect one named memory, its source context, and revision history before correcting it.',
    parameters: resultSchema({ name: { type: 'string' } }, ['name']),
    output: { schema: resultSchema({ memory: { oneOf: [{ type: 'object' }, { type: 'null' }] } }), render: renderJson },
    async execute(args, exec) { return { memory: toolStore(exec).store.getMemory(args.name) } }
  })

  register({
    name: 'fount_memory_forget',
    description: 'Forget memory. Use kind=all for a user request to forget a topic: it removes matching named memories, their revisions, and conversation snapshots. Search first to inspect the intended scope.',
    parameters: resultSchema({ kind: { type: 'string', enum: ['named', 'episodes', 'all'] }, value: { type: 'string', description: 'Exact memory name, or literal topic to remove' } }, ['kind', 'value']),
    output: { schema: resultSchema({ deleted: { oneOf: [{ type: 'integer' }, { type: 'object' }] } }), render: renderJson },
    async execute(args, exec) {
      const { store } = toolStore(exec)
      if (!args.value?.trim()) throw new Error('value is required')
      if (args.kind === 'named') return { deleted: Number(store.forgetMemory(args.value)) }
      if (args.kind === 'episodes') return { deleted: store.forgetEpisodes(args.value) }
      return { deleted: store.forgetMatching(args.value) }
    }
  })
}
