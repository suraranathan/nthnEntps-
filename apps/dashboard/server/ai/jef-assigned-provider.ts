import type { MemoryStore } from '../memory.ts'
import { ProviderError, type ModelMessage, type ModelProvider } from '../providers.ts'
import type { ProviderInfo } from '../../src/jef-contract.ts'
import { AgentAssignments } from './agent-assignments.ts'
import { CatalogService } from './catalog-service.ts'
import { ConnectionManager } from './connection-manager.ts'
import { ManagementError } from './management-types.ts'
import { VerificationService } from './verification-service.ts'
import type { ModelRoute } from './contracts.ts'
import { connectionAdapter } from './connection-adapters.ts'

// Three consecutive requests above this threshold establish consistent slowness.
export const SLOW_REQUEST_MS = 12000
export const SLOW_STREAK = 3
export const nextSlowStreak = (previous: number, elapsedMs: number) => elapsedMs >= SLOW_REQUEST_MS ? previous + 1 : 0
export const nearAllowance = (limit: number, remaining: number) => Number.isFinite(limit) && Number.isFinite(remaining) && limit > 0 && remaining >= 0 && remaining / limit <= 0.1

/** Uses the saved exact route and encrypted connection via the protected Phase 2 transport. */
export class JefAssignedProvider implements ModelProvider {
  readonly info: ProviderInfo
  #manager: ConnectionManager
  #catalog: CatalogService
  #assignments: AgentAssignments
  #verification: VerificationService
  #store: MemoryStore
  #clock: () => number
  #routeId: string | null = null
  #pendingReason: 'slow' | 'rate-limit' | 'allowance' | null = null
  #slow = 0
  #unavailable = ''
  constructor(manager: ConnectionManager, catalog: CatalogService, assignments: AgentAssignments, verification: VerificationService, store: MemoryStore, clock: () => number = () => performance.now()) {
    this.#manager = manager; this.#catalog = catalog; this.#assignments = assignments; this.#verification = verification; this.#store = store
    this.#clock = clock
    this.info = { id: 'assigned-openrouter', model: '', configured: true, capabilities: { text: true, tools: false, streaming: false, images: false, discovery: true } }
  }
  async #candidate(id: string, requirements: readonly import('./verification-store.ts').Capability[]) {
    let candidate = await this.#assignments.assess(id, requirements)
    if (candidate.compatible) return candidate.route
    // Only saved fallbacks can be explored. Discovery is refreshed when stale;
    // verification is explicit here because switching may incur provider charges.
    const route = candidate.route
    if (!route) return null
    try {
      if (['CATALOG_STALE', 'CATALOG_REFRESH_FAILED'].includes(candidate.code)) await this.#catalog.refresh(route.ref.connectionId)
      candidate = await this.#assignments.assess(id, requirements)
      if (['UNVERIFIED', 'VERIFICATION_EXPIRED', 'CAPABILITY_UNTESTED_OR_UNSUPPORTED'].includes(candidate.code)) {
        const checked = await this.#verification.verify(id, requirements)
        if (checked.state !== 'verified') return null
      }
      candidate = await this.#assignments.assess(id, requirements)
      return candidate.compatible ? candidate.route : null
    } catch { return null }
  }
  /** Called before Jef builds the system prompt, so model metadata matches the request. */
  async prepare() {
    const assignment = this.#assignments.get('01')
    if (!assignment) throw new ProviderError('No saved Jef model assignment. Choose a verified primary model in AI Providers.', 503)
    const primary = assignment.candidateRouteIds[0]
    if (!this.#routeId || !assignment.candidateRouteIds.includes(this.#routeId)) { this.#routeId = primary; this.#pendingReason = null; this.#slow = 0 }
    if (this.#pendingReason) {
      const reason = this.#pendingReason
      const position = assignment.candidateRouteIds.indexOf(this.#routeId)
      let replacement: ModelRoute | null = null
      for (const id of assignment.candidateRouteIds.slice(position + 1)) {
        replacement = await this.#candidate(id, assignment.requiredCapabilities)
        if (replacement) break
      }
      this.#pendingReason = null
      if (replacement) {
        this.#routeId = replacement.id; this.#slow = 0; this.#unavailable = ''
        const cause = reason === 'slow' ? `three consecutive responses exceeded ${SLOW_REQUEST_MS / 1000} seconds` : reason === 'allowance' ? 'the API key allowance fell below 10%' : 'the provider rate limit was reached'
        this.#store.event('jef_model_switched', `Jef switched to ${replacement.providerId} / ${replacement.ref.nativeModelId} because ${cause}. Conversation and memory are retained.`)
        await this.#store.save()
      } else {
        this.#pendingReason = reason
        this.#unavailable = reason === 'slow' ? 'Jef is consistently slow; no saved verified compatible fallback is available.' : reason === 'allowance' ? 'Provider key allowance is near its limit; no saved verified compatible fallback is available.' : 'Provider rate limit reached; no saved verified compatible fallback is available.'
      }
    }
    const assessment = await this.#assignments.assess(this.#routeId, assignment.requiredCapabilities)
    if (!assessment.compatible || !assessment.route) throw new ProviderError(`Assigned model is unavailable (${assessment.code}). Verify a compatible saved model in AI Providers.`, 503)
    this.info.model = assessment.route.ref.nativeModelId
    if (this.#unavailable) throw new ProviderError(this.#unavailable, 503)
  }
  async complete(messages: ModelMessage[]) {
    const assignment = this.#assignments.get('01')
    if (!assignment || !this.#routeId) throw new ProviderError('No verified Jef assignment is ready.', 503)
    const checked = await this.#assignments.assess(this.#routeId, assignment.requiredCapabilities)
    if (!checked.compatible || !checked.route) throw new ProviderError(`Assigned model is unavailable (${checked.code}).`, 503)
    const route = checked.route
    const protocol = connectionAdapter(route.providerId).protocol
    const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n')
    const turns = messages.filter(message => message.role !== 'system')
    const body: Record<string, unknown> = protocol === 'ollama-chat'
      ? { model: route.ref.nativeModelId, messages, stream: false, options: { num_predict: 1600 } }
      : protocol === 'anthropic-messages'
        ? { model: route.ref.nativeModelId, messages: turns, system, max_tokens: 1600 }
        : protocol === 'gemini-generate-content'
          ? { model: route.ref.nativeModelId, contents: turns.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })), systemInstruction: { parts: [{ text: system }] }, generationConfig: { maxOutputTokens: 1600 } }
          : { model: route.ref.nativeModelId, messages, stream: false, ...(route.providerId === 'openrouter' ? { max_tokens: 1600, provider: { require_parameters: true } } : route.providerId === 'openai' ? { max_completion_tokens: 1600 } : { max_tokens: 1600 }) }
    const started = this.#clock()
    try {
      const data = await this.#manager.inferenceProbe(route.ref.connectionId, route.connectionRevision, body)
      const response = data as { choices?: { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: string }[]; message?: { content?: unknown; tool_calls?: unknown }; done_reason?: string; content?: { type?: string; text?: string }[]; stop_reason?: string; candidates?: { content?: { parts?: { text?: string; functionCall?: unknown }[] }; finishReason?: string }[] }
      const choice = response?.choices?.[0]
      if (choice?.message?.tool_calls || response?.message?.tool_calls || response?.content?.some(part => part.type === 'tool_use') || response?.candidates?.[0]?.content?.parts?.some(part => part.functionCall)) throw new ProviderError('Model requested unsupported tools; no tool was executed.')
      if (choice?.finish_reason === 'length' || response?.done_reason === 'length' || response?.stop_reason === 'max_tokens' || response?.candidates?.[0]?.finishReason === 'MAX_TOKENS') throw new ProviderError('Model response was truncated; try a shorter request.')
      const text = protocol === 'ollama-chat' ? response?.message?.content : protocol === 'anthropic-messages' ? response?.content?.filter(part => part.type === 'text').map(part => part.text ?? '').join('') : protocol === 'gemini-generate-content' ? response?.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('') : choice?.message?.content
      if (typeof text !== 'string' || !text.trim()) throw new ProviderError('Provider returned no usable text.')
      this.#slow = nextSlowStreak(this.#slow, this.#clock() - started)
      if (this.#slow >= SLOW_STREAK) this.#pendingReason = 'slow'
      if (!this.#pendingReason) {
        const allowance = await this.#manager.keyAllowance(route.ref.connectionId, route.connectionRevision).catch(() => null)
        if (allowance && nearAllowance(allowance.limit, allowance.remaining)) this.#pendingReason = 'allowance'
      }
      return text.trim().slice(0, 16000)
    } catch (error) {
      if (error instanceof ManagementError && error.code === 'RATE_LIMITED') this.#pendingReason = 'rate-limit'
      throw error instanceof ProviderError ? error : new ProviderError(error instanceof ManagementError ? error.message : 'Assigned model request failed.')
    }
  }
  async discover() {
    const assignment = this.#assignments.get('01')
    if (!assignment) return null
    return (await Promise.all(assignment.candidateRouteIds.map(id => this.#catalog.getRoute(id)))).flatMap(entry => entry ? [entry.route.ref.nativeModelId] : [])
  }
}
