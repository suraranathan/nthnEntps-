import type { Capability, Verification } from './verification-store.ts'
import { connectionAdapter } from './connection-adapters.ts'

/** A Jef route must support the actual streaming, instruction and tool request shape. */
export const jefProbeCapabilities: readonly Capability[] = ['text', 'tools', 'streaming', 'systemInstructions']

export function jefCanUse(result: Verification): boolean {
  return result.state === 'verified' && jefProbeCapabilities.every(capability => result.capabilities[capability]?.state === 'supported')
}

export function jefTransportSupportsTools(providerId: string): boolean {
  return ['openai-chat', 'anthropic-messages', 'gemini-generate-content', 'ollama-chat'].includes(connectionAdapter(providerId).protocol)
}
