#!/usr/bin/env node
import { join } from 'node:path'
import {
  asSecretStatusReader,
  createFileSecretReader,
} from '@qiushui-airadar/config'
import {
  createSingleTableServiceApp,
  type ServiceApp,
} from '@qiushui-airadar/service'
import { runCli } from './index.js'
import { productionDataRoot } from './paths.js'

// Existing launch scripts may still use the previous environment prefix.
for (const [name, value] of Object.entries(process.env)) {
  if (!name.startsWith('QIUSHUIAI_AIRADAR_')) continue
  const current = name.replace('QIUSHUIAI_AIRADAR_', 'QIUSHUI_AIRADAR_')
  if (!process.env[current]) process.env[current] = value
}

const secretFile =
  process.env.QIUSHUI_AIRADAR_SECRET_FILE ??
  join(process.env.QIUSHUI_AIRADAR_DATA_ROOT ?? productionDataRoot(), '.env')
const secretReader = createFileSecretReader(secretFile)
let activeService: ServiceApp | undefined

try {
  if (process.argv[2] === 'service') {
    for (const name of [
      'TIKHUB_API_KEY',
      'TWITTERAPI_IO_KEY',
      'YOUTUBE_API_KEY',
      'GETBIJI_API_KEY',
      'GETBIJI_CLIENT_ID',
      'QIUSHUI_AIRADAR_TRANSCRIBER_URL',
      'QIUSHUI_AIRADAR_WEB_ORIGINS',
      'CODEX_AUTH_PATH',
    ]) {
      const value = await secretReader
        .get(name)
        .then(
          async (current) =>
            current ??
            (name.startsWith('QIUSHUI_AIRADAR_')
              ? await secretReader.get(
                  name.replace('QIUSHUI_AIRADAR_', 'QIUSHUIAI_AIRADAR_')
                )
              : undefined)
        )
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return undefined
          throw error
        })
      if (value && !process.env[name]) process.env[name] = value
    }
  }
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    secretStatusReader: asSecretStatusReader(secretReader),
    serviceFactory(options) {
      activeService = createSingleTableServiceApp(options)
      return activeService
    },
  })
  if (activeService) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void activeService?.stop().then(() => process.exit(0))
      })
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown error'
  process.stderr.write(`qiushui-airadar: ${message}\n`)
  process.exitCode = 1
}
