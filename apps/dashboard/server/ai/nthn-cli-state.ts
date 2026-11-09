import type { CatalogEntry } from './contracts.ts'
import type { ManagedConnection } from './management-types.ts'

export type SavedSelection = { routeId: string; modelId: string | null; connectionId?: string }

export function openRouterAccounts(connections: ManagedConnection[]): ManagedConnection[] {
  return connections.filter(connection => connection.providerId === 'openrouter')
}

export function connectionSummary(connection: ManagedConnection | undefined): string {
  if (!connection || connection.credentials.state === 'missing') return 'Not connected'
  if (!connection.enabled) return 'disabled'
  if (connection.health.authentication === 'rejected') return 'AUTH_REJECTED'
  return 'connected'
}

export function selectionIsCurrent(selection: SavedSelection | null, entry: CatalogEntry | null, connection: ManagedConnection): boolean {
  return Boolean(selection && entry
    && entry.route.id === selection.routeId
    && entry.route.ref.connectionId === connection.id
    && entry.route.connectionRevision === connection.revision
    && entry.route.lifecycle === 'active')
}

export function selectionConnection(selection: SavedSelection | null, entry: CatalogEntry | null, connections: ManagedConnection[]): ManagedConnection | undefined {
  if (!selection || !entry) return undefined
  const connection = connections.find(item => item.id === entry.route.ref.connectionId)
  return connection && selectionIsCurrent(selection, entry, connection) ? connection : undefined
}
