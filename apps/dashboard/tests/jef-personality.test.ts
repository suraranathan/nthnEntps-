import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore, defaultPreferences } from '../server/memory.ts'
import { conversationGuidance, hasInappropriateHumor } from '../server/personality-context.ts'
import { philosophyGuidance, guardPhilosophyReply, philosophySources, verifiedQuotation } from '../server/philosophy.ts'
import { observeProject } from '../server/project-monitor.ts'
import { scanFollowUps } from '../server/followups.ts'
import { notificationDue } from '../server/notifications.ts'
import { JefRuntime } from '../server/runtime.ts'
import { ModelRouter } from '../server/providers.ts'
import type { ModelMessage, ModelProvider } from '../server/providers.ts'

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'jef-personality-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const store = new MemoryStore(dir); await store.load()
  return { dir, store }
}

test('sensitive conversation suppresses teasing; ordinary context leaves humor to judgment', async t => {
  const { store } = await setup(t)
  store.state.notes.insideJokes.push({ id: '1', text: 'compiler dragons', source: 'user', createdAt: new Date().toISOString() })
  const serious = conversationGuidance(store.state, 'My friend died yesterday')
  assert.match(serious, /no sarcasm, teasing or jokes/i)
  assert.match(serious, /compiler dragons/)
  const ordinary = conversationGuidance(store.state, 'What do you think about this design?')
  assert.match(ordinary, /disagree respectfully when warranted/i)
  assert.match(ordinary, /never force a routine/i)
  assert.doesNotMatch(ordinary, /This turn may be serious/)
  assert.equal(hasInappropriateHumor('Haha, that is hilarious 😂'), true)
  assert.equal(hasInappropriateHumor('I am sorry this happened.'), false)
})

test('philosophy uses six source-indexed perspectives and rejects unverified attributed quotes', () => {
  assert.equal(philosophySources.length, 6)
  assert.deepEqual(philosophySources.map(x => x.name), ['Marcus Aurelius', 'Seneca', 'Epictetus', 'Socrates', 'Aristotle', 'Confucius'])
  assert.match(philosophyGuidance(defaultPreferences), /paraphrases/)
  assert.match(philosophyGuidance({ ...defaultPreferences, philosophy: false }), /disabled/)
  const quote = verifiedQuotation('Epictetus', 'Some things are in our control and others not.')
  assert.equal(quote?.location, '1')
  assert.equal(verifiedQuotation('Seneca', 'Invented maxim'), null)
  assert.match(guardPhilosophyReply('Seneca said “Invented maxim”'), /cannot verify/)
  assert.match(guardPhilosophyReply('Seneca wrote: Wisdom comes from error.'), /cannot verify/)
  assert.match(guardPhilosophyReply('“Ancient wisdom from nowhere.”', 'Quote Aristotle on virtue'), /cannot verify/)
  assert.equal(guardPhilosophyReply('Epictetus suggests separating choices from outcomes.'), 'Epictetus suggests separating choices from outcomes.')
  const sourced = `Epictetus wrote “${quote!.text}” in ${quote!.work}, ${quote!.location}: ${quote!.url}`
  assert.equal(guardPhilosophyReply(sourced), sourced)
})

test('project changes are persistent, section-scoped and deduplicated across restart', async t => {
  const { dir, store } = await setup(t)
  assert.equal(observeProject(store, '# Status\nInitial work'), true)
  assert.equal(store.state.events.length, 0)
  await store.save()
  const restored = new MemoryStore(dir); await restored.load()
  assert.equal(observeProject(restored, '# Status\nInitial work'), false)
  assert.equal(observeProject(restored, '# Status\nInitial work\nNew milestone'), true)
  assert.equal(restored.state.events.length, 1)
  assert.match(restored.state.events[0].text, /Status/)
  assert.equal(observeProject(restored, '# Status\nInitial work\nNew milestone'), false)
  assert.equal(observeProject(restored, '# Status\nA second revision before delivery'), true)
  assert.equal(restored.state.events.length, 1, 'undelivered document edits are coalesced')
})

test('follow-up states, quiet hours, notification interval and restart recovery', async t => {
  const { dir, store } = await setup(t)
  const due = new Date('2026-10-30T02:00:00Z')
  const earlier = new Date('2026-10-29T01:00:00Z')
  store.state.preferences = { ...defaultPreferences, proactive: true }
  store.state.followUps.push({ id: 'task-1', text: 'Review unfinished proposal', state: 'scheduled', createdAt: earlier.toISOString(), updatedAt: earlier.toISOString(), dueAt: due.toISOString(), remindAt: new Date('2026-10-30T01:00:00Z').toISOString(), lastSignal: null })
  assert.equal(scanFollowUps(store, new Date('2026-10-30T01:00:00Z')), true)
  assert.equal(store.state.followUps[0].lastSignal, 'reminder')
  const count = store.state.events.length
  assert.equal(scanFollowUps(store, new Date('2026-10-30T01:01:00Z')), false)
  assert.equal(store.state.events.length, count)
  assert.equal(notificationDue(store.state, new Date('2026-10-30T15:00:00Z')), null) // quiet in Manila
  assert.equal(notificationDue(store.state, new Date('2026-10-30T01:30:00Z')), 'update')
  store.state.lastNotification = new Date('2026-10-30T01:00:00Z').getTime()
  assert.equal(notificationDue(store.state, new Date('2026-10-30T01:30:00Z')), null)
  assert.equal(scanFollowUps(store, new Date('2026-10-30T02:01:00Z')), true)
  assert.equal(store.state.followUps[0].state, 'overdue')
  assert.equal(store.state.followUps[0].lastSignal, 'overdue')
  await store.save()
  const restored = new MemoryStore(dir); await restored.load()
  assert.equal(restored.state.followUps[0].state, 'overdue')
  assert.equal(scanFollowUps(restored, new Date('2026-10-30T03:00:00Z')), false)
  assert.equal(restored.state.events.length, count + 1)
  restored.state.followUps[0].state = 'completed'
  assert.equal(scanFollowUps(restored, new Date('2026-11-30T03:00:00Z')), false)
})

test('old memory migrates without losing transcript and follow-up actions persist', async t => {
  const { dir, store } = await setup(t)
  store.state.messages.push({ id: 'old-turn', role: 'user', content: 'hello', createdAt: new Date().toISOString(), kind: 'chat' })
  const old = JSON.parse(JSON.stringify(store.state))
  delete old.followUps; delete old.projectFingerprint
  for (const key of ['philosophy', 'conversationInitiation', 'followUps', 'reminders', 'stalledAfterDays']) delete old.preferences[key]
  await writeFile(join(dir, 'jef.json'), JSON.stringify(old))
  const restored = new MemoryStore(dir); await restored.load()
  assert.equal(restored.state.messages[0].content, 'hello')
  assert.equal(restored.state.preferences.philosophy, true)
  const runtime = new JefRuntime(restored, new ModelRouter([]), join(dir, 'project.md'))
  await runtime.action({ action: 'followup.create', text: 'Finish the design', dueAt: '2026-11-02T09:00:00Z' })
  assert.equal(runtime.snapshot().followUps[0].state, 'scheduled')
  await runtime.action({ action: 'followup.update', id: restored.state.followUps[0].id, state: 'completed' })
  assert.equal(restored.state.followUps[0].state, 'completed')
  await runtime.action({ action: 'followup.update', id: restored.state.followUps[0].id, state: 'pending', dueAt: null, remindAt: '2026-11-03T09:00:00Z' })
  assert.equal(restored.state.followUps[0].state, 'scheduled')
  assert.equal(restored.state.followUps[0].dueAt, null)
  assert.equal(restored.state.followUps[0].remindAt, '2026-11-03T09:00:00.000Z')
  await runtime.action({ action: 'followup.update', id: restored.state.followUps[0].id, state: 'completed' })
  assert.equal((JSON.parse(await readFile(join(dir, 'jef.json'), 'utf8'))).followUps[0].state, 'completed')
})

test('provider changes preserve behavioral context without inventing replies', async t => {
  const { dir, store } = await setup(t)
  await writeFile(join(dir, 'project.md'), '# Project\nNo verified progress')
  const calls: ModelMessage[][] = []
  const make = (id: string): ModelProvider => ({ info: { id, model: id, configured: true, capabilities: { text: true, tools: false, streaming: false, images: false, discovery: true } }, discover: async () => [], complete: async messages => { calls.push(messages); return 'A fixture response.' } })
  const runtime = new JefRuntime(store, new ModelRouter([make('first'), make('second')]), join(dir, 'project.md'))
  await runtime.action({ action: 'remember', category: 'insideJokes', text: 'compiler dragons' })
  await runtime.action({ action: 'chat', text: 'Should I ship this unstable build?' })
  await runtime.action({ action: 'provider', id: 'second' })
  await runtime.action({ action: 'chat', text: 'My friend died; what now?' })
  assert.match(calls[0][0].content, /disagree respectfully/)
  assert.match(calls[1][0].content, /no sarcasm, teasing or jokes/i)
  assert.match(calls[1][0].content, /compiler dragons/)
  assert.equal(store.state.messages.filter(x => x.role === 'assistant').length, 2)
})

test('serious-context response is retried once and unsafe humor is never saved', async t => {
  const { dir, store } = await setup(t)
  const replies = ['Haha, I will roast you.', 'I am sorry. What happened sounds painful.']
  let calls = 0
  const provider: ModelProvider = { info: { id: 'fixture', model: 'fixture', configured: true, capabilities: { text: true, tools: false, streaming: false, images: false, discovery: true } }, discover: async () => [], complete: async () => { calls++; return replies.shift()! } }
  const runtime = new JefRuntime(store, new ModelRouter([provider]), join(dir, 'missing.md'))
  await runtime.action({ action: 'chat', text: 'My friend died yesterday.' })
  assert.equal(calls, 2)
  assert.equal(store.state.messages.at(-1)?.content, 'I am sorry. What happened sounds painful.')
  replies.push('Haha', 'Still hilarious 😂')
  await assert.rejects(runtime.action({ action: 'chat', text: 'I am in the hospital.' }), /serious tone/)
  assert.equal(store.state.messages.at(-1)?.role, 'user')
})

test('unverified historical quotation is repaired through the assigned provider', async t => {
  const { dir, store } = await setup(t)
  const replies = ['Seneca wrote “Every error is wisdom.”', 'Paraphrase of Seneca, Moral Letters 1: make deliberate use of limited time. My interpretation is to choose one priority today.']
  let calls = 0
  const provider: ModelProvider = { info: { id: 'fixture', model: 'fixture', configured: true, capabilities: { text: true, tools: false, streaming: false, images: false, discovery: true } }, discover: async () => [], complete: async () => { calls++; return replies.shift()! } }
  const runtime = new JefRuntime(store, new ModelRouter([provider]), join(dir, 'missing.md'))
  await runtime.action({ action: 'chat', text: 'What would Seneca suggest?' })
  assert.equal(calls, 2)
  assert.match(store.state.messages.at(-1)!.content, /Paraphrase/)
  assert.doesNotMatch(store.state.messages.at(-1)!.content, /Every error is wisdom/)
})

test('scheduler notices a document edit once and recovers delivered state after restart', async t => {
  const { dir, store } = await setup(t)
  const project = join(dir, 'project.md')
  await writeFile(project, '# Status\nInitial')
  store.state.preferences = { ...defaultPreferences, proactive: true, quietStart: '00:00', quietEnd: '00:00' }
  let calls = 0
  const provider: ModelProvider = { info: { id: 'fixture', model: 'fixture', configured: true, capabilities: { text: true, tools: false, streaming: false, images: false, discovery: true } }, discover: async () => [], complete: async () => { calls++; return 'The status document changed; review the updated section.' } }
  const runtime = new JefRuntime(store, new ModelRouter([provider]), project)
  await runtime.initialize()
  await writeFile(project, '# Status\nRevised')
  await runtime.tick(new Date())
  assert.equal(calls, 1)
  assert.equal(store.state.events.filter(e => e.type.startsWith('project_change')).length, 1)
  assert.equal(store.state.messages.at(-1)?.kind, 'update')
  const restored = new MemoryStore(dir); await restored.load()
  const second = new JefRuntime(restored, new ModelRouter([provider]), project)
  await second.tick(new Date(Date.now() + 2 * 3600000))
  assert.equal(calls, 1)
  assert.equal(restored.state.events.filter(e => e.type.startsWith('project_change')).length, 1)
})
