import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runCli } from '../apps/cli/src/index.js'

const chunks: string[] = []
const exitCode = await runCli(['status'], {
  stdout: { write: (chunk) => chunks.push(chunk) },
})
const status = JSON.parse(chunks.join('')) as { name?: string; status?: string }
if (
  exitCode !== 0 ||
  status.name !== 'qiushui-airadar' ||
  status.status !== 'ready'
) {
  throw new Error('CLI source smoke failed')
}

const webRequire = createRequire(
  new URL('../apps/web/package.json', import.meta.url)
)
const viteEntry = webRequire.resolve('vite')
const { createServer } = (await import(
  pathToFileURL(viteEntry).href
)) as typeof import('vite')
const server = await createServer({
  configFile: fileURLToPath(
    new URL('../apps/web/vite.config.ts', import.meta.url)
  ),
  root: fileURLToPath(new URL('../apps/web', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
})

try {
  await server.listen()
  const address = server.httpServer?.address() as AddressInfo | null
  if (!address) throw new Error('Web source smoke did not bind a port')
  const response = await fetch(`http://127.0.0.1:${address.port}/`)
  const html = await response.text()
  if (!response.ok || !html.includes('<title>qiushui-airadar</title>')) {
    throw new Error('Web source smoke returned an unexpected page')
  }
} finally {
  await server.close()
}

process.stdout.write('CLI and Web source smoke passed\n')
