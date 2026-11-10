/** Local format hints only. Never test a key against a provider without confirmation. */
export function providerKeyHint(key: string): string | null {
  if (key.startsWith('sk-or-')) return 'openrouter'
  if (key.startsWith('sk-ant-')) return 'anthropic'
  if (key.startsWith('AIza')) return 'gemini'
  if (key.startsWith('sk-proj-') || key.startsWith('sk-svcacct-')) return 'openai'
  if (key.startsWith('gsk_')) return 'groq'
  return null
}
