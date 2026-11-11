import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mobileAgentSnapshot } from '../server/agent/nthn-agent-mobile.ts'
import type { AgentState } from '../server/agent/agent.ts'

test('mobile approval includes exact proposed edits', () => {
  const root = mkdtempSync(join(tmpdir(), 'jef-preview-'))
  try {
    const now = Date.now()
    const state = {
      workspace: root, activeId: 'chat', gateway: null, tools: [], protectedPaths: [], conversations: [],
      active: { id: 'chat', title: 'Edit', createdAt: '', updatedAt: '', messages: [{ id: 'message', role: 'assistant', content: '', createdAt: '', status: 'complete', toolCalls: [{ id: 'call', tool: 'edit_files', arguments: { changes: JSON.stringify([{ path: 'a.txt', oldText: 'old', newText: 'new' }]) }, status: 'awaiting-approval', approvalId: 'approval', approvalExpiresAt: now + 60000 }] }] },
    } as AgentState
    const snapshot = mobileAgentSnapshot(state)
    assert.match(snapshot.pendingApproval?.preview ?? '', /a\.txt/)
    assert.match(snapshot.pendingApproval?.preview ?? '', /- old/)
    assert.match(snapshot.pendingApproval?.preview ?? '', /\+ new/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('oversized proposals are marked as incomplete previews', () => {
  const now = Date.now()
  const state = {
    workspace: tmpdir(), activeId: 'chat', gateway: null, tools: [], protectedPaths: [], conversations: [],
    active: { id: 'chat', title: 'Write', createdAt: '', updatedAt: '', messages: [{ id: 'message', role: 'assistant', content: '', createdAt: '', status: 'complete', toolCalls: [{ id: 'call', tool: 'write_file', arguments: { path: 'a.txt', content: 'x'.repeat(25000) }, status: 'awaiting-approval', approvalId: 'approval', approvalExpiresAt: now + 60000 }] }] },
  } as AgentState
  assert.equal(mobileAgentSnapshot(state).pendingApproval?.previewTruncated, true)
})
