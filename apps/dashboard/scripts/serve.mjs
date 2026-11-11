import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const cwd = fileURLToPath(new URL('../', import.meta.url))
const mode = process.argv[2] === 'preview' ? 'preview' : 'dev'
const children = []
let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  setTimeout(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    process.exit(code)
  }, 3500).unref()
  Promise.all(children.map(child => new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve)))).then(() => process.exit(code))
}
const api = spawn(process.execPath, ['server/index.ts'], { cwd, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] })
children.push(api)
api.on('message', message => {
  if (message !== 'ready' || stopping) return
  const ui = spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...(mode === 'preview' ? ['preview'] : [])], { cwd, stdio: 'inherit' })
  children.push(ui)
  const catalog = spawn(process.execPath, ['server/ai/catalog-cli.ts', 'watch'], { cwd, stdio: 'inherit' })
  children.push(catalog)
  // Catalog storage/config errors must never stop Jef or the office UI.
  catalog.on('error', () => console.error('Catalog worker could not start; Jef remains available.'))
  catalog.on('exit', code => { if (!stopping && code) console.error('Catalog worker stopped; use npm run catalog -- watch to retry. Jef remains available.') })
  ui.on('error', () => stop(1)); ui.on('exit', code => stop(code ?? 1))
})
api.on('error', () => stop(1)); api.on('exit', code => stop(code ?? 1))
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop())
