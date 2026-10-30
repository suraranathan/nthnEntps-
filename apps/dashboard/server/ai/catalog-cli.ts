import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { ConnectionManager } from './connection-manager.ts'
import { CatalogService } from './catalog-service.ts'
import { endpointRulesFromEnv } from './endpoint-policy.ts'
import { ManagementError, objectInput } from './management-types.ts'
import type { CatalogQuery } from './contracts.ts'

let manager: ConnectionManager | undefined, catalog: CatalogService | undefined
try {
  const [command = 'help', ...args] = process.argv.slice(2)
  if (command === 'help' || command === '--help') {
    console.log(`Unified catalog (no inference or model-access verification)
  npm run catalog -- refresh [CONNECTION_ID]   refresh one or all enabled connections
  npm run catalog -- sync                      refresh new/changed/due connections once
  npm run catalog -- watch                     automatically discover new/changed/due connections
  npm run catalog -- search [JSON_QUERY]       cached search, pagination and filters
  npm run catalog -- get ROUTE_ID              get exact provider route
  npm run catalog -- status                    persisted refresh results/errors
Queries support search, connectionIds, providerIds, outputModality, pageSize and cursor.
Listings are never claimed to be verified inference access. Disabled connections are not contacted.`)
  } else {
    if (!['refresh', 'sync', 'watch', 'search', 'get', 'status'].includes(command) || args.length > (['get', 'search', 'refresh'].includes(command) ? 1 : 0) || (command === 'get' && args.length !== 1)) throw new ManagementError('INVALID_INPUT')
    const directory = resolve(fileURLToPath(new URL('../../', import.meta.url)), process.env.AI_PROVIDER_DATA_DIR || '.local/ai')
    const interval = Number(process.env.AI_CATALOG_REFRESH_MS || 300000)
    manager = new ConnectionManager(directory, { rules: endpointRulesFromEnv(process.env.AI_PROVIDER_LOCAL_PORTS) })
    catalog = new CatalogService(manager, interval)
    let result: unknown
    switch (command) {
      case 'search': {
        let query: CatalogQuery = {}
        if (args[0]) { try { query = objectInput(JSON.parse(args[0])) as CatalogQuery } catch { throw new ManagementError('INVALID_INPUT') } }
        result = await catalog.search(query); break
      }
      case 'get': result = await catalog.getRoute(args[0]); break
      case 'status': result = catalog.statuses(); break
      case 'refresh': result = args[0] ? await catalog.refresh(args[0]) : await catalog.sync(true); break
      case 'sync': result = await catalog.sync(); break
      case 'watch': {
        let stopped = false
        process.once('SIGTERM', () => { stopped = true }); process.once('SIGINT', () => { stopped = true })
        while (!stopped) {
          const updates = await catalog.sync()
          // Only generated IDs/stable codes/counts; never raw provider payloads/cursors.
          for (const status of updates) console.log(JSON.stringify({ connectionId: status.connectionId, ...('state' in status ? { state: status.state, errorCode: status.errorCode, modelsSeen: status.modelsSeen } : { errorCode: status.errorCode }) }))
          if (!stopped) await new Promise(resolve => setTimeout(resolve, 5000))
        }
        break
      }
    }
    if (result !== undefined) {
      console.log(JSON.stringify(result, null, 2))
      const statuses = Array.isArray(result) ? result : [result]
      if (['refresh', 'sync'].includes(command) && statuses.some(status => status.errorCode)) process.exitCode = 1
    }
  }
} catch (error) {
  const failure = error instanceof ManagementError ? error : new ManagementError('STORE_FAILED')
  console.error(JSON.stringify({ code: failure.code, error: failure.message })); process.exitCode = 1
} finally { catalog?.close(); manager?.close() }
