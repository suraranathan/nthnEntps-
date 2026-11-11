import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SqliteMemoryStore } from '../server/agent/memory-db.ts'
import { EmbeddingService, loadEmbeddingConfig, saveEmbeddingConfig } from '../server/agent/embeddings.ts'
import { extractMemoryCandidates } from '../server/agent/memory-extraction.ts'
import { AgentChatStore } from '../server/agent/store.ts'
import { JefAgent } from '../server/agent/agent.ts'
import type { Gateway, GatewayInfo } from '../server/agent/gateway.ts'
import { ToolRegistry } from '../server/agent/tools.ts'
import { PathPolicy } from '../server/agent/permissions.ts'
import { CredentialVault } from '../server/ai/credential-vault.ts'
import { randomBytes } from 'node:crypto'

test('SQLite memory imports legacy JSON once and preserves scopes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-memory-db-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const legacy = join(root, 'memories.json')
  await writeFile(legacy, JSON.stringify([{ id: 'old-1', scope: 'project:a', kind: 'fact', text: 'Vite builds the dashboard', source: 'old chat', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', pinned: false, stale: false }]))
  const memory = new SqliteMemoryStore(join(root, 'memories.sqlite'), legacy, root)
  assert.deepEqual(memory.relevant('project:a', 'Vite dashboard').map(item => item.id), ['old-1'])
  assert.equal(memory.list('project:b').length, 0)
  memory.close()
  const reopened = new SqliteMemoryStore(join(root, 'memories.sqlite'), legacy, root)
  assert.equal(reopened.list('project:a').length, 1)
  await reopened.remove('old-1')
  reopened.close()
  const afterDelete = new SqliteMemoryStore(join(root, 'memories.sqlite'), legacy, root)
  assert.equal(afterDelete.list('project:a').length, 0)
  afterDelete.close()
})

test('SQLite memory supports history, links, export, and semantic retrieval', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-memory-db-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const embed = async (text: string) => text.includes('car') || text.includes('vehicle') ? [1, 0] : [0, 1]
  const memory = new SqliteMemoryStore(join(root, 'memories.sqlite'), join(root, 'none.json'), root, { embed })
  const first = await memory.add({ scope: 'personal', kind: 'fact', text: 'The red car is parked outside', source: 'chat' })
  const second = await memory.add({ scope: 'personal', kind: 'goal', text: 'Finish the dashboard', source: 'chat' })
  assert.equal((await memory.add({ scope: 'personal', kind: 'fact', text: 'the RED car is parked outside', source: 'chat' })).id, first.id)
  await memory.link(first.id, second.id, 'related')
  await memory.update(first.id, { text: 'The red vehicle is parked outside' })
  assert.equal(memory.history(first.id).length, 2)
  assert.deepEqual(memory.links(first.id), [{ from: first.id, to: second.id, relation: 'related' }])
  assert.deepEqual((await memory.semanticRelevant('personal', 'Where is the car?', 1)).map(item => item.id), [first.id])
  assert.equal(memory.export('personal').length, 2)
  await memory.remove(second.id)
  assert.equal(memory.links(first.id).length, 0)
  memory.close()
})

test('embedding service calls a configured local model and checks dimensions', async () => {
  let input = ''
  const service = new EmbeddingService({ kind: 'ollama', model: 'nomic-embed-text' }, {
    request: async (_endpoint, path, _key, options) => {
      assert.equal(path, '/api/embed')
      input = String(options?.body?.input)
      return { status: 200, body: { embeddings: [[0.25, 0.75]] } }
    },
    pin: async () => ({ base: 'http://127.0.0.1:11434', url: new URL('http://127.0.0.1:11434'), host: '127.0.0.1', address: '127.0.0.1' }),
  })
  assert.deepEqual(await service.embed('Remember this'), [0.25, 0.75])
  assert.equal(input, 'Remember this')
})

test('online embedding configuration encrypts its key in private storage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-embedding-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'embedding.json')
  const vault = new CredentialVault(randomBytes(32))
  await saveEmbeddingConfig(file, { kind: 'openai', model: 'text-embedding-3-small', apiKey: 'secret-test-key' }, vault)
  assert.doesNotMatch(await import('node:fs/promises').then(fs => fs.readFile(file, 'utf8')), /secret-test-key/)
  assert.deepEqual(loadEmbeddingConfig(file, vault), { kind: 'openai', model: 'text-embedding-3-small', apiKey: 'secret-test-key' })
  vault.destroy()
})

test('conversation extraction keeps only explicit user facts and preferences', () => {
  assert.deepEqual(extractMemoryCandidates('I prefer short answers.'), [{ scope: 'personal', kind: 'preference', text: 'Prefer short answers' }])
  assert.deepEqual(extractMemoryCandidates('Remember that my project uses Vite.'), [{ scope: 'project', kind: 'fact', text: 'My project uses Vite' }])
  assert.deepEqual(extractMemoryCandidates('What do you think about Ultron?'), [])
})

test('Jef saves an explicit user preference during an actual chat turn', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-memory-chat-'))
  const memory = new SqliteMemoryStore(join(root, 'memory.sqlite'), join(root, 'old.json'), root)
  t.after(async () => { memory.close(); await rm(root, { recursive: true, force: true }) })
  const store = new AgentChatStore(join(root, 'chats'))
  await store.load()
  const gateway: Gateway = { info(): GatewayInfo { return { provider: 'fixture', model: 'fixture', transport: 'streaming' } }, async *stream() { yield 'Understood.' } }
  const agent = new JefAgent({ store, gateway, workspace: root, memory, memoryScope: 'project:test' })
  const chat = await agent.newConversation()
  await agent.run(chat.id, 'I prefer concise responses.', () => undefined)
  assert.equal(memory.list('project:test')[0].text, 'Prefer concise responses')
})

test('Jef can connect and inspect two memories through real tools', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-memory-tools-'))
  const memory = new SqliteMemoryStore(join(root, 'memory.sqlite'), join(root, 'old.json'), root)
  t.after(async () => { memory.close(); await rm(root, { recursive: true, force: true }) })
  const first = await memory.add({ scope: 'personal', kind: 'goal', text: 'Build NTHN', source: 'user' })
  const second = await memory.add({ scope: 'personal', kind: 'decision', text: 'Use SQLite', source: 'user' })
  const tools = new ToolRegistry({ memory, memoryScope: 'project:test' })
  const context = { workspace: root, paths: new PathPolicy({ root }), signal: new AbortController().signal }
  const linked = await tools.execute('link_memory', { from: first.id, to: second.id, relation: 'supports' }, context)
  const history = await tools.execute('memory_history', { id: first.id }, context)
  assert.equal(linked.ok, true)
  assert.match(history.output, /supports/)
})
