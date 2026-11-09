import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve } from 'node:path'
import * as gatewayModule from '../server/agent/gateway.ts'
import type { ModelRoute } from '../server/ai/contracts.ts'
import type { AgentState } from '../server/agent/agent.ts'
import { ManagementError } from '../server/ai/management-types.ts'

test('resolved route gateway sends Alex tool context through the saved model route', async () => {
  const Gateway = (gatewayModule as typeof gatewayModule & { ResolvedRouteGateway?: new (manager: unknown, resolver: () => Promise<ModelRoute>) => gatewayModule.Gateway }).ResolvedRouteGateway
  assert.equal(typeof Gateway, 'function')
  const route = {
    id: 'route', ref: { connectionId: 'account', nativeModelId: 'openrouter/coder', upstreamEndpointId: null },
    providerId: 'openrouter', protocol: 'openai-chat', connectionRevision: 3,
  } as ModelRoute
  let request: Record<string, unknown> | null = null
  const manager = {
    async *streamInference(connectionId: string, revision: number, body: Record<string, unknown>) {
      assert.equal(connectionId, 'account')
      assert.equal(revision, 3)
      request = body
      yield 'data: {"choices":[{"delta":{"content":"Tool-ready Alex"}}]}\n\n'
      yield 'data: [DONE]\n\n'
    },
  }
  const gateway = new Gateway!(manager, async () => route)
  const output: string[] = []
  for await (const chunk of gateway.stream([
    { role: 'system', content: 'Use workspace tools.' },
    { role: 'user', content: 'Inspect this project.' },
  ])) if (typeof chunk === 'string') output.push(chunk)
  assert.equal(output.join(''), 'Tool-ready Alex')
  const captured = request as unknown as Record<string, unknown>
  assert.equal(captured.model, 'openrouter/coder')
  assert.match(JSON.stringify(captured), /Use workspace tools/)
  assert.deepEqual(gateway.info(), { provider: 'openrouter', model: 'openrouter/coder', transport: 'streaming' })
})

test('Alex switches provider accounts when a request fails before model output', async () => {
  const first = { id: 'first', ref: { connectionId: 'openrouter-account', nativeModelId: 'router/model' }, providerId: 'openrouter', connectionRevision: 1 } as ModelRoute
  const second = { id: 'second', ref: { connectionId: 'openai-account', nativeModelId: 'gpt-model' }, providerId: 'openai', connectionRevision: 1 } as ModelRoute
  const calls: string[] = []
  const gateway = new gatewayModule.ResolvedRouteGateway({
    async *streamInference(id: string) {
      calls.push(id)
      if (id === first.ref.connectionId) throw new ManagementError('REQUEST_FAILED')
      yield 'data: {"choices":[{"delta":{"content":"Recovered"}}]}\n\n'
      yield 'data: [DONE]\n\n'
    },
  }, async excluded => excluded?.has(first.ref.connectionId) ? second : first)
  const output: string[] = []
  for await (const chunk of gateway.stream([{ role: 'user', content: 'Hello' }])) if (typeof chunk === 'string') output.push(chunk)
  assert.equal(output.join(''), 'Recovered')
  assert.deepEqual(calls, ['openrouter-account', 'openai-account'])
  assert.equal(gateway.info()?.provider, 'openai')
})

test('OpenRouter assembles fragmented parallel tool calls and returns matching results', async () => {
  const route = { ref: { connectionId: 'account', nativeModelId: 'bytedance-seed/seed-2.0-code' }, providerId: 'openrouter', connectionRevision: 1 } as ModelRoute
  const bodies: Record<string, unknown>[] = []
  const gateway = new gatewayModule.ResolvedRouteGateway({ async *streamInference(_id: string, _rev: number, body: Record<string, unknown>) {
    bodies.push(body)
    if (bodies.length === 1) {
      yield 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"list_dir","arguments":"{\\"path\\":\\""}},{"index":1,"id":"b","function":{"name":"search","arguments":"{\\"pattern\\":\\"x"}}]}}]}\n\n'
      yield 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".\\"}"}},{"index":1,"function":{"arguments":"\\"}"}}]}}]}\n\n'
    } else yield 'data: {"choices":[{"delta":{"content":"Done"}}]}\n\n'
    yield 'data: [DONE]\n\n'
  } }, async () => route)
  const tools: gatewayModule.ToolSchema[] = [{ name: 'list_dir', description: 'List', arguments: { path: 'string' } }, { name: 'search', description: 'Search', arguments: { pattern: 'string' } }]
  const first: unknown[] = []
  for await (const item of gateway.stream([{ role: 'user', content: 'Inspect' }], { tools })) first.push(item)
  assert.deepEqual(first, [{ kind: 'tool_call', id: 'a', name: 'list_dir', arguments: { path: '.' } }, { kind: 'tool_call', id: 'b', name: 'search', arguments: { pattern: 'x' } }])
  const second: unknown[] = []
  for await (const item of gateway.stream([{ role: 'assistant', content: '', toolCalls: first.map((call: any) => ({ id: call.id, name: call.name, arguments: call.arguments })) }, { role: 'tool', toolCallId: 'a', content: '0 entries' }, { role: 'tool', toolCallId: 'b', content: '0 matches' }], { tools })) second.push(item)
  assert.deepEqual(second, ['Done'])
  assert.deepEqual((bodies[1].messages as any[]).filter(item => item.role === 'tool').map(item => item.tool_call_id), ['a', 'b'])
})

test('Seed model hides a streamed internal draft before its final answer', async () => {
  const route = { ref: { connectionId: 'account', nativeModelId: 'bytedance-seed/seed-2.0-code' }, providerId: 'openrouter', connectionRevision: 1 } as ModelRoute
  const gateway = new gatewayModule.ResolvedRouteGateway({ async *streamInference() {
    yield 'data: {"choices":[{"delta":{"content":"I should inspect the files first."}}]}\n\n'
    yield 'data: {"choices":[{"delta":{"content":"</think_never_used_abc123>"}}]}\n\n'
    yield 'data: {"choices":[{"delta":{"content":"No project files are in this workspace."}}]}\n\n'
    yield 'data: [DONE]\n\n'
  } }, async () => route)
  const output: unknown[] = []
  for await (const item of gateway.stream([{ role: 'user', content: 'Inspect' }])) output.push(item)
  assert.deepEqual(output, ['No project files are in this workspace.'])
})

test('mobile snapshot exposes persistent messages and one exact pending approval', async () => {
  const modulePath = resolve('server/agent/nthn-agent-mobile.ts')
  assert.equal(existsSync(modulePath), true)
  const mobile = await import('../server/agent/nthn-agent-mobile.ts')
  const state = {
    conversations: [], activeId: 'conversation', gateway: { provider: 'openrouter', model: 'coder', transport: 'streaming' },
    workspace: '/data/data/com.nthn/files/home', protectedPaths: ['.local'], tools: [],
    active: {
      id: 'conversation', title: 'Fix project', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z',
      messages: [
        { id: 'u', role: 'user', content: 'Fix it', createdAt: '2026-01-01T00:00:00Z', status: 'complete' },
        { id: 'a', role: 'assistant', content: 'I need to edit it.', createdAt: '2026-01-01T00:00:01Z', status: 'complete', toolCalls: [
          { id: 'call', tool: 'edit_file', arguments: { path: 'src/app.ts', oldText: 'a', newText: 'b' }, status: 'awaiting-approval', summary: 'Edit src/app.ts', approvalId: 'approval-1', approvalExpiresAt: 2_000_000_000_000 },
        ] },
      ],
    },
  } as AgentState
  const snapshot = mobile.mobileAgentSnapshot(state)
  assert.equal(snapshot.conversationId, 'conversation')
  assert.equal(snapshot.messages.length, 2)
  assert.deepEqual(snapshot.pendingApproval, {
    conversationId: 'conversation', approvalId: 'approval-1', tool: 'edit_file', summary: 'Edit src/app.ts', expiresAt: 2_000_000_000_000,
  })
  assert.equal(JSON.stringify(snapshot).includes('oldText'), false)
  state.active!.messages[1].toolCalls![0].approvalExpiresAt = 1
  assert.equal(mobile.mobileAgentSnapshot(state).pendingApproval, null)
})

test('the packaged agent CLI entry point exists', () => {
  assert.equal(existsSync(resolve('server/agent/nthn-agent-cli.ts')), true)
})

test('mobile snapshot distinguishes empty and populated project workspaces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nthn-workspace-'))
  try {
    const mobile = await import('../server/agent/nthn-agent-mobile.ts')
    const state = { active: null, activeId: null, conversations: [], gateway: null, tools: [], protectedPaths: [], workspace: root } as AgentState
    assert.equal(mobile.mobileAgentSnapshot(state).workspaceStatus, 'empty')
    mkdirSync(join(root, 'project'))
    assert.equal(mobile.mobileAgentSnapshot(state).workspaceStatus, 'populated')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
