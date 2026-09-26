import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MemoryStore, databasePath } from '../lib/store.js'
import { explicitPeriods, normalizeTrigger, selectRecall, terms, triggerMatches } from '../lib/recall.js'

test('named facts survive restart, retain revisions, and forget removes all versions', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fount-memory-')), 'data.sqlite')
  let store = new MemoryStore(file)
  store.putMemory({ name: '生日', content: '使用者生日為 7 月 17 日。', trigger: { any: ['生日'] }, context: 'user: my birthday is July 17' })
  store.putMemory({ name: '生日', content: '使用者更正：生日為 7 月 18 日。', trigger: { any: ['生日'] }, context: 'user: correction, July 18' })
  store.close()
  store = new MemoryStore(file)
  const memory = store.getMemory('生日')
  assert.equal(memory.revision, 2)
  assert.match(memory.content, /18/)
  assert.equal(memory.revisions.length, 1)
  assert.match(memory.revisions[0].content, /17/)
  assert.match(memory.updatedContext, /correction/)
  assert.equal(store.forgetMemory('生日'), true)
  assert.equal(store.getMemory('生日'), null)
  store.close()
})

test('episode keys are idempotent and temporal relevance uses explicit event dates', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fount-memory-')), 'data.sqlite')
  const store = new MemoryStore(file)
  const episode = { sessionId: 's1', turn: 1, text: 'user: I moved in 2022-06', terms: terms('moved 2022'), focus: terms('moved 2022'), eventDates: explicitPeriods('2022-06') }
  assert.equal(store.saveEpisode(episode), true)
  assert.equal(store.saveEpisode(episode), false)
  const recalled = selectRecall([], store.episodes(), 'When did I move in 2022?', { threshold: 5, date: new Date('2026-09-26') })
  assert.equal(recalled.episodes.length, 1)
  assert.equal(store.forgetEpisodes('moved'), 1)
  assert.equal(store.episodes().length, 0)
  store.close()
})

test('structured triggers activate only on specified words or dates', () => {
  assert.equal(triggerMatches(normalizeTrigger({ any: ['birthday', '生日'] }, 'x'), '談談生日'), true)
  assert.equal(triggerMatches(normalizeTrigger({ all: ['project', 'fount'] }, 'x'), 'fount update'), false)
  assert.equal(triggerMatches(normalizeTrigger({ onDates: ['07-17'] }, 'x'), '', new Date('2026-07-17')), true)
  assert.throws(() => normalizeTrigger({ onDates: ['19-19'] }, 'x'))
  assert.notEqual(databasePath({ scope: 'workspace', namespace: 'n' }, '/tmp/a'), databasePath({ scope: 'workspace', namespace: 'n' }, '/tmp/b'))
})

test('forgetting a topic removes named revisions and related episodes together', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fount-memory-')), 'data.sqlite')
  const store = new MemoryStore(file)
  store.putMemory({ name: 'dog', content: 'User has a dog called Luna', trigger: { any: ['dog'] }, context: 'source one' })
  store.putMemory({ name: 'dog', content: 'User has a dog called Luna, adopted in 2024', trigger: { any: ['dog'] }, context: 'source two' })
  store.saveEpisode({ sessionId: 's1', turn: 1, text: 'User discussed dog Luna', terms: [], focus: [], eventDates: [] })
  store.saveEpisode({ sessionId: 's1', turn: 2, text: 'Unrelated project', terms: [], focus: [], eventDates: [] })
  assert.deepEqual(store.forgetMatching('Luna'), { memories: 1, episodes: 1 })
  assert.equal(store.getMemory('dog'), null)
  assert.equal(store.episodes().length, 1)
  store.close()
})
