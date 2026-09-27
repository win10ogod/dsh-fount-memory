import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply } from '../lib/index.js'

test('two completed turns recall in-place with v4 source and never schedule another turn', async () => {
  const handlers = new Map()
  const tools = new Map()
  const cleanups = []
  const ctx = {
    on: (name, fn) => handlers.set(name, fn),
    effect: fn => cleanups.push(fn()),
    tools: { register: tool => {
      assertSupportedJsonSchema(tool.parameters)
      assertSupportedJsonSchema(tool.output.schema)
      tools.set(tool.name, tool)
    } },
    logger: { warn: error => { throw new Error(error) } }
  }
  const cwd = mkdtempSync(join(tmpdir(), 'fount-memory-plugin-'))
  const session = { header: { id: 'session-a', cwd } }
  const agent = { session, followup() { throw new Error('unexpected followup') }, steer() { throw new Error('unexpected steer') } }
  apply(ctx, { dataDir: cwd })
  const event = (type, data) => handlers.get('session/event')(session, { type, data })
  const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

  event('turn/start', { turn: 1 })
  const first = user('Remember my 2022-06 Fount project')
  event('user/message', first)
  let decision = await handlers.get('agent/pre-step')({ agent, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [first] }))
  assert.equal(decision.messages.length, 1)
  const remembered = await tools.get('fount_memory_remember').execute({ name: 'Fount project', content: 'The user developed Fount in 2022.', trigger: { any: ['Fount'] } }, { agent })
  assert.deepEqual(validateJsonSchemaValue(tools.get('fount_memory_remember').output.schema, remembered), [])
  event('assistant/message', { message: { content: [{ type: 'text', text: 'I will remember the Fount project.' }] } })
  event('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const searched = await tools.get('fount_memory_search').execute({ query: 'Fount', includeEpisodes: true }, { agent })
  assert.deepEqual(validateJsonSchemaValue(tools.get('fount_memory_search').output.schema, searched), [])
  assert.equal(searched.episodes.length, 1)

  event('turn/start', { turn: 2 })
  const second = user('What was my Fount project in 2022?')
  event('user/message', second)
  decision = await handlers.get('agent/pre-step')({ agent, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [second] }))
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0].source.kind, 'fount-memory')
  assert.equal(decision.messages[1].id, second.id)
  assert.match(decision.messages[0].content[0].text, /Fount project/)
  assert.ok(decision.messages.every(message => typeof message.source?.kind === 'string' && message.source.kind !== 'plugin'))
  assert.ok(tools.has('fount_memory_remember'))
  assert.ok(tools.has('fount_memory_forget'))
  event('assistant/message', { message: { content: [{ type: 'text', text: 'The project was Fount.' }] } })
  event('turn/end', { turn: 2, reason: { kind: 'completed' } })
  cleanups.forEach(fn => fn())
})
