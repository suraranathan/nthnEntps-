import { ConnectionManager } from './connection-manager.ts'
import { CatalogService } from './catalog-service.ts'
import { VerificationService } from './verification-service.ts'
import { AgentAssignments, alexRequirements } from './agent-assignments.ts'
import { availableProviders } from './connection-adapters.ts'
import { capabilityNames } from './verification-store.ts'
import type { Capability } from './verification-store.ts'
import { exactFields, ManagementError, objectInput } from './management-types.ts'
import type { CatalogQuery } from './contracts.ts'
import type { AiSnapshot, AssignmentView, ModelSearch } from '../../src/ai-contract.ts'
import { defaultEndpointRules } from './endpoint-policy.ts'

/** HTTP adapter only. Persistence, secrets, discovery and eligibility belong to existing services. */
export class AiManagementApi {
  readonly manager: ConnectionManager
  readonly catalog: CatalogService
  readonly verification: VerificationService
  readonly assignments: AgentAssignments
  readonly localPorts: readonly number[]
  constructor(manager: ConnectionManager, intervalMs = 300000, localPorts: readonly number[] = defaultEndpointRules.localPorts) {
    this.manager = manager; this.localPorts = localPorts
    this.catalog = new CatalogService(manager, intervalMs)
    try { this.verification = new VerificationService(manager, this.catalog) }
    catch (error) { this.catalog.close(); throw error }
    try { this.assignments = new AgentAssignments(manager, this.catalog) }
    catch (error) { this.verification.close(); this.catalog.close(); throw error }
  }
  close() { this.assignments.close(); this.verification.close(); this.catalog.close(); this.manager.close() }
  snapshot(csrf: string): AiSnapshot {
    const testResults: AiSnapshot['testResults'] = {}
    for (const row of this.manager.audit()) {
      if (row.action === 'test' && typeof row.connectionId === 'string' && typeof row.at === 'string' && typeof row.code === 'string' && !testResults[row.connectionId]) {
        testResults[row.connectionId] = { at: row.at, code: row.code, message: row.code === 'OK' ? 'Connection test passed.' : new ManagementError(row.code).message }
      }
    }
    return { csrf, providers: availableProviders(), connections: this.manager.list(), refreshes: this.catalog.statuses(), capabilities: capabilityNames, localPorts: this.localPorts, testResults }
  }
  async #testAfterChange(id: string, revision: number) {
    try { return (await this.manager.test(id, revision)).connection }
    catch { return this.manager.get(id) }
  }
  async action(input: unknown): Promise<unknown> {
    const data = objectInput(input)
    const fields: Record<string, string[]> = {
      'connection.add': ['connection', 'apiKey'], 'connection.edit': ['id', 'revision', 'patch'],
      'connection.credential': ['id', 'revision', 'apiKey'], 'connection.enable': ['id', 'revision', 'enabled'],
      'connection.remove': ['id', 'revision'], 'connection.test': ['id', 'revision'], 'catalog.refresh': ['id'],
      'catalog.search': ['query', 'agentId', 'requiredCapabilities'], 'model.verify': ['routeId', 'capabilities'],
      'assignment.get': ['agentId'], 'assignment.set': ['assignment', 'revision'], 'model.manual.add': ['connectionId', 'nativeModelId', 'displayName'],
    }
    if (typeof data.action !== 'string' || !Object.hasOwn(fields, data.action)) throw new ManagementError('INVALID_INPUT')
    exactFields(data, ['action', ...fields[data.action]])
    // Validate boundary primitives before calling services (which also validate metadata/revisions).
    for (const name of ['id', 'routeId']) if (fields[data.action].includes(name) && (typeof data[name] !== 'string' || !data[name] || data[name].length > 10000)) throw new ManagementError('INVALID_INPUT')
    if (fields[data.action].includes('revision') && (!Number.isSafeInteger(data.revision) || (data.revision as number) < 0)) throw new ManagementError('INVALID_INPUT')
    const id = data.id as string, revision = data.revision as number
    switch (data.action) {
      case 'connection.add': {
        const connection = this.manager.add(data.connection, data.apiKey ?? null)
        return this.#testAfterChange(connection.id, connection.revision)
      }
      case 'connection.edit': {
        const before = this.manager.get(id), connection = this.manager.edit(id, revision, data.patch)
        return before.baseUrl !== connection.baseUrl || before.networkPolicy !== connection.networkPolicy || before.authStyle !== connection.authStyle ? this.#testAfterChange(id, connection.revision) : connection
      }
      case 'connection.credential': {
        const connection = this.manager.setCredential(id, revision, data.apiKey)
        return this.#testAfterChange(id, connection.revision)
      }
      case 'connection.enable':
        if (typeof data.enabled !== 'boolean') throw new ManagementError('INVALID_INPUT')
        {
          const connection = this.manager.setEnabled(id, revision, data.enabled)
          return data.enabled ? this.#testAfterChange(id, connection.revision) : connection
        }
      case 'connection.remove': this.manager.remove(id, revision); return { removed: true }
      case 'connection.test': return this.manager.test(id, revision)
      case 'catalog.refresh': return this.catalog.refresh(id)
      case 'model.verify': return this.verification.verify(data.routeId as string, capabilities(data.capabilities))
      case 'model.manual.add':
        if (typeof data.connectionId !== 'string' || typeof data.nativeModelId !== 'string' || typeof data.displayName !== 'string') throw new ManagementError('INVALID_INPUT')
        return this.catalog.addManual(data.connectionId, data.nativeModelId, data.displayName)
      case 'catalog.search': {
        const agentId = agent(data.agentId)
        const required = [...new Set<Capability>(['text', ...(agentId === '01' ? alexRequirements : []), ...capabilities(data.requiredCapabilities)])]
        const page = await this.catalog.search(objectInput(data.query) as CatalogQuery)
        const eligibility: ModelSearch['eligibility'] = {}
        for (const entry of page.entries) {
          const { compatible, code } = await this.assignments.assess(entry.route.id, required)
          eligibility[entry.route.id] = { compatible, code }
        }
        return { page, eligibility } satisfies ModelSearch
      }
      case 'assignment.get': {
        const agentId = agent(data.agentId), assignment = this.assignments.get(agentId)
        if (!assignment) return { assignment: null, candidates: [] } satisfies AssignmentView
        const resolved = await this.assignments.resolve(agentId)
        return { assignment, candidates: resolved.candidates } satisfies AssignmentView
      }
      case 'assignment.set': return this.assignments.set(data.assignment, revision)
    }
  }
}
function capabilities(value: unknown): Capability[] {
  if (!Array.isArray(value) || value.some(c => !capabilityNames.includes(c))) throw new ManagementError('INVALID_INPUT')
  return value
}
function agent(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new ManagementError('INVALID_INPUT')
  return value
}
