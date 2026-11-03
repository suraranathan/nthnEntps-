import type { ModelRoute } from './contracts.ts'
import { CatalogService } from './catalog-service.ts'
import { ConnectionManager } from './connection-manager.ts'
import { exactFields, ManagementError, objectInput } from './management-types.ts'
import { capabilityNames, VerificationStore } from './verification-store.ts'
import type { Capability } from './verification-store.ts'

export interface CompatibleAssignment {
  agentId: string
  revision: number
  candidateRouteIds: string[] // ordered, explicit primary plus fallback candidates
  requiredCapabilities: Capability[]
}
export const alexRequirements: readonly Capability[] = Object.freeze(['text', 'systemInstructions'])
/** Stores only model references/requirements. Identity, instructions and memory remain with each agent. */
export class AgentAssignments {
  #store: VerificationStore
  #manager: ConnectionManager
  #catalog: CatalogService
  constructor(manager: ConnectionManager, catalog: CatalogService) { this.#store = new VerificationStore(manager); this.#manager = manager; this.#catalog = catalog }
  close() { this.#store.close() }
  get(agentId: string): CompatibleAssignment | null {
    const row = this.#store.db.prepare('SELECT data FROM agent_assignments WHERE agent_id=?').get(agentId) as { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }
  async assess(routeId: string, requirements: readonly Capability[], maxAgeMs = 86400000): Promise<{ compatible: boolean; code: string; route: ModelRoute | null }> {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || requirements.some(c => !capabilityNames.includes(c))) throw new ManagementError('INVALID_INPUT')
    const entry = await this.#catalog.getRoute(routeId)
    if (!entry) return { compatible: false, code: 'NOT_FOUND', route: null }
    const route = entry.route, c = this.#manager.list().find(c => c.id === route.ref.connectionId), v = this.#store.latest(routeId)
    let code = 'OK'
    if (!c || route.lifecycle === 'removed') code = 'MODEL_UNAVAILABLE'
    else if (!c.enabled) code = 'CONNECTION_DISABLED'
    else if (route.connectionRevision !== c.revision) code = 'CATALOG_STALE'
    else if (route.model.evidence.source !== 'operator' && this.#catalog.statuses().some(s => s.connectionId === c.id && s.errorCode)) code = 'CATALOG_REFRESH_FAILED'
    else if (!v || v.connectionRevision !== c.revision) code = 'UNVERIFIED'
    else if (v.state !== 'verified') code = v.code ?? 'UNVERIFIED'
    else if (route.access.state !== 'verified') code = 'MODEL_UNAVAILABLE'
    else if (!Number.isFinite(Date.parse(v.checkedAt)) || Date.now() - Date.parse(v.checkedAt) > maxAgeMs || Date.parse(v.checkedAt) > Date.now()) code = 'VERIFICATION_EXPIRED'
    else if (['text', ...requirements].some(name => v.capabilities[name as Capability]?.state !== 'supported')) code = 'CAPABILITY_UNTESTED_OR_UNSUPPORTED'
    return { compatible: code === 'OK', code, route }
  }
  async set(input: unknown, expectedRevision: number): Promise<CompatibleAssignment> {
    const data = objectInput(input); exactFields(data, ['agentId', 'candidateRouteIds', 'requiredCapabilities'])
    if (typeof data.agentId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.agentId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Array.isArray(data.candidateRouteIds) || !data.candidateRouteIds.length || data.candidateRouteIds.some(id => typeof id !== 'string') || new Set(data.candidateRouteIds).size !== data.candidateRouteIds.length) throw new ManagementError('INVALID_INPUT')
    const requirements = data.requiredCapabilities ?? (data.agentId === '01' ? alexRequirements : ['text'])
    if (!Array.isArray(requirements) || requirements.some(c => !capabilityNames.includes(c))) throw new ManagementError('INVALID_INPUT')
    const assignment: CompatibleAssignment = { agentId: data.agentId, revision: expectedRevision + 1, candidateRouteIds: data.candidateRouteIds, requiredCapabilities: [...new Set<Capability>(['text', ...(data.agentId === '01' ? alexRequirements : []), ...requirements])] }
    for (const id of assignment.candidateRouteIds) if (!(await this.assess(id, assignment.requiredCapabilities)).compatible) throw new ManagementError('NO_COMPATIBLE_MODEL')
    const db = this.#store.db
    db.exec('BEGIN IMMEDIATE')
    try {
      if ((this.get(assignment.agentId)?.revision ?? 0) !== expectedRevision) throw new ManagementError('CONFLICT')
      db.prepare('INSERT INTO agent_assignments VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET revision=excluded.revision, data=excluded.data').run(assignment.agentId, assignment.revision, JSON.stringify(assignment))
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    return assignment
  }
  /** Returns currently eligible candidates; caller explicitly chooses whether to try a fallback. No inference here. */
  async resolve(agentId: string) {
    const assignment = this.get(agentId)
    if (!assignment) throw new ManagementError('NOT_FOUND')
    const candidates = []
    for (const routeId of assignment.candidateRouteIds) candidates.push({ routeId, ...await this.assess(routeId, assignment.requiredCapabilities) })
    const compatible = candidates.filter(c => c.compatible)
    return { assignment, primary: compatible[0]?.route ?? null, fallbacks: compatible.slice(1).map(c => c.route!), candidates }
  }
}
