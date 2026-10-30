import { InputError, textInput, categoryInput, validatePreferences } from './validation.ts'
export { InputError, validatePreferences } from './validation.ts'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { AlexSnapshot } from '../src/alex-contract.ts'
import { buildSystem, identity } from './identity.ts'
import { conversationContext, MemoryStore } from './memory.ts'
import { localClock, notificationDue } from './notifications.ts'
import { ModelRouter, ProviderError } from './providers.ts'
import { prepareRequest, UnavailableSophia } from './sophia.ts'

export class AlexRuntime {
  status: AlexSnapshot['status'] = 'offline'
  detail = 'No model connection verified. Configure a server provider and test the connection.'
  busy = false
  private lastAttempt = 0
  readonly sophia = new UnavailableSophia()
  readonly store: MemoryStore
  readonly router: ModelRouter
  readonly projectFile: string
  private changing = false
  constructor(store: MemoryStore, router: ModelRouter, projectFile: string) { this.store = store; this.router = router; this.projectFile = projectFile }
  snapshot(csrf = ''): AlexSnapshot {
    const provider = this.router.current()?.info
    return { identity, status: this.status, detail: this.detail, provider: provider?.id ?? null, model: provider?.model ?? null, providers: this.router.providers.map(x => x.info), preferences: this.store.state.preferences, memory: this.store.state.notes, messages: this.store.state.messages.slice(-200), requests: this.store.state.requests.slice(-50), events: this.store.state.events.slice(-30), audit: this.store.state.audit.slice(-20), csrf }
  }
  async initialize() {
    this.store.event('runtime_started', 'Alex local runtime started. Other employees remain placeholders; model connectivity has not yet been verified.')
    this.store.log('runtime.start', 'offline; awaiting real inference')
    await this.store.save()
  }
  private requireProvider() {
    const provider = this.router.current()
    if (!provider) throw new ProviderError('No model provider configured. Set server environment variables, then restart the agent server.', 503)
    return provider
  }
  async generate(kind: 'chat' | 'briefing' | 'update' | 'probe', text = '') {
    if (this.busy) throw new InputError('Alex is already thinking. Please wait.', 409)
    const provider = this.requireProvider()
    this.busy = true; this.status = 'thinking'; this.detail = 'Waiting for the configured model.'
    try {
      if (kind === 'probe') {
        const models = await provider.discover()
        this.store.log('provider.discovery', models === null ? 'not supported' : `${models.length} models advertised`)
      }
      const at = new Date().toISOString()
      if (kind === 'chat') {
        this.store.state.messages.push({ id: randomUUID(), role: 'user', content: text, createdAt: at, kind: 'chat' })
        await this.store.save()
      }
      let project = 'Project status document unavailable; do not infer project progress.'
      try { project = await readFile(this.projectFile, 'utf8') } catch { /* Explicit missing context above. */ }
      const system = buildSystem(this.store.state, { id: provider.info.id, model: provider.info.model }, project)
      const currentEvents = this.store.state.events.filter(x => !this.store.state.deliveredEvents.includes(x.id))
      const instruction = kind === 'probe' ? 'Briefly identify yourself and your actual current limitations. This is a user-requested real connection test.' : kind === 'briefing' ? 'Give today’s concise project briefing from the supplied document, explicit user-reported project notes, pending requests and verified events. Distinguish user reports from verified events. If there is no measured progress, say so. Do not treat sample UI activity as real.' : `Give one concise proactive update only about these real local events, clearly distinguishing queued requests from delivered work: ${JSON.stringify(currentEvents)}`
      const history = conversationContext(this.store.state.messages, text || instruction)
      const reply = await provider.complete([{ role: 'system', content: system }, ...history, ...(kind === 'chat' ? [] : [{ role: 'user' as const, content: instruction }])])
      this.store.state.messages.push({ id: randomUUID(), role: 'assistant', content: reply, createdAt: new Date().toISOString(), kind: kind === 'briefing' || kind === 'update' ? kind : 'chat', provider: provider.info.id, model: provider.info.model })
      if (kind === 'briefing' || kind === 'update') {
        this.store.state.lastNotification = Date.now()
        this.store.state.deliveredEvents = [...new Set([...this.store.state.deliveredEvents, ...currentEvents.map(x => x.id)])].slice(-500)
        if (kind === 'briefing') this.store.state.lastBriefingDay = localClock(new Date(), this.store.state.preferences.timezone).day
      }
      this.store.log(`model.${kind}`, `success via ${provider.info.id}`)
      await this.store.save()
      this.status = 'online'; this.detail = 'Last model request succeeded. No execution tools are enabled.'
    } catch (error) {
      this.status = 'error'
      this.detail = error instanceof ProviderError ? error.message : 'Agent request or persistent storage failed. No action was executed.'
      this.store.log(`model.${kind}`, error instanceof ProviderError ? error.code : 'internal or storage failure')
      await this.store.save().catch(() => {})
      throw error instanceof ProviderError ? error : new InputError(this.detail, 500)
    } finally { this.busy = false }
  }
  async action(input: unknown) {
    if (this.changing || this.busy) throw new InputError('Another agent request is in progress', 409)
    this.changing = true
    const action = input && typeof input === 'object' ? (input as Record<string, unknown>).action : ''
    const local = !['chat', 'probe', 'briefing'].includes(String(action))
    const previous = local ? structuredClone(this.store.state) : null
    const previousProvider = this.router.current()?.info.id
    const previousStatus = this.status, previousDetail = this.detail
    try { await this.performAction(input) }
    catch (error) {
      if (previous) {
        this.store.state = previous
        if (previousProvider) this.router.select(previousProvider)
        this.status = previousStatus; this.detail = previousDetail
      }
      throw error
    } finally { this.changing = false }
  }
  private async performAction(input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Invalid action')
    if (this.busy) throw new InputError('Alex is thinking. Please wait before changing settings.', 409)
    const a = input as Record<string, unknown>
    switch (a.action) {
      case 'chat': await this.generate('chat', textInput(a.text)); return
      case 'probe': await this.generate('probe'); return
      case 'briefing': await this.generate('briefing'); return
      case 'preferences': this.store.state.preferences = validatePreferences(a.value); break
      case 'remember': {
        const category = categoryInput(a.category)
        if (this.store.state.notes[category].length >= 30) throw new InputError('Memory category is full; remove a note first')
        this.store.state.notes[category].push({ id: randomUUID(), text: textInput(a.text, 1000), source: 'user', createdAt: new Date().toISOString() }); break
      }
      case 'forget': {
        const category = categoryInput(a.category), id = textInput(a.id, 100)
        this.store.state.notes[category] = this.store.state.notes[category].filter(x => x.id !== id); break
      }
      case 'provider': {
        const provider = this.router.select(textInput(a.id, 100))
        this.store.state.routing = provider.info.id
        this.status = 'offline'; this.detail = 'Provider changed. Connection is unverified until a real inference succeeds.'
        this.store.event('provider_selected', `Selected ${provider.info.id} / ${provider.info.model}; not yet verified online.`); break
      }
      case 'handoff': {
        if (a.approved !== true) throw new InputError('Explicit approval is required to queue the displayed request', 403)
        if (a.type !== 'request' && a.type !== 'clarification') throw new InputError('Invalid Sophia request type')
        if (this.store.state.requests.length >= 200) throw new InputError('Sophia queue is full')
        const request = prepareRequest(textInput(a.text), a.type, true)
        this.store.state.requests.push(request)
        this.store.event('sophia_request_queued', `User approved ${request.type} ${request.id} for future Sophia integration. It is awaiting an adapter and has NOT been delivered.`)
        break
      }
      default: throw new InputError('Unknown action; execution tools are unavailable', 404)
    }
    this.store.log(String(a.action), 'saved locally')
    await this.store.save()
  }
  async tick(now = new Date()) {
    if (this.busy || this.changing || !this.router.current() || now.getTime() - this.lastAttempt < 300000) return
    const kind = notificationDue(this.store.state, now)
    if (!kind) return
    this.lastAttempt = now.getTime()
    try { await this.generate(kind) } catch { /* Error and audit are observable; retry is bounded. */ }
  }
}
