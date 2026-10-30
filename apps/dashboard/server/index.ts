import { loadEnvFile } from 'node:process'
import { readFile, open, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryStore } from './memory.ts'
import { ModelRouter, providersFromEnv } from './providers.ts'
import { AlexRuntime } from './runtime.ts'
import { createApi } from './http.ts'
const appDirectory = fileURLToPath(new URL('../', import.meta.url))
try { loadEnvFile(join(appDirectory, '.env.server')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
let providers: ReturnType<typeof providersFromEnv>
try { providers = providersFromEnv(process.env) } catch { console.error('Invalid provider configuration. Check server provider URL, protocol and model settings; credentials must be separate.'); process.exit(1) }
const store = new MemoryStore(resolve(appDirectory, process.env.ALEX_DATA_DIR || '.local/alex'))
await store.load()
const lockPath = join(store.directory, 'runtime.lock')
async function acquireLock() {
  try { const file = await open(lockPath, 'wx', 0o600); await file.writeFile(String(process.pid)); await file.close() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const pid = Number(await readFile(lockPath, 'utf8'))
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid runtime lock; inspect the data directory')
    let alive = true
    try { process.kill(pid, 0) } catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') alive = false }
    if (alive) throw new Error('An Alex runtime already owns this memory directory')
    await unlink(lockPath); await acquireLock()
  }
}
await acquireLock()
const router = new ModelRouter(providers, store.state.routing || process.env.ALEX_PROVIDER || null)
const runtime = new AlexRuntime(store, router, resolve(appDirectory, '../../PROJECT_STATUS.md'))
await runtime.initialize()
const server = createApi(runtime)
const timer = setInterval(() => { void runtime.tick() }, 60000)
timer.unref()
const shutdown = () => { clearInterval(timer); server.close(() => { void unlink(lockPath).finally(() => process.exit(0)) }); setTimeout(() => process.exit(1), 3000).unref() }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)
server.on('error', () => { console.error('Alex API failed to listen. Check port 3001 and local data permissions.'); void unlink(lockPath).finally(() => process.exit(1)) })
server.listen(3001, '127.0.0.1', () => { console.log('Alex API listening on loopback :3001; no model marked online until inference succeeds.'); process.send?.('ready') })
