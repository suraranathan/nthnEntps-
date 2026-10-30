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
  setTimeout(() => process.exit(code), 3500).unref()
  Promise.all(children.map(child => new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)))).then(() => process.exit(code))
}
const api = spawn(process.execPath, ['server/index.ts'], { cwd, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] })
children.push(api)
api.on('message', message => {
  if (message !== 'ready' || stopping) return
  const ui = spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...(mode === 'preview' ? ['preview'] : [])], { cwd, stdio: 'inherit' })
  children.push(ui)
  ui.on('error', () => stop(1)); ui.on('exit', code => stop(code ?? 1))
})
api.on('error', () => stop(1)); api.on('exit', code => stop(code ?? 1))
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop())
