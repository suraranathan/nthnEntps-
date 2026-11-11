import { randomUUID } from 'node:crypto'
import type { TeamRequest } from '../src/jef-contract.ts'
export type SophiaUpdate = { requestId: string; state: 'submitted' | 'in_progress' | 'completed' | 'failed'; text: string; source: 'sophia' }
export interface SophiaAdapter {
  readonly available: boolean
  submit(request: TeamRequest): Promise<void>
  updates(): Promise<SophiaUpdate[]>
}
export class UnavailableSophia implements SophiaAdapter {
  readonly available = false
  async submit(_request: TeamRequest): Promise<void> { throw new Error('Sophia is not connected') }
  async updates(): Promise<SophiaUpdate[]> { return [] }
}
export function prepareRequest(text: string, type: TeamRequest['type'], approved: boolean): TeamRequest {
  if (!approved) throw new Error('Explicit approval is required to queue this exact request')
  return { id: randomUUID(), target: 'sophia', type, text, state: 'awaiting_adapter', createdAt: new Date().toISOString(), updates: [] }
}

// Only trusted server adapters may supply updates; browser chat never calls this.
export function applySophiaUpdate(requests: TeamRequest[], update: SophiaUpdate) {
  if (update.source !== 'sophia' || !['submitted', 'in_progress', 'completed', 'failed'].includes(update.state) || typeof update.text !== 'string' || !update.text.trim() || update.text.length > 8000) throw new Error('Invalid Sophia update')
  const request = requests.find(x => x.id === update.requestId)
  if (!request) throw new Error('Unknown Sophia correlation ID')
  if (request.state === 'awaiting_adapter') throw new Error('An undelivered request cannot receive progress updates')
  if (['completed', 'failed'].includes(request.state)) throw new Error('Request is already terminal')
  if (request.state === 'in_progress' && update.state === 'submitted') throw new Error('Task state cannot move backwards')
  request.state = update.state
  request.updates.push({ text: update.text, at: new Date().toISOString() })
  return request
}
