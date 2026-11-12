import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

async function source(path: string): Promise<string> {
  return await readFile(resolve('../nthn', path), 'utf8')
}

test('Android patch packages the complete Jef runtime and terminal launcher', async () => {
  const patch = await source('scripts/patch_nthn.py')
  const installer = await source('branding/app/src/main/java/com/termux/app/NthnAiInstaller.java')
  assert.match(patch, /agent_sources.*'agent'/)
  assert.match(patch, /providers\.ts/)
  assert.match(installer, /nthn-agent/)
  assert.match(installer, /nthn-agent-cli\.ts/)
})

test('native bridge invokes Jef with the private Linux workspace and exact approval contract', async () => {
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

test('Android Jef UI renders persisted snapshots, tool output and approval choices', async () => {
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

test('Android navigation records real native screen state for Jef', async () => {
  const activity = await source('branding/app/src/main/java/com/termux/app/NthnActivity.java')
  const navigation = await source('branding/app/src/main/java/com/termux/app/NthnNavigation.java')
  const recorder = await source('branding/app/src/main/java/com/termux/app/NthnAppState.java')
  const ui = await source('ui-preview/index.html')
  assert.match(activity, /NthnAppState\.record\(this, screen\)/)
  assert.match(navigation, /NthnAppState\.record\(activity, "terminal"\)/)
  assert.match(recorder, /app-state\.json/)
  assert.match(activity, /@JavascriptInterface public void screenState\(String value\)/)
  assert.match(recorder, /recordDashboard/)
  assert.match(ui, /NthnAI\.screenState/)
})

test('native terminal publishes a bounded read-only transcript snapshot for Jef', async () => {
  const patch = await source('scripts/patch_nthn.py')
  const recorder = await source('branding/app/src/main/java/com/termux/app/NthnTerminalState.java')
  assert.match(patch, /recordTerminalState\(changedSession\)/)
  assert.match(recorder, /terminal-state\.json/)
  assert.match(recorder, /getTranscriptText/)
  assert.match(recorder, /MAX_TRANSCRIPT/)
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

test('Android Jef UI exposes a persistent manual uncensored communication mode', async () => {
  const activity = await source('branding/app/src/main/java/com/termux/app/NthnActivity.java')
  const ui = await source('ui-preview/index.html')
  assert.match(activity, /@JavascriptInterface public void communicationMode/)
  assert.match(activity, /agentAction\("communication-mode"/)
  assert.match(ui, /Uncensored \(creator-direct\)/)
  assert.match(ui, /NthnAI\.communicationMode/)
})

test('V2 Android bridge exposes permission-gated camera, speech, location, storage and voice actions', async () => {
  const patch = await source('scripts/patch_nthn.py')
  const activity = await source('branding/app/src/main/java/com/termux/app/NthnActivity.java')
  const controller = await source('branding/app/src/main/java/com/termux/app/NthnDeviceController.java')
  const ui = await source('ui-preview/index.html')
  assert.match(patch, /android\.permission\.CAMERA/)
  assert.match(patch, /android\.permission\.RECORD_AUDIO/)
  assert.match(patch, /android\.permission\.ACCESS_FINE_LOCATION/)
  assert.match(activity, /@JavascriptInterface public void captureCamera\(\)/)
  assert.match(activity, /@JavascriptInterface public void listen\(\)/)
  assert.match(activity, /@JavascriptInterface public void stopListening\(\)/)
  assert.match(activity, /@JavascriptInterface public void locate\(\)/)
  assert.match(activity, /@JavascriptInterface public void importFile\(\)/)
  assert.match(activity, /@JavascriptInterface public void speak\(String text\)/)
  assert.match(controller, /ActivityCompat\.requestPermissions/)
  assert.match(controller, /void stopListening\(Events events\)/)
  assert.match(controller, /boolean granted = false/)
  assert.match(controller, /requestCode == LOCATION_PERMISSION\) readLocation/)
  assert.match(controller, /if \(target != null && target\.isFile\(\)\) target\.delete\(\)/)
  assert.match(ui, /NthnAI\.captureCamera\(\)/)
  assert.match(ui, /NthnAI\.listen\(\)/)
  assert.match(ui, /NthnAI\.stopListening\(\)/)
  assert.match(ui, /NthnAI\.locate\(\)/)
  assert.match(ui, /NthnAI\.importFile\(\)/)
  assert.match(ui, /NthnAI\.speak\(/)
})
