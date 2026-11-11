import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { ConnectionManager } from './connection-manager.ts'
import { CatalogService } from './catalog-service.ts'
import { VerificationService } from './verification-service.ts'
import { AgentAssignments } from './agent-assignments.ts'
import { endpointRulesFromEnv } from './endpoint-policy.ts'
import { ManagementError } from './management-types.ts'
import type { Capability } from './verification-store.ts'

let manager: ConnectionManager | undefined, catalog: CatalogService | undefined, verification: VerificationService | undefined, assignments: AgentAssignments | undefined
try {
  const [command = 'help', ...args] = process.argv.slice(2)
  if (command === 'help' || command === '--help') console.log(`Explicit access verification and compatible assignments (backend only)
  npm run models -- verify ROUTE_ID [text,streaming,tools,structuredOutput,systemInstructions]
  npm run models -- history ROUTE_ID
  npm run models -- assign EXPECTED_REVISION JSON_ASSIGNMENT
  npm run models -- assignment AGENT_ID
  npm run models -- resolve AGENT_ID
Verification defaults to all five probes and may incur provider charges. Missing public credentials are recorded untested.
JSON_ASSIGNMENT: {"agentId":"01","candidateRouteIds":["route ID"],"requiredCapabilities":["text","systemInstructions"]}
Revision 0 creates an assignment. Jef (01) always requires text and systemInstructions.
Assignments do not activate or replace Jef's current environment-based transport. No Nexus.`)
  else {
    if (!['verify', 'history', 'assign', 'assignment', 'resolve'].includes(command) || args.length < 1 || args.length > (['verify', 'assign'].includes(command) ? 2 : 1) || (command === 'assign' && args.length !== 2)) throw new ManagementError('INVALID_INPUT')
    const directory = resolve(fileURLToPath(new URL('../../', import.meta.url)), process.env.AI_PROVIDER_DATA_DIR || '.local/ai')
    manager = new ConnectionManager(directory, { rules: endpointRulesFromEnv(process.env.AI_PROVIDER_LOCAL_PORTS) }); catalog = new CatalogService(manager)
    verification = new VerificationService(manager, catalog); assignments = new AgentAssignments(manager, catalog)
    let result
    switch (command) {
      case 'verify': result = await verification.verify(args[0], args[1] === undefined ? undefined : args[1].split(',') as Capability[]); if (result.state !== 'verified') process.exitCode = 1; break
      case 'history': result = verification.store.history(args[0]); break
      case 'assign': {
        let input: unknown
        try { input = JSON.parse(args[1]) } catch { throw new ManagementError('INVALID_INPUT') }
        result = await assignments.set(input, Number(args[0])); break
      }
      case 'assignment': result = assignments.get(args[0]); break
      case 'resolve': result = await assignments.resolve(args[0]); break
    }
    console.log(JSON.stringify(result, null, 2))
  }
} catch (error) { const failure = error instanceof ManagementError ? error : new ManagementError('STORE_FAILED'); console.error(JSON.stringify({ code: failure.code, error: failure.message })); process.exitCode = 1 }
finally { assignments?.close(); verification?.close(); catalog?.close(); manager?.close() }
