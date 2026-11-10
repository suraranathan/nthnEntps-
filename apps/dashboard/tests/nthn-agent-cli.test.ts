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

test('OpenAI chat providers receive native Jef tool definitions and matching tool results', () => {
  const route = { ref: { connectionId: 'a', nativeModelId: 'model' }, providerId: 'openai' } as ModelRoute
  const tools: gatewayModule.ToolSchema[] = [{ name: 'list_dir', description: 'List files', arguments: { path: 'string' } }]
  const first = gatewayModule.requestBody(route, [{ role: 'user', content: 'List files' }], true, 200, tools)
  assert.equal((first.tools as any[])[0].function.name, 'list_dir')
  const next = gatewayModule.requestBody(route, [
    { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'list_dir', arguments: { path: '.' } }] },
    { role: 'tool', toolCallId: 'call-1', content: 'src' },
  ], true, 200, tools)
  assert.equal((next.messages as any[])[1].tool_call_id, 'call-1')
})

test('Anthropic and Gemini requests preserve native tool calls and results', () => {
  const tools: gatewayModule.ToolSchema[] = [{ name: 'list_dir', description: 'List files', arguments: { path: 'string' } }]
  for (const providerId of ['anthropic', 'gemini']) {
    const route = { ref: { connectionId: 'a', nativeModelId: 'model' }, providerId } as ModelRoute
    const body = gatewayModule.requestBody(route, [
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'list_dir', arguments: { path: '.' } }] },
      { role: 'tool', toolCallId: 'call-1', content: 'src' },
    ], true, 200, tools)
    assert.ok(Array.isArray(body.tools))
    assert.match(JSON.stringify(body.messages ?? body.contents), providerId === 'anthropic' ? /tool_use_id/ : /functionResponse/)
  }
})

test('parallel Anthropic and Gemini results stay grouped with their call IDs', () => {
  const turns: gatewayModule.ChatTurn[] = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'one', name: 'list_dir', arguments: { path: '.' } }, { id: 'two', name: 'search', arguments: { pattern: 'x' } }] },
    { role: 'tool', toolCallId: 'one', content: 'files' },
    { role: 'tool', toolCallId: 'two', content: 'matches' },
  ]
  const tools: gatewayModule.ToolSchema[] = [{ name: 'list_dir', description: 'List', arguments: { path: 'string' } }, { name: 'search', description: 'Search', arguments: { pattern: 'string' } }]
  const anthropic = gatewayModule.requestBody({ providerId: 'anthropic', ref: { nativeModelId: 'm' } } as ModelRoute, turns, true, 200, tools)
  assert.equal((anthropic.messages as any[]).length, 2)
  assert.deepEqual((anthropic.messages as any[])[1].content.map((part: any) => part.tool_use_id), ['one', 'two'])
  const gemini = gatewayModule.requestBody({ providerId: 'gemini', ref: { nativeModelId: 'm' } } as ModelRoute, turns, true, 200, tools)
  assert.equal((gemini.contents as any[]).length, 2)
  assert.deepEqual((gemini.contents as any[])[1].parts.map((part: any) => part.functionResponse.id), ['one', 'two'])
})

test('Anthropic and Gemini streamed native calls are returned as structured calls', async () => {
  const tools: gatewayModule.ToolSchema[] = [{ name: 'list_dir', description: 'List files', arguments: { path: 'string' } }]
  const frames: Record<string, string[]> = {
    anthropic: [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-1","name":"list_dir"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\".\\"}"}}\n\n',
    ],
    gemini: ['data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"list_dir","args":{"path":"."}}}]}}]}\n\n'],
  }
  for (const providerId of ['anthropic', 'gemini']) {
    const route = { id: providerId, ref: { connectionId: 'a', nativeModelId: 'model' }, providerId, connectionRevision: 1 } as ModelRoute
    const gateway = new gatewayModule.ResolvedRouteGateway({ async *streamInference() { for (const frame of frames[providerId]) yield frame } }, async () => route)
    const output: unknown[] = []
    for await (const item of gateway.stream([{ role: 'user', content: 'List' }], { tools })) output.push(item)
    assert.equal(output.length, 1)
    assert.equal((output[0] as gatewayModule.NativeToolCall).name, 'list_dir')
    assert.deepEqual((output[0] as gatewayModule.NativeToolCall).arguments, { path: '.' })
  }
})

test('Gemini preserves a provider call ID when returning the tool result', async () => {
  const route = { id: 'gemini', ref: { connectionId: 'a', nativeModelId: 'm' }, providerId: 'gemini', connectionRevision: 1 } as ModelRoute
  const gateway = new gatewayModule.ResolvedRouteGateway({ async *streamInference() {
    yield 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"provider-call","name":"list_dir","args":{"path":"."}}}]}}]}\n\n'
  } }, async () => route)
  const tools: gatewayModule.ToolSchema[] = [{ name: 'list_dir', description: 'List', arguments: { path: 'string' } }]
  const calls: gatewayModule.NativeToolCall[] = []
  for await (const item of gateway.stream([{ role: 'user', content: 'List' }], { tools })) if (typeof item !== 'string') calls.push(item)
  assert.equal(calls[0].id, 'provider-call')
  const next = gatewayModule.requestBody(route, [
    { role: 'assistant', content: '', toolCalls: [{ id: calls[0].id, name: calls[0].name, arguments: calls[0].arguments }] },
    { role: 'tool', toolCallId: calls[0].id, content: 'files' },
  ], true, 200, tools)
  assert.equal((next.contents as any[])[1].parts[0].functionResponse.id, 'provider-call')
})

test('Ollama streams native calls and receives the matching tool name on continuation', async () => {
  const route = { id: 'local', ref: { connectionId: 'a', nativeModelId: 'local-coder' }, providerId: 'ollama', connectionRevision: 1 } as ModelRoute
  const tools: gatewayModule.ToolSchema[] = [{ name: 'list_dir', description: 'List', arguments: { path: 'string' } }]
  const gateway = new gatewayModule.ResolvedRouteGateway({ async *streamInference() {
    yield '{"message":{"tool_calls":[{"function":{"name":"list_dir","arguments":{"path":"."}}}]},"done":false}\n'
  } }, async () => route)
  const calls: gatewayModule.NativeToolCall[] = []
  for await (const item of gateway.stream([{ role: 'user', content: 'List' }], { tools })) if (typeof item !== 'string') calls.push(item)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].arguments, { path: '.' })
  const next = gatewayModule.requestBody(route, [
    { role: 'assistant', content: '', toolCalls: [{ id: calls[0].id, name: calls[0].name, arguments: calls[0].arguments }] },
    { role: 'tool', toolCallId: calls[0].id, content: 'files' },
  ], true, 200, tools)
  assert.equal((next.tools as any[])[0].function.name, 'list_dir')
  assert.equal((next.messages as any[])[1].tool_name, 'list_dir')
})

test('native streams keep no-argument calls and a final frame without a newline', async () => {
  const tools: gatewayModule.ToolSchema[] = [{ name: 'list_dir', description: 'List', arguments: {} }]
  for (const [providerId, frame] of [
    ['openrouter', 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"list_dir","arguments":"{}"}}]}}]}'],
    ['gemini', 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"list_dir"}}]}}]}'],
    ['ollama', '{"message":{"tool_calls":[{"function":{"name":"list_dir"}}]},"done":true}'],
  ] as const) {
    const route = { id: providerId, ref: { connectionId: 'a', nativeModelId: 'm' }, providerId, connectionRevision: 1 } as ModelRoute
    const gateway = new gatewayModule.ResolvedRouteGateway({ async *streamInference() { yield frame } }, async () => route)
    const calls: gatewayModule.NativeToolCall[] = []
    for await (const item of gateway.stream([{ role: 'user', content: 'List' }], { tools })) if (typeof item !== 'string') calls.push(item)
    assert.equal(calls.length, 1, providerId)
    assert.deepEqual(calls[0].arguments, {})
  }
})

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
  }, async excluded => excluded?.has(first.id) ? second : first)
  const output: string[] = []
  for await (const chunk of gateway.stream([{ role: 'user', content: 'Hello' }])) if (typeof chunk === 'string') output.push(chunk)
  assert.equal(output.join(''), 'Recovered')
  assert.deepEqual(calls, ['openrouter-account', 'openai-account'])
  assert.equal(gateway.info()?.provider, 'openai')
})

test('Jef can retry another model on the same account after a request-shape rejection', async () => {
  const first = { id: 'first', ref: { connectionId: 'account', nativeModelId: 'bad' }, providerId: 'openrouter', connectionRevision: 1 } as ModelRoute
  const second = { id: 'second', ref: { connectionId: 'account', nativeModelId: 'good' }, providerId: 'openrouter', connectionRevision: 1 } as ModelRoute
  const calls: string[] = []
  const gateway = new gatewayModule.ResolvedRouteGateway({ async *streamInference(_id: string, _rev: number, body: Record<string, unknown>) {
    calls.push(String(body.model))
    if (body.model === 'bad') throw new ManagementError('INCOMPATIBLE')
    yield 'data: {"choices":[{"delta":{"content":"Ready"}}]}\n\n'
  } }, async excluded => excluded?.has(first.id) ? second : first)
  const output: unknown[] = []
  for await (const item of gateway.stream([{ role: 'user', content: 'Hi' }])) output.push(item)
  assert.deepEqual(output, ['Ready'])
  assert.deepEqual(calls, ['bad', 'good'])
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

test('mobile progress reports tool activity without exposing tool arguments', async () => {
  const mobile = await import('../server/agent/nthn-agent-mobile.ts')
  const event = { type: 'tool-output', conversationId: 'c', messageId: 'm', call: {
    id: 'call', tool: 'write_file', arguments: { content: 'private source text' }, status: 'succeeded', summary: 'Wrote app.ts', output: 'Wrote app.ts',
  } } as unknown as import('../server/agent/agent.ts').AgentEvent
  const progress = mobile.mobileAgentProgress(event)
  assert.deepEqual(progress, { type: 'tool-output', messageId: 'm', tool: 'write_file', status: 'succeeded', summary: 'Wrote app.ts', output: 'Wrote app.ts' })
  assert.doesNotMatch(JSON.stringify(progress), /private source text/)
  assert.deepEqual(mobile.mobileAgentProgress({ type: 'delta', conversationId: 'c', messageId: 'm', text: 'Hello' }), { type: 'delta', messageId: 'm', text: 'Hello' })
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
