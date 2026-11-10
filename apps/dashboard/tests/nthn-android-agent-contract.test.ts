import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

async function source(path: string): Promise<string> {
  return await readFile(resolve('../nthn', path), 'utf8')
}

test('Android patch packages the complete Alex runtime and terminal launcher', async () => {
  const patch = await source('scripts/patch_nthn.py')
  const installer = await source('branding/app/src/main/java/com/termux/app/NthnAiInstaller.java')
  assert.match(patch, /agent_sources.*'agent'/)
  assert.match(patch, /providers\.ts/)
  assert.match(installer, /nthn-agent/)
  assert.match(installer, /nthn-agent-cli\.ts/)
})

test('native bridge invokes Alex with the private Linux workspace and exact approval contract', async () => {
  const backend = await source('branding/app/src/main/java/com/termux/app/NthnBackend.java')
  const activity = await source('branding/app/src/main/java/com/termux/app/NthnActivity.java')
  assert.match(backend, /NTHN_AGENT_WORKSPACE/)
  assert.match(backend, /environment\(\).*HOME/s)
  assert.match(backend, /environment\(\).*PATH/s)
  assert.match(backend, /nthn-agent-cli\.ts/)
  assert.match(activity, /backend\.agentStream\("chat-stream"/)
  assert.match(activity, /@JavascriptInterface public void approve\(String conversationId, String approvalId, boolean approved\)/)
  assert.match(activity, /backend\.agentStream\("approve-stream"/)
  assert.match(activity, /"add-account-stdin" : "add-provider-stdin"/)
  assert.match(activity, /deliver\("accounts"/)
  assert.match(activity, /configureWebProvider\(this\)/)
  assert.match(activity, /bridge\.deliver\("accounts"/)
})

test('Android Alex UI renders persisted snapshots, tool output and approval choices', async () => {
  const ui = await source('ui-preview/index.html')
  assert.match(ui, /function renderSnapshot/)
  assert.match(ui, /pendingApproval/)
  assert.match(ui, /Approve/)
  assert.match(ui, /Deny/)
  assert.match(ui, /NthnAI\.approve/)
  assert.match(ui, /kind === 'accounts'/)
  assert.match(ui, /new-conversation/)
})

test('Android Jef UI lets the user select a Linux home project', async () => {
  const activity = await source('branding/app/src/main/java/com/termux/app/NthnActivity.java')
  const ui = await source('ui-preview/index.html')
  assert.match(activity, /@JavascriptInterface public void workspace\(String path\)/)
  assert.match(activity, /backend\.agent\("workspace"/)
  assert.match(ui, /NthnAI\.workspace\(/)
  assert.match(ui, /workspaceRelative/)
  assert.match(ui, /snapshot\.projects/)
})

test('Android Jef bridge forwards live agent progress to the conversation screen', async () => {
  const backend = await source('branding/app/src/main/java/com/termux/app/NthnBackend.java')
  const activity = await source('branding/app/src/main/java/com/termux/app/NthnActivity.java')
  const ui = await source('ui-preview/index.html')
  assert.match(backend, /agentStream\(/)
  assert.match(activity, /backend\.agentStream\("chat-stream"/)
  assert.match(activity, /backend\.agentStream\("approve-stream"/)
  assert.match(ui, /kind === 'progress'/)
})

test('Android provider UI confirms detected keys, discovers models and removes accounts', async () => {
  const activity = await source('branding/app/src/main/java/com/termux/app/NthnActivity.java')
  const ui = await source('ui-preview/index.html')
  assert.match(activity, /detect-provider-stdin/)
  assert.match(activity, /Confirm the suggested provider/)
  assert.match(activity, /@JavascriptInterface public void removeAccount/)
  assert.match(activity, /backend\.ai\("models"/)
  assert.match(ui, /NthnAI\.removeAccount/)
  assert.match(ui, /kind === 'models'/)
})
