import type { CatalogEntry } from './contracts.ts'
import type { Verification } from './verification-store.ts'
import { jefCanUse } from './jef-model-policy.ts'

export function jefAvailability(entry: CatalogEntry, check: Verification | null, now = Date.now()): 'verified for Jef' | 'failed verification' | 'listed, untested' {
  if (!check || check.connectionRevision !== entry.route.connectionRevision ||
      now - Date.parse(check.checkedAt) >= 86_400_000 || now < Date.parse(check.checkedAt)) return 'listed, untested'
  return jefCanUse(check) ? 'verified for Jef' : 'failed verification'
}
