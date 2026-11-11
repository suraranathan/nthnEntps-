import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskStore } from '../server/agent/tasks.ts'
import { AutonomyPolicy, loadAutonomyPolicy } from '../server/agent/autonomy.ts'
import { AgentChatStore } from '../server/agent/store.ts'
import { JefAgent } from '../server/agent/agent.ts'
import type { Gateway, GatewayInfo } from '../server/agent/gateway.ts'
import { ToolRegistry } from '../server/agent/tools.ts'

test('task history survives restart and unfinished runs become interrupted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-tasks-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'tasks.sqlite')
  const first = new TaskStore(file)
  const task = first.create('conversation-1', 'Fix the dashboard', 8)
  first.setPlan(task.id, [{ action: 'Inspect files', done: false }, { action: 'Run tests', done: false }])
  first.append(task.id, 'tool', 'read_file succeeded')
  first.close()
  const second = new TaskStore(file)
  const restored = second.get(task.id)!
  assert.equal(restored.status, 'interrupted')
  assert.equal(restored.plan.length, 2)
  assert.equal(restored.events[0].summary, 'read_file succeeded')
  second.resume(task.id)
  second.finish(task.id, 'completed')
  assert.equal(second.get(task.id)?.status, 'completed')
  second.close()
})

test('autonomy only permits an exact authorized command before expiry and budget', () => {
  const policy = new AutonomyPolicy({ mode: 'bounded', expiresAt: Date.now() + 60_000, commands: ['npm test'], maxCommands: 1 })
  assert.equal(policy.useCommand('npm test'), true)
  assert.equal(policy.useCommand('npm test'), false)
  assert.equal(policy.useCommand('npm install'), false)
  assert.equal(new AutonomyPolicy({ mode: 'supervised' }).useCommand('npm test'), false)
  assert.throws(() => new AutonomyPolicy({ mode: 'bounded', expiresAt: Date.now() + 60_000, commands: ['git reset --hard HEAD'], maxCommands: 1 }))
  const tools = new ToolRegistry({ requireCommandApproval: true, autonomy: new AutonomyPolicy({ mode: 'bounded', expiresAt: Date.now() + 60_000, commands: ['npm test'], maxCommands: 1 }) })
  assert.equal(tools.needsApproval('run_command', { command: 'npm test' }), false)
  assert.equal(tools.needsApproval('run_command', { command: 'npm test' }), true)
})

test('agent persists its plan, tool progress, and completion in task history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-task-agent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tasks = new TaskStore(join(root, 'tasks.sqlite'))
  t.after(() => { tasks.close() })
  const store = new AgentChatStore(join(root, 'chats'))
  await store.load()
  const gateway: Gateway = {
    info(): GatewayInfo { return { provider: 'fixture', model: 'fixture', transport: 'streaming' } },
    async *stream() {
      if (!this.used) {
        this.used = true
        yield '<<<NTHN_TOOL>>>{"tool":"set_task_plan","arguments":{"steps":"[{\\"action\\":\\"Inspect files\\",\\"done\\":false}]"}}<<<END_NTHN_TOOL>>>'
      } else yield 'Inspection complete.'
    },
    used: false,
  } as Gateway & { used: boolean }
  const agent = new JefAgent({ store, gateway, workspace: root, tasks })
  const conversation = await agent.newConversation()
  await agent.run(conversation.id, 'Inspect the project', () => undefined)
  const task = tasks.latestForConversation(conversation.id)!
  assert.equal(task.status, 'completed')
  assert.equal(task.plan[0].action, 'Inspect files')
  assert.ok(task.events.some(event => event.type === 'tool'))
})

test('an expired autonomy grant returns to supervised mode on restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-autonomy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'autonomy.json')
  await import('node:fs/promises').then(fs => fs.writeFile(file, JSON.stringify({ mode: 'bounded', expiresAt: Date.now() - 1000, commands: ['npm test'], maxCommands: 1 })))
  assert.deepEqual(loadAutonomyPolicy(file).snapshot(), { mode: 'supervised' })
})
