import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import electronPath from 'electron'

const server = await createServer({ server: { port: 5173, strictPort: true } })
await server.listen()
const url = 'http://localhost:5173'
console.log(`[dev] renderer at ${url}`)

const child = spawn(String(electronPath), ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
})

const shutdown = async () => {
  await server.close()
  process.exit(0)
}

child.on('exit', shutdown)
process.on('SIGINT', () => {
  child.kill()
  shutdown()
})
