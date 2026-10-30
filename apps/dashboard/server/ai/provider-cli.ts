import { fileURLToPath } from 'node:url'
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { endpointRulesFromEnv } from './endpoint-policy.ts'
import { ConnectionManager } from './connection-manager.ts'
import { availableProviders } from './connection-adapters.ts'
import { ManagementError, objectInput, exactFields } from './management-types.ts'

const help = `Provider connection management (backend only)
  npm run providers -- providers | list | audit
  npm run providers -- get ID
  npm run providers -- add < private-request.json
    JSON: {"connection":{"providerId":"openrouter","label":"Account","baseUrl":"https://openrouter.ai/api/v1"},"apiKey":"..."}
  npm run providers -- edit ID REVISION < private-metadata.json
  npm run providers -- credential ID REVISION < private-credential.json
    JSON: {"apiKey":"..."} or {"apiKey":null} to clear
  npm run providers -- enable | disable | test | remove ID REVISION
Keys must be supplied through redirected private stdin, never arguments or a browser.
Connections default to disabled; test is an explicit read-only provider API request.
No model inference, download, catalog refresh or Alex routing is performed.`
async function input() {
  if (process.stdin.isTTY) throw new ManagementError('INVALID_INPUT')
  let bytes = 0; const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > 16000) throw new ManagementError('INVALID_INPUT')
    chunks.push(Buffer.from(chunk))
  }
  try { return objectInput(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { throw new ManagementError('INVALID_INPUT') }
}
let manager: ConnectionManager | undefined
try {
  const [command = 'help', id, revision, ...extra] = process.argv.slice(2)
  const count = process.argv.slice(2).length
  if (['help', '--help'].includes(command)) console.log(help)
  else if (command === 'providers' && count === 1) console.log(JSON.stringify(availableProviders(), null, 2))
  else {
    if (extra.length || !['list', 'audit', 'get', 'add', 'edit', 'credential', 'enable', 'disable', 'test', 'remove'].includes(command)) throw new ManagementError('INVALID_INPUT')
    const expected = ['list', 'audit', 'add'].includes(command) ? 1 : command === 'get' ? 2 : 3
    if (count !== expected) throw new ManagementError('INVALID_INPUT')
    const appRoot = fileURLToPath(new URL('../../', import.meta.url))
    const dataDirectory = resolve(appRoot, process.env.AI_PROVIDER_DATA_DIR || '.local/ai')
    const projectRoot = resolve(appRoot, '../..'), inProject = relative(projectRoot, dataDirectory)
    const privateRoot = resolve(appRoot, '.local')
    if (!inProject.startsWith(`..${sep}`) && inProject !== '..' && !isAbsolute(inProject) && dataDirectory !== privateRoot && !dataDirectory.startsWith(privateRoot + sep)) throw new ManagementError('STORE_FAILED')
    manager = new ConnectionManager(dataDirectory, { rules: endpointRulesFromEnv(process.env.AI_PROVIDER_LOCAL_PORTS) })
    let result: unknown
    switch (command) {
      case 'list': result = manager.list(); break
      case 'audit': result = manager.audit(); break
      case 'get': result = manager.get(id); break
      case 'add': {
        const body = await input(); exactFields(body, ['connection', 'apiKey'])
        result = manager.add(body.connection, body.apiKey ?? null); break
      }
      case 'edit': result = manager.edit(id, Number(revision), await input()); break
      case 'credential': {
        const body = await input(); exactFields(body, ['apiKey'])
        result = manager.setCredential(id, Number(revision), body.apiKey); break
      }
      case 'enable': case 'disable': result = manager.setEnabled(id, Number(revision), command === 'enable'); break
      case 'test': {
        const test = await manager.test(id, Number(revision)); result = test
        if (!test.ok) process.exitCode = 1
        break
      }
      case 'remove': manager.remove(id, Number(revision)); result = { removed: true, id }; break
    }
    console.log(JSON.stringify(result, null, 2))
  }
} catch (error) {
  const failure = error instanceof ManagementError ? error : new ManagementError('STORE_FAILED')
  console.error(JSON.stringify({ code: failure.code, error: failure.message }))
  process.exitCode = 1
} finally { manager?.close() }
