import type { DatabaseSync } from 'node:sqlite'
import type { ProviderConnection } from './contracts.ts'
import { ManagementError } from './management-types.ts'
import type { ConnectionManager } from './connection-manager.ts'

export const capabilityNames = ['text', 'streaming', 'tools', 'structuredOutput', 'systemInstructions'] as const
export type Capability = typeof capabilityNames[number]
export type CapabilityResult = { state: 'supported' | 'unsupported' | 'untested'; checkedAt: string | null; code: string | null }
export interface Verification {
  id: string
  routeId: string
  providerId: string
  connectionId: string
  account: ProviderConnection['scope']
  connectionRevision: number
  nativeModelId: string
  checkedAt: string
  state: 'verified' | 'unavailable' | 'untested' | 'incompatible'
  code: string | null
  capabilities: Record<Capability, CapabilityResult>
}
export function initializeVerification(db: DatabaseSync) {
  if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version > 1) throw new ManagementError('STORE_FAILED')
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS model_verifications (sequence INTEGER PRIMARY KEY, route_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS verification_route ON model_verifications(route_id, sequence);
    CREATE TABLE IF NOT EXISTS agent_assignments (agent_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);`)
}
export function latestVerification(db: DatabaseSync, routeId: string): Verification | null {
  const row = db.prepare('SELECT data FROM model_verifications WHERE route_id=? ORDER BY sequence DESC LIMIT 1').get(routeId) as { data: string } | undefined
  return row ? JSON.parse(row.data) : null
}
export class VerificationStore {
  readonly db: DatabaseSync
  constructor(manager: ConnectionManager) { this.db = manager.openCatalogDatabase(); try { initializeVerification(this.db) } catch (error) { this.db.close(); throw error } }
  close() { this.db.close() }
  save(result: Verification) { this.db.prepare('INSERT INTO model_verifications(route_id, data) VALUES (?, ?)').run(result.routeId, JSON.stringify(result)) }
  latest(routeId: string) { return latestVerification(this.db, routeId) }
  history(routeId: string): Verification[] { return (this.db.prepare('SELECT data FROM model_verifications WHERE route_id=? ORDER BY sequence DESC').all(routeId) as { data: string }[]).map(row => JSON.parse(row.data)) }
}
