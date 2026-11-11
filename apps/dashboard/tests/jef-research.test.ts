import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ResearchService, extractPage, validatePublicUrl, type WebResponse } from '../server/agent/research.ts'
import { ToolRegistry } from '../server/agent/tools.ts'
import { PathPolicy } from '../server/agent/permissions.ts'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadResearchConfig, saveResearchConfig } from '../server/agent/research-config.ts'
import { AgentChatStore } from '../server/agent/store.ts'
import { JefAgent } from '../server/agent/agent.ts'
import type { Gateway, GatewayInfo } from '../server/agent/gateway.ts'
import { CredentialVault } from '../server/ai/credential-vault.ts'
import { randomBytes } from 'node:crypto'

test('research rejects local, private, and non-HTTPS destinations', async () => {
  for (const url of ['http://example.com', 'https://localhost/', 'https://127.0.0.1/', 'https://192.168.1.2/', 'file:///etc/passwd', 'https://user:pass@example.com/']) {
    assert.throws(() => validatePublicUrl(url))
  }
  assert.equal(validatePublicUrl('https://example.com/article').href, 'https://example.com/article')
})

test('page extraction yields title and readable text without script content', () => {
  const page = extractPage('<html><head><title>A &amp; B</title><script>secret()</script></head><body><main><h1>News</h1><p>First &lt;item&gt; here.</p></main></body></html>')
  assert.equal(page.title, 'A & B')
  assert.match(page.text, /News/)
  assert.match(page.text, /First <item> here/)
  assert.doesNotMatch(page.text, /secret/)
})

test('research follows public redirect and refuses a private redirect', async () => {
  const request = async (url: URL): Promise<WebResponse> => url.pathname === '/start'
    ? { status: 302, headers: { location: '/final' }, body: '' }
    : { status: 200, headers: { 'content-type': 'text/html' }, body: '<title>Source</title><p>Evidence</p>' }
  const service = new ResearchService({ request })
  const result = await service.open('https://example.com/start', new AbortController().signal)
  assert.equal(result.url, 'https://example.com/final')
  assert.equal(result.title, 'Source')
  assert.match(result.text, /Evidence/)

  const unsafe = new ResearchService({ request: async () => ({ status: 302, headers: { location: 'https://127.0.0.1/admin' }, body: '' }) })
  await assert.rejects(unsafe.open('https://example.com/start', new AbortController().signal))
})

test('search parses configured SearXNG results with source URLs', async () => {
  const service = new ResearchService({
    search: { kind: 'searxng', endpoint: 'https://search.example.com/' },
    request: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ results: [
      { title: 'First', url: 'https://source.example/a', content: 'The source summary.' },
      { title: 'Private', url: 'http://127.0.0.1/a', content: 'Ignore me.' },
    ] }) }),
  })
  const result = await service.search('test question', new AbortController().signal)
  assert.deepEqual(result, [{ title: 'First', url: 'https://source.example/a', snippet: 'The source summary.' }])
})

test('agent tools return actual source references and page text', async () => {
  const research = new ResearchService({ search: { kind: 'searxng', endpoint: 'https://search.example/' }, request: async url =>
    url.pathname === '/search'
      ? { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ results: [{ title: 'Evidence', url: 'https://source.example/article', content: 'Result' }] }) }
      : { status: 200, headers: { 'content-type': 'text/html' }, body: '<title>Evidence</title><p>Article body</p>' },
  })
  const tools = new ToolRegistry({ research })
  const context = { workspace: '/tmp', paths: new PathPolicy({ root: '/tmp' }), signal: new AbortController().signal }
  const found = await tools.execute('web_search', { query: 'evidence' }, context)
  const opened = await tools.execute('open_url', { url: 'https://source.example/article' }, context)
  assert.equal(found.ok, true)
  assert.match(found.output, /https:\/\/source\.example\/article/)
  assert.match(opened.output, /Article body/)
  assert.equal(tools.list().find(tool => tool.name === 'web_search')?.requiresApproval, false)
})

test('research configuration persists privately without returning the API key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-web-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'research.json')
  const vault = new CredentialVault(randomBytes(32))
  const status = await saveResearchConfig(file, { kind: 'brave', apiKey: 'secret-test-key' }, vault)
  assert.deepEqual(status, { kind: 'brave', configured: true })
  assert.deepEqual(loadResearchConfig(file, vault), { kind: 'brave', apiKey: 'secret-test-key' })
  assert.doesNotMatch(await readFile(file, 'utf8'), /secret-test-key/)
  await assert.rejects(saveResearchConfig(file, { kind: 'searxng', endpoint: 'http://localhost:8080' }, vault))
  assert.deepEqual(loadResearchConfig(file, vault), { kind: 'brave', apiKey: 'secret-test-key' })
  vault.destroy()
})

test('Jef retries a transient read-only web failure once and records the real result', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-retry-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let requests = 0
  const research = new ResearchService({ request: async () => {
    requests += 1
    return requests === 1
      ? { status: 503, headers: {}, body: '' }
      : { status: 200, headers: { 'content-type': 'text/html' }, body: '<title>Real</title><p>Recovered</p>' }
  } })
  let turn = 0
  const gateway: Gateway = { info(): GatewayInfo { return { provider: 'fixture', model: 'fixture', transport: 'streaming' } }, async *stream() {
    yield turn++ === 0 ? '<<<NTHN_TOOL>>>{"tool":"open_url","arguments":{"url":"https://example.com/"}}<<<END_NTHN_TOOL>>>' : 'The page says Recovered.'
  } }
  const store = new AgentChatStore(join(root, 'chats')); await store.load()
  const agent = new JefAgent({ store, gateway, workspace: root, research })
  const chat = await agent.newConversation()
  await agent.run(chat.id, 'Read that page', () => undefined)
  assert.equal(requests, 2)
  assert.match(chat.messages.find(message => message.role === 'tool')?.content ?? '', /Recovered/)
})

test('Brave search never sends its API key to a redirect target', async () => {
  let calls = 0
  const service = new ResearchService({ search: { kind: 'brave', apiKey: 'secret-test-key' }, request: async () => {
    calls += 1
    return { status: 302, headers: { location: 'https://another.example/search' }, body: '' }
  } })
  await assert.rejects(service.search('news', new AbortController().signal), /redirect/i)
  assert.equal(calls, 1)
})
