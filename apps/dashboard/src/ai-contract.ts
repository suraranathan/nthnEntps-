/** Browser transport types reuse the Phase 2 services; all imports are erased. */
import type { CatalogPage, CatalogQuery, ModelRoute, ProviderDefinition } from '../server/ai/contracts.ts'
import type { ConnectionInput, ConnectionPatch, ManagedConnection } from '../server/ai/management-types.ts'
import type { RefreshStatus } from '../server/ai/catalog-store.ts'
import type { Capability } from '../server/ai/verification-store.ts'
import type { CompatibleAssignment } from '../server/ai/agent-assignments.ts'

export type { ManagedConnection, Capability, CompatibleAssignment }
export interface AiSnapshot {
  csrf: string
  providers: ProviderDefinition[]
  connections: ManagedConnection[]
  refreshes: RefreshStatus[]
  capabilities: readonly Capability[]
  localPorts: readonly number[]
  testResults: Record<string, { at: string; code: string; message: string }>
}
export interface Eligibility { compatible: boolean; code: string }
export interface ModelSearch {
  page: CatalogPage
  eligibility: Record<string, Eligibility>
}
export interface AssignmentView {
  assignment: CompatibleAssignment | null
  candidates: { routeId: string; route: ModelRoute | null; compatible: boolean; code: string }[]
}
export type AiAction =
  | { action: 'connection.add'; connection: ConnectionInput; apiKey?: string }
  | { action: 'connection.edit'; id: string; revision: number; patch: ConnectionPatch }
  | { action: 'connection.credential'; id: string; revision: number; apiKey: string | null }
  | { action: 'connection.enable'; id: string; revision: number; enabled: boolean }
  | { action: 'connection.remove' | 'connection.test'; id: string; revision: number }
  | { action: 'catalog.refresh'; id: string }
  | { action: 'catalog.search'; query: CatalogQuery; agentId: string; requiredCapabilities: Capability[] }
  | { action: 'model.verify'; routeId: string; capabilities: Capability[] }
  | { action: 'assignment.get'; agentId: string }
  | { action: 'assignment.set'; assignment: Omit<CompatibleAssignment, 'revision'>; revision: number }
