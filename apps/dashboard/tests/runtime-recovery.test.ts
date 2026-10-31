import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeRecovery, type RecoveryState } from '../src/runtime-recovery.ts'

async function until(check: () => boolean) {
  for (let i = 0; i < 60; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Timed out waiting for recovery state')
}

test('failed requests back off, recover, and never overlap', async () => {
  let calls = 0, active = 0, maxActive = 0
  const states: RecoveryState[] = []
  const recovery = new RuntimeRecovery(async () => {
    calls++; active++; maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, 3))
    active--
    if (calls < 3) throw new Error('backend unavailable')
  }, state => states.push(state), { retryDelays: [5, 10] })
  await assert.rejects(recovery.refresh(), /backend unavailable/)
  await until(() => states.at(-1) === 'connected')
  assert.equal(calls, 3)
  assert.equal(maxActive, 1)
  assert.ok(states.includes('reconnecting'))
  recovery.stop()
})

test('resume bursts share a running request and retry budget stops', async () => {
  let calls = 0
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const states: RecoveryState[] = []
  const recovery = new RuntimeRecovery(async () => {
    calls++
    await pending
    throw new Error('still offline')
  }, state => states.push(state), { retryDelays: [5] })
  const first = recovery.refresh()
  assert.equal(recovery.refresh(), first)
  assert.equal(recovery.refresh(), first)
  await until(() => calls === 1)
  release()
  await assert.rejects(first, /still offline/)
  await until(() => states.at(-1) === 'offline')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls, 2, 'no retry loop after the finite budget')
  recovery.stop()
})

test('cleanup aborts in-flight work and cancels scheduled retries', async () => {
  let calls = 0
  const states: RecoveryState[] = []
  const recovery = new RuntimeRecovery(async signal => {
    calls++
    if (calls === 1) throw new Error('temporary failure')
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  }, state => states.push(state), { retryDelays: [5, 5] })
  await assert.rejects(recovery.refresh(), /temporary failure/)
  await until(() => calls === 2)
  recovery.stop()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls, 2)
  assert.equal(states.at(-1), 'reconnecting')
})

test('foreground refresh runs immediately and replaces a pending retry', async () => {
  let calls = 0
  const recovery = new RuntimeRecovery(async () => {
    calls++
    if (calls === 1) throw new Error('temporarily offline')
  }, () => {}, { retryDelays: [80] })
  await assert.rejects(recovery.refresh(), /temporarily offline/)
  await recovery.refresh()
  assert.equal(calls, 2)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(calls, 2, 'the superseded retry must not fire later')
  recovery.stop()
})
