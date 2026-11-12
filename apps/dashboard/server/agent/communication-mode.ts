export type CommunicationMode = 'standard' | 'creator-direct'

export function normalizeCommunicationMode(value: unknown): CommunicationMode {
  return value === 'creator-direct' ? 'creator-direct' : 'standard'
}
