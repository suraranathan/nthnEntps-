import { randomUUID } from 'node:crypto'
import { CatalogService } from './catalog-service.ts'
import { ConnectionManager } from './connection-manager.ts'
import { ManagementError } from './management-types.ts'
import { buildProbe, validateProbe } from './verification-probes.ts'
import { capabilityNames, VerificationStore } from './verification-store.ts'
import type { Capability, CapabilityResult, Verification } from './verification-store.ts'

export class VerificationService {
  readonly store: VerificationStore
  #manager: ConnectionManager
  #catalog: CatalogService
  #busy = new Set<string>()
  constructor(manager: ConnectionManager, catalog: CatalogService) { this.#manager = manager; this.#catalog = catalog; this.store = new VerificationStore(manager) }
  close() { this.store.close() }
  /** Explicit only: at most five bounded requests. Discovery never calls this method. */
  async verify(routeId: string, requested: readonly Capability[] = capabilityNames): Promise<Verification> {
    if (!Array.isArray(requested) || requested.some(c => !capabilityNames.includes(c))) throw new ManagementError('INVALID_INPUT')
    if (this.#busy.has(routeId)) throw new ManagementError('TEST_BUSY')
    const entry = await this.#catalog.getRoute(routeId)
    if (!entry) throw new ManagementError('NOT_FOUND')
    if (this.#busy.has(routeId)) throw new ManagementError('TEST_BUSY')
    const route = entry.route, c = this.#manager.get(route.ref.connectionId)
    const result: Verification = { id: randomUUID(), routeId, providerId: c.providerId, connectionId: c.id, account: c.scope, connectionRevision: c.revision, nativeModelId: route.ref.nativeModelId, checkedAt: new Date().toISOString(), state: 'untested', code: null,
      capabilities: Object.fromEntries(capabilityNames.map(name => [name, { state: 'untested', checkedAt: null, code: null }])) as Record<Capability, CapabilityResult> }
    this.#busy.add(routeId)
    try {
      if (!c.enabled) throw new ManagementError('CONNECTION_DISABLED')
      if (route.connectionRevision !== c.revision) throw new ManagementError('CONFLICT')
      if (route.lifecycle === 'removed') throw new ManagementError('MODEL_UNAVAILABLE')
      if (route.ref.upstreamEndpointId !== null || !['openai-chat', 'ollama-chat'].includes(route.protocol)) throw new ManagementError('INCOMPATIBLE')
      for (const capability of [...new Set<Capability>(['text', ...requested])]) {
        const observation = result.capabilities[capability]
        try {
          const { body, token } = buildProbe(c.providerId, result.nativeModelId, capability)
          const response = await this.#manager.inferenceProbe(c.id, c.revision, body, capability === 'streaming')
          validateProbe(response, c.providerId, capability, token)
          observation.state = 'supported'
        } catch (error) {
          observation.code = error instanceof ManagementError ? error.code : 'INVALID_RESPONSE'
          if (observation.code === 'CAPABILITY_UNSUPPORTED') observation.state = 'unsupported'
          if (capability === 'text') throw new ManagementError(observation.code)
          // Account/network failures stop further probes and invalidate current availability.
          if (!['INCOMPATIBLE', 'INVALID_RESPONSE', 'CAPABILITY_UNSUPPORTED'].includes(observation.code)) throw new ManagementError(observation.code)
        } finally { observation.checkedAt = new Date().toISOString() }
      }
      result.state = 'verified'
    } catch (error) {
      result.code = error instanceof ManagementError ? error.code : 'REQUEST_FAILED'
      result.state = result.code === 'CREDENTIAL_REQUIRED' ? 'untested' : ['INCOMPATIBLE', 'INVALID_RESPONSE', 'CAPABILITY_UNSUPPORTED'].includes(result.code) ? 'incompatible' : 'unavailable'
    } finally { this.#busy.delete(routeId) }
    const current = this.#manager.list().find(item => item.id === c.id)
    if (!current || current.revision !== c.revision || !current.enabled) { result.state = 'unavailable'; result.code = !current ? 'MODEL_UNAVAILABLE' : current.enabled ? 'CONFLICT' : 'CONNECTION_DISABLED' }
    result.checkedAt = new Date().toISOString()
    // History remains attributable to the revision actually tested; stale results cannot qualify assignments.
    this.store.save(result)
    if (current?.revision === c.revision && result.capabilities.text.checkedAt) this.#manager.recordInference(c.id, c.revision, result.state === 'verified', result.code ?? 'OK')
    return result
  }
}
