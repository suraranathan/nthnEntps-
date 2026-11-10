import { createHash } from 'node:crypto'
import type { CatalogEntry, CatalogQuery, ModelCatalog } from './contracts.ts'
import { ConnectionManager } from './connection-manager.ts'
import { CatalogStore } from './catalog-store.ts'
import type { RefreshStatus } from './catalog-store.ts'
import { initialDiscoveryQuery, parseDiscovery } from './discovery.ts'
import { ManagementError } from './management-types.ts'
import { modelRouteKey } from './route-identity.ts'
import { connectionAdapter } from './connection-adapters.ts'
import { catalogPricing } from './model-pricing.ts'

/** No inference/verification or agent routing: catalog observations only. */
export class CatalogService implements ModelCatalog {
  #manager: ConnectionManager
  #store: CatalogStore
  #interval: number
  constructor(manager: ConnectionManager, intervalMs = 300000) {
    if (!Number.isFinite(intervalMs) || intervalMs < 60000) throw new ManagementError('INVALID_INPUT')
    this.#manager = manager; this.#store = new CatalogStore(manager); this.#interval = intervalMs
  }
  close() { this.#store.close() }
  async search(query: CatalogQuery = {}) { return this.#store.search(query, this.#manager.list()) }
  async getRoute(routeId: string) { return this.#store.get(routeId, this.#manager.list()) }
  addManual(connectionId: string, nativeId: string, displayName: string) {
    const connection = this.#manager.get(connectionId)
    return this.#store.addManual(connection, nativeId, displayName)
  }
  statuses() { return this.#store.statuses() }
  async refresh(connectionId: string): Promise<RefreshStatus> {
    const connection = this.#manager.get(connectionId)
    if (!connection.enabled) throw new ManagementError('CONNECTION_DISABLED')
    const status = this.#store.begin(connection)
    let query = initialDiscoveryQuery(connection.providerId), errorCode: string | null = null
    let expectedTotal: number | null = null
    const visited = new Set<string>()
    try {
      while (true) {
        const signature = createHash('sha256').update(JSON.stringify(Object.entries(query).sort())).digest('hex')
        if (visited.has(signature)) throw new ManagementError('PAGINATION_INVALID')
        visited.add(signature)
        const response = await this.#manager.catalogPage(connection.id, connection.revision, query)
        const page = parseDiscovery(response.body, connection, query, response.link)
        if (page.declaredTotal !== null) expectedTotal = Math.max(expectedTotal ?? 0, page.declaredTotal)
        const entries = page.models.map(model => {
          const { nativeModelId, ...details } = model
          const ref = { connectionId: connection.id, nativeModelId, upstreamEndpointId: null }
          return {
            route: { id: modelRouteKey(ref), ref, providerId: connection.providerId, protocol: connectionAdapter(connection.providerId).protocol, connectionRevision: connection.revision,
              model: details, access: { state: page.visibility === 'account-filtered' ? 'account-listed' : 'listed', evidence: model.evidence }, lifecycle: model.extensions.deprecated === true || model.extensions.lifecycle === 'deprecated' ? 'deprecated' : 'active' },
            pricing: catalogPricing(model, connection.providerId),
            limits: [], firstSeenAt: model.evidence.observedAt, lastSeenAt: model.evidence.observedAt,
          } satisfies CatalogEntry
        })
        const added = this.#store.stage(status, entries, page.nextCursor)
        if (entries.length && page.nextQuery && added === 0) throw new ManagementError('PAGINATION_INVALID')
        if (!page.nextQuery) {
          if (expectedTotal !== null && status.modelsSeen < expectedTotal) throw new ManagementError('PAGINATION_INVALID')
          break
        }
        query = page.nextQuery
      }
      const current = this.#manager.get(connectionId)
      if (!current.enabled || current.revision !== connection.revision) throw new ManagementError('CONFLICT')
    } catch (error) { errorCode = error instanceof ManagementError ? error.code : 'REQUEST_FAILED' }
    try { this.#manager.recordDiscovery(connection.id, connection.revision, errorCode === null, errorCode ?? 'OK') }
    catch (error) { errorCode = error instanceof ManagementError ? error.code : 'STORE_FAILED' }
    return this.#store.finish(status, errorCode, this.#interval)
  }
  /** Automatic scan detects new/edited enabled connections; failures are independent. */
  async sync(force = false, now = Date.now()): Promise<(RefreshStatus | { connectionId: string; errorCode: string })[]> {
    const statuses = this.statuses()
    const queue = this.#manager.list().filter(c => {
      if (!c.enabled) return false
      const previous = statuses.find(status => status.connectionId === c.id)
      return force || !previous || previous.connectionRevision !== c.revision || (previous.state === 'running' ? previous.leaseExpiresAt <= now : previous.nextAttemptAt <= now)
    })
    const results: (RefreshStatus | { connectionId: string; errorCode: string })[] = []
    let index = 0
    const worker = async () => {
      while (index < queue.length) {
        const connection = queue[index++]
        try { results.push(await this.refresh(connection.id)) }
        catch (error) { results.push({ connectionId: connection.id, errorCode: error instanceof ManagementError ? error.code : 'STORE_FAILED' }) }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker))
    return results
  }
}
