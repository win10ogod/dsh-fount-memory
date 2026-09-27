import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply } from '../lib/index.js'
import { MemoryStore, databasePath } from '../lib/store.js'
import { terms } from '../lib/recall.js'

function fixture(t) {
  const handlers=new Map(),tools=new Map(),cleanups=[]
  const dir=mkdtempSync(join(tmpdir(),'fount-recall-safety-'))
  const config={dataDir:dir},session={id:'new-session',header:{id:'new-session',cwd:dir}},agent={session}
  const store=new MemoryStore(databasePath(config,dir))
  apply({on:(name,fn)=>handlers.set(name,fn),tools:{register:tool=>tools.set(tool.name,tool)},effect:fn=>cleanups.push(fn()),logger:{warn:message=>{throw new Error(message)}}},config)
  t.after(()=>{cleanups.forEach(fn=>fn());store.close()})
  const event=(type,data)=>handlers.get('session/event')(session,{type,data})
  const user=text=>createUserMessage({content:[{type:'text',text}],source:{kind:'user'}})
  const recall=async text=>{
    const input=user(text)
    return handlers.get('agent/pre-step')({agent,step:1,signal:new AbortController().signal},async()=>({kind:'enter',messages:[input]}))
  }
  return {event,user,recall,store,tools,agent}
}

test('high-relevance failed trajectories never auto-replay by default, but remain searchable',async t=>{
  const f=fixture(t)
  const trace='user (user): 建立樹木 HTML\nassistant (model): \n\nassistant (model): Now downloading three.module.js once to verify signatures.'
  f.store.saveEpisode({sessionId:'old-stopped-session',turn:1,text:trace,terms:terms(trace),focus:terms('建立樹木 HTML'),eventDates:[]})
  const decision=await f.recall('建立樹木 HTML')
  assert.equal(decision.messages.length,1)
  const factsOnly=await f.tools.get('fount_memory_search').execute({query:'three.module.js'},{agent:f.agent})
  assert.equal(factsOnly.episodes.length,0)
  const result=await f.tools.get('fount_memory_search').execute({query:'three.module.js',includeEpisodes:true},{agent:f.agent})
  assert.equal(result.episodes.length,1)
})

test('explicit named facts still recall without any old assistant dialogue',async t=>{
  const f=fixture(t)
  f.store.putMemory({name:'tree preference',content:'User prefers self-contained HTML.',trigger:{any:['tree']},context:'explicit user preference'})
  f.store.saveEpisode({sessionId:'old',turn:1,text:'assistant (model): Now I will do the tree.',terms:terms('tree'),focus:terms('tree'),eventDates:[]})
  const decision=await f.recall('Create a tree')
  assert.equal(decision.messages.length,2)
  const recall=decision.messages[0]
  assert.equal(recall.source.kind,'fount-memory')
  assert.match(recall.content[0].text,/User prefers self-contained HTML/)
  assert.doesNotMatch(recall.content[0].text,/assistant \(model\)|Earlier conversation|Now I will/)
})

test('whitespace-only assistant messages are not archived',t=>{
  const f=fixture(t)
  f.event('turn/start',{turn:1});f.event('user/message',f.user('Create tree'))
  f.event('assistant/message',{message:{content:[{type:'text',text:'\n\n  '}]}})
  f.event('turn/end',{reason:{kind:'completed'}})
  assert.equal(f.store.episodes().length,0)
})

test('a normal stop with unfinished todos is not archived as a completed trace',t=>{
  const f=fixture(t)
  f.event('turn/start',{turn:1});f.event('user/message',f.user('Create tree'))
  f.event('todo/write',{todos:[{content:'Build tree',status:'in_progress'}]})
  f.event('assistant/message',{message:{content:[{type:'text',text:'Now downloading the source.'}]}})
  f.event('turn/end',{reason:{kind:'completed'}})
  assert.equal(f.store.episodes().length,0)
})

test('archive ignores intermediate blank messages and remains excluded from automatic recall',async t=>{
  const f=fixture(t)
  f.event('turn/start',{turn:1});f.event('user/message',f.user('Create tree'))
  f.event('assistant/message',{message:{content:[{type:'text',text:'\n\n'}]}})
  f.event('assistant/message',{message:{content:[{type:'text',text:'Tree artifact delivered.'}]}})
  f.event('turn/end',{reason:{kind:'completed'}})
  assert.equal(f.store.episodes().length,1)
  assert.equal((f.store.episodes()[0].text.match(/assistant \(model\):/g)||[]).length,1)
  assert.equal((await f.recall('Create tree')).messages.length,1)
})

test('earlier progress text does not make a blank final response eligible for archival',t=>{
  const f=fixture(t)
  f.event('turn/start',{turn:1});f.event('user/message',f.user('Create tree'))
  f.event('assistant/message',{message:{content:[{type:'text',text:'I will inspect the workspace.'}]}})
  f.event('assistant/message',{message:{content:[{type:'text',text:'\n\n'}]}})
  f.event('turn/end',{reason:{kind:'completed'}})
  assert.equal(f.store.episodes().length,0)
})
