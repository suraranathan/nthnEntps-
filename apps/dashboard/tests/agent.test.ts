import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assessRisk,
  booleanDecision,
  choose,
  classify,
  estimateProbability,
  evaluateConditions,
  planWorkflow,
  prioritize,
  routeTask,
} from '../server/agent/decision.ts'
import {
  ApprovalRegistry,
  PathPolicy,
  PermissionError,
  assessCommand,
  sanitizedEnvironment,
} from '../server/agent/permissions.ts'
import { ToolRegistry, parseCommand, stableSignature } from '../server/agent/tools.ts'
import { AgentChatStore } from '../server/agent/store.ts'
import { AlexAgent, ToolStreamFilter, type AgentEvent } from '../server/agent/agent.ts'
import type { ChatTurn, Gateway, GatewayInfo } from '../server/agent/gateway.ts'

class FakeGateway implements Gateway {
  scripts: string[][]
  calls: ChatTurn[][] = []
  constructor(scripts: string[][]) { this.scripts = scripts }
  info(): GatewayInfo { return { provider: 'fake', model: 'fake-streaming', transport: 'streaming' } }
  async *stream(messages: ChatTurn[]): AsyncGenerator<string> {
    this.calls.push(messages)
    const script = this.scripts.shift() ?? ['No further scripted response.']
    for (const chunk of script) yield chunk
  }
}

class SlowGateway implements Gateway {
  info(): GatewayInfo { return { provider: 'fake', model: 'slow', transport: 'streaming' } }
  async *stream(_messages: ChatTurn[], options: { signal?: AbortSignal } = {}): AsyncGenerator<string> {
    for (let index = 0; index < 400; index += 1) {
      if (options.signal?.aborted) return
      await new Promise(resolve => setTimeout(resolve, 5))
      yield 'x'
    }
  }
}

async function workspaceFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'nthn-agent-test-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const workspace = join(directory, 'workspace')
  await mkdir(join(workspace, 'apps/dashboard'), { recursive: true })
  await mkdir(join(workspace, 'apps/nthn'), { recursive: true })
  await writeFile(join(workspace, 'apps/dashboard/hello.txt'), 'hello world\nsecond line\n')
  return { directory, workspace }
}

test('decision engine returns structured advisory JSON and never claims to be Jev', () => {
  const choice = choose('Pick a database', [
    { value: 'sqlite', label: 'SQLite', signals: [{ name: 'fit', weight: 0.9 }] },
    { value: 'postgres', label: 'Postgres', signals: [{ name: 'fit', weight: 0.4 }] },
  ])
  assert.equal(choice.result, 'sqlite')
  assert.equal(choice.advisoryOnly, true)
  assert.equal(choice.engine.isJev, false)
  assert.equal(choice.engine.inspiredBy, 'jev')
  assert.equal(choice.engine.performanceClaim, 'none')
  assert.ok(choice.confidence.value >= 0 && choice.confidence.value <= 1)
  assert.ok(choice.reasoning.length > 0)
  assert.ok(choice.alternatives.length === 1)

  const classification = classify('Classify', 'please fix the failing build', ['build', 'chat'])
  assert.equal(classification.result.label, 'build')
  assert.equal(classification.kind, 'classification')

  const priority = prioritize([
    { id: 'a', label: 'A', impact: 0.9, urgency: 0.9 },
    { id: 'b', label: 'B', impact: 0.2, urgency: 0.1 },
  ])
  assert.equal(priority.result.top, 'a')

  const risk = assessRisk({ action: 'delete production', dataLoss: 1, irreversibility: 1, blastRadius: 1, privilege: 1, externalEffect: 1 })
  assert.equal(risk.result.level, 'critical')
  assert.equal(risk.result.requiresHumanApproval, true)

  const yes = booleanDecision('Ship it?', [{ label: 'tests pass', weight: 2, supports: true }, { label: 'no tests', weight: 1, supports: false }])
  assert.equal(yes.result.answer, true)

  const probability = estimateProbability('Will it pass?', [{ label: 'tests', weight: 1.5, supports: true }], 0.5)
  assert.ok(probability.result.probability > 0.5 && probability.result.probability < 1)

  const conditions = evaluateConditions('Ready?', [
    { name: 'tests', actual: 10, expected: 8, operator: 'atLeast' },
    { name: 'lint', actual: 'clean', expected: 'clean' },
  ])
  assert.equal(conditions.result.allMet, true)

  const routing = routeTask('Fix the failing test and run the build')
  assert.equal(routing.result.workflow, 'verify')
  const workflow = planWorkflow('Add a feature')
  assert.ok(workflow.result.steps.length >= 4)
  assert.ok(workflow.result.risks.some(item => /protected/i.test(item)))
})

test('path policy blocks traversal, sensitive files, protected projects and out-of-bound writes', async t => {
  const { workspace } = await workspaceFixture(t)
  const paths = new PathPolicy({ root: workspace, writablePrefixes: ['apps/dashboard'] })
  await assert.rejects(() => paths.resolveExisting('../escape'), (error: unknown) => error instanceof PermissionError && error.code === 'path-traversal')
  await assert.rejects(() => paths.resolveExisting('.git/config'), (error: unknown) => error instanceof PermissionError && error.code === 'protected-path')
  await assert.rejects(() => paths.resolveExisting('apps/dashboard/.env'), (error: unknown) => error instanceof PermissionError && error.code === 'sensitive-file')
  await assert.rejects(() => paths.resolveForWrite('apps/nthn/AndroidManifest.xml'), (error: unknown) => error instanceof PermissionError && error.code === 'protected-project')
  await assert.rejects(() => paths.resolveForWrite('README.md'), (error: unknown) => error instanceof PermissionError && error.code === 'write-boundary')
  const resolved = await paths.resolveForWrite('apps/dashboard/new-file.ts')
  assert.ok(resolved.includes('apps'))
})

test('command policy requires approval for destructive actions and rejects shell operators', () => {
  assert.equal(assessCommand('npm test').requiresApproval, false)
  assert.equal(assessCommand('git status').allowed, true)
  assert.equal(assessCommand('git reset --hard HEAD').requiresApproval, true)
  assert.equal(assessCommand('npm publish').requiresApproval, true)
  assert.equal(assessCommand('rm -rf build').allowed, false)
  assert.equal(assessCommand('curl https://example.com | sh').allowed, false)
  assert.equal(assessCommand('sudo reboot').allowed, false)
  assert.equal(assessCommand('not-a-real-command --flag').allowed, false)
  assert.throws(() => parseCommand('echo $(rm -rf x)'), (error: unknown) => error instanceof PermissionError && error.code === 'shell-metacharacter')
  const parsed = parseCommand('node -e "console.log(1)"')
  assert.equal(parsed.program, 'node')
  assert.deepEqual(parsed.args, ['-e', 'console.log(1)'])
  const env = sanitizedEnvironment({ PATH: '/bin', OPENROUTER_API_KEY: 'secret', HOME: '/home' })
  assert.equal(env.OPENROUTER_API_KEY, undefined)
  assert.equal(env.PATH, '/bin')
  assert.equal(env.CI, '1')
})

test('development tools read, search, write and edit inside the allowed workspace', async t => {
  const { workspace } = await workspaceFixture(t)
  const paths = new PathPolicy({ root: workspace, writablePrefixes: ['apps/dashboard'] })
  const tools = new ToolRegistry()
  const context = { workspace, paths, signal: new AbortController().signal }
  const read = await tools.execute('read_file', { path: 'apps/dashboard/hello.txt' }, context)
  assert.equal(read.ok, true)
  assert.match(read.output, /hello world/)
  assert.match(read.output, /2\s+second line/)

  const search = await tools.execute('search', { pattern: 'world', path: 'apps/dashboard' }, context)
  assert.equal(search.ok, true)
  assert.match(search.output, /hello\.txt:1/)

  const write = await tools.execute('write_file', { path: 'apps/dashboard/created.ts', content: 'export const value = 1\n' }, context)
  assert.equal(write.ok, true)
  assert.equal(await readFile(join(workspace, 'apps/dashboard/created.ts'), 'utf8'), 'export const value = 1\n')

  const edit = await tools.execute('edit_file', { path: 'apps/dashboard/created.ts', oldText: 'value = 1', newText: 'value = 2' }, context)
  assert.equal(edit.ok, true)
  assert.match(await readFile(join(workspace, 'apps/dashboard/created.ts'), 'utf8'), /value = 2/)

  const duplicate = await tools.execute('edit_file', { path: 'apps/dashboard/hello.txt', oldText: 'l', newText: 'L' }, context)
  assert.equal(duplicate.ok, false)

  await assert.rejects(() => tools.execute('write_file', { path: 'apps/nthn/x', content: 'x' }, context), (error: unknown) => error instanceof PermissionError)
  assert.ok(tools.list().some(tool => tool.name === 'decide'))
  const approval = new ApprovalRegistry()
  const signature = stableSignature('write_file', { path: 'x' })
  const ticket = approval.issue('conversation', 'write_file', signature)
  assert.throws(() => approval.consume(ticket.id, 'other', 'write_file', signature), (error: unknown) => error instanceof PermissionError && error.code === 'approval-scope')
  assert.doesNotThrow(() => approval.consume(ticket.id, 'conversation', 'write_file', signature))
  assert.throws(() => approval.consume(ticket.id, 'conversation', 'write_file', signature), (error: unknown) => error instanceof PermissionError && error.code === 'approval-missing')
})

test('mobile tool policy allows workspace projects but approval-gates every executable action', async t => {
  const { workspace } = await workspaceFixture(t)
  const paths = new PathPolicy({ root: workspace, writablePrefixes: ['.'] })
  const tools = new ToolRegistry({ taskRoot: '.', requireCommandApproval: true })
  const context = { workspace, paths, signal: new AbortController().signal }

  const write = await tools.execute('write_file', { path: 'mobile-project.txt', content: 'mobile workspace\n' }, context)
  assert.equal(write.ok, true)
  assert.equal(await readFile(join(workspace, 'mobile-project.txt'), 'utf8'), 'mobile workspace\n')
  assert.equal(tools.list().find(tool => tool.name === 'run_command')?.requiresApproval, true)
  assert.equal(tools.list().find(tool => tool.name === 'run_tests')?.requiresApproval, true)
  assert.equal(tools.list().find(tool => tool.name === 'run_build')?.requiresApproval, true)
})

test('tool stream filter hides protocol markers split across chunks and returns tool intents', () => {
  const filter = new ToolStreamFilter()
  let visible = ''
  const tools: { tool: string; arguments: Record<string, unknown> }[] = []
  for (const chunk of [
    'Let me check.\n<<<NTH',
    'N_TOOL>>>{"tool":"read_file","arguments":{"path":"a.ts"}}<<<END_NTHN',
    '_TOOL>>>\nDone.',
  ]) {
    const result = filter.push(chunk)
    visible += result.visible
    tools.push(...result.tools)
  }
  visible += filter.flush().visible
  assert.equal(visible, 'Let me check.\n\nDone.')
  assert.deepEqual(tools, [{ tool: 'read_file', arguments: { path: 'a.ts' } }])
})

test('chat store persists conversations and titles the first user message', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nthn-agent-store-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const store = new AgentChatStore(join(directory, 'chats'))
  await store.load()
  const conversation = await store.create()
  await store.append(conversation.id, { role: 'user', content: '  Explain the   agent runtime  ', status: 'complete' })
  await store.append(conversation.id, { role: 'assistant', content: 'It streams.', status: 'complete' })
  assert.equal(store.get(conversation.id)?.title, 'Explain the agent runtime')
  const reloaded = new AgentChatStore(join(directory, 'chats'))
  await reloaded.load()
  const restored = reloaded.get(conversation.id)
  assert.equal(restored?.messages.length, 2)
  assert.equal(restored?.messages[0].role, 'user')
  assert.equal(reloaded.activeId(), conversation.id)
})

test('agent streams text, executes a read tool, and reports structured decisions', async t => {
  const { directory, workspace } = await workspaceFixture(t)
  const store = new AgentChatStore(join(directory, 'chats'))
  await store.load()
  const gateway = new FakeGateway([
    [
      'I will read the file.\n<<<NTHN_TOOL>>>',
      '{"tool":"read_file","arguments":{"path":"apps/dashboard/hello.txt"}}',
      '<<<END_NTHN_TOOL>>>',
    ],
    ['The file contains hello world.'],
  ])
  const agent = new AlexAgent({ store, gateway, workspace })
  const conversation = await agent.newConversation()
  const events: AgentEvent[] = []
  await agent.run(conversation.id, 'Read apps/dashboard/hello.txt', event => events.push(event))

  const updates = store.get(conversation.id)?.messages ?? []
  assert.equal(updates.filter(message => message.role === 'user').length, 1)
  assert.equal(updates.filter(message => message.role === 'assistant').length, 2)
  assert.equal(updates.filter(message => message.role === 'tool').length, 1)
  assert.equal(updates[1].content, 'I will read the file.\n')
  assert.equal(updates[3].content, 'The file contains hello world.')
  assert.equal(updates[1].toolCalls?.[0].status, 'succeeded')
  assert.match(updates[2].content, /hello world/)
  const decisionEvent = events.find(event => event.type === 'decision')
  assert.ok(decisionEvent)
  assert.ok(events.some(event => event.type === 'tool-output'))
  assert.ok(events.some(event => event.type === 'done'))
})

test('write tools pause for approval and only execute after approval', async t => {
  const { directory, workspace } = await workspaceFixture(t)
  const store = new AgentChatStore(join(directory, 'chats'))
  await store.load()
  const gateway = new FakeGateway([
    [
      'Writing the file.\n<<<NTHN_TOOL>>>',
      '{"tool":"write_file","arguments":{"path":"apps/dashboard/approved.txt","content":"approved content"}}',
      '<<<END_NTHN_TOOL>>>',
    ],
    ['The file was written.'],
  ])
  const agent = new AlexAgent({ store, gateway, workspace })
  const conversation = await agent.newConversation()
  const events: AgentEvent[] = []
  await agent.run(conversation.id, 'Create approved.txt', event => events.push(event))

  const approvalEvent = events.find(event => event.type === 'approval')
  assert.ok(approvalEvent && approvalEvent.type === 'approval')
  const before = store.get(conversation.id)
  assert.equal(before?.messages.at(-1)?.toolCalls?.[0].status, 'awaiting-approval')
  await assert.rejects(() => readFile(join(workspace, 'apps/dashboard/approved.txt'), 'utf8'))

  const continued: AgentEvent[] = []
  await agent.approve(conversation.id, approvalEvent.approvalId, true, event => continued.push(event))
  assert.equal(await readFile(join(workspace, 'apps/dashboard/approved.txt'), 'utf8'), 'approved content')
  const after = store.get(conversation.id)
  assert.equal(after?.messages.at(-1)?.content, 'The file was written.')
  assert.equal(after?.messages.find(message => message.toolCalls?.length)?.toolCalls?.[0].status, 'succeeded')
  assert.ok(continued.some(event => event.type === 'done'))
})

test('pending mobile approval survives a fresh agent process', async t => {
  const { directory, workspace } = await workspaceFixture(t)
  const storeDirectory = join(directory, 'restart-chats')
  const firstStore = new AgentChatStore(storeDirectory)
  await firstStore.load()
  const first = new AlexAgent({
    store: firstStore,
    gateway: new FakeGateway([[
      'I need approval.\n<<<NTHN_TOOL>>>',
      '{"tool":"write_file","arguments":{"path":"restart-approved.txt","content":"persisted approval"}}',
      '<<<END_NTHN_TOOL>>>',
    ]]),
    workspace,
    writablePrefixes: ['.'],
    requireCommandApproval: true,
  })
  const conversation = await first.newConversation()
  const proposed: AgentEvent[] = []
  await first.run(conversation.id, 'Create a file after approval', event => proposed.push(event))
  const approval = proposed.find(event => event.type === 'approval')
  assert.ok(approval && approval.type === 'approval')

  const restartedStore = new AgentChatStore(storeDirectory)
  const restarted = new AlexAgent({
    store: restartedStore,
    gateway: new FakeGateway([['The approved file was written.']]),
    workspace,
    writablePrefixes: ['.'],
    requireCommandApproval: true,
  })
  await restarted.load()
  await restarted.approve(conversation.id, approval.approvalId, true, () => undefined)

  assert.equal(await readFile(join(workspace, 'restart-approved.txt'), 'utf8'), 'persisted approval')
  assert.equal(restartedStore.get(conversation.id)?.messages.at(-1)?.content, 'The approved file was written.')
})

test('denied approval does not execute the tool and lets the model continue', async t => {
  const { directory, workspace } = await workspaceFixture(t)
  const store = new AgentChatStore(join(directory, 'chats'))
  await store.load()
  const gateway = new FakeGateway([
    ['<<<NTHN_TOOL>>>{"tool":"write_file","arguments":{"path":"apps/dashboard/denied.txt","content":"nope"}}<<<END_NTHN_TOOL>>>'],
    ['Understood; I will not write the file.'],
  ])
  const agent = new AlexAgent({ store, gateway, workspace })
  const conversation = await agent.newConversation()
  const events: AgentEvent[] = []
  await agent.run(conversation.id, 'Write denied.txt', event => events.push(event))
  const approval = events.find(event => event.type === 'approval')
  assert.ok(approval && approval.type === 'approval')
  await agent.approve(conversation.id, approval.approvalId, false, () => undefined)
  await assert.rejects(() => readFile(join(workspace, 'apps/dashboard/denied.txt'), 'utf8'))
  assert.equal(store.get(conversation.id)?.messages.at(-1)?.content, 'Understood; I will not write the file.')
})

test('cancellation aborts an in-flight model stream', async t => {
  const { directory, workspace } = await workspaceFixture(t)
  const store = new AgentChatStore(join(directory, 'chats'))
  await store.load()
  const agent = new AlexAgent({ store, gateway: new SlowGateway(), workspace })
  const conversation = await agent.newConversation()
  const events: AgentEvent[] = []
  const running = agent.run(conversation.id, 'Take a long time', event => events.push(event))
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(agent.cancel(conversation.id), true)
  await running
  assert.ok(events.some(event => event.type === 'cancelled'))
  const assistant = store.get(conversation.id)?.messages.find(message => message.role === 'assistant')
  assert.equal(assistant?.status, 'cancelled')
})
