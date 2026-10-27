import path from 'node:path'
import { homedir } from 'node:os'
import {
  initializeSingleTableConfig,
  loadSingleTableConfig,
} from '../packages/config/src/index.js'

import { createSingleTableServiceApp } from '../apps/service/src/single-table-service.js'

const dataRootValue =
  process.env.QIUSHUI_AIRADAR_V2_DATA_ROOT ??
  path.join(homedir(), '.qiushui-airadar', 'development-data')
if (!dataRootValue || !path.isAbsolute(dataRootValue))
  throw new Error(
    'QIUSHUI_AIRADAR_V2_DATA_ROOT must be an absolute path to the new data directory'
  )
const dataRoot = path.resolve(dataRootValue)
const legacyRoot = path.resolve(
  process.env.QIUSHUI_AIRADAR_DATA_ROOT ??
    path.join(homedir(), '.qiushui-airadar', 'data')
)
if (
  dataRoot === legacyRoot ||
  dataRoot.startsWith(`${legacyRoot}${path.sep}`) ||
  legacyRoot.startsWith(`${dataRoot}${path.sep}`)
)
  throw new Error('New data root must not overlap the legacy data directory')

const configRoot = await initializeSingleTableConfig(
  path.resolve(import.meta.dirname, '../config'),
  dataRoot
)
await loadSingleTableConfig(configRoot)
const port = Number(process.env.QIUSHUI_AIRADAR_DEV_PORT ?? 43111)
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 43120)
  throw new Error(
    'Invalid development port (43120 is reserved for installation)'
  )
const service = createSingleTableServiceApp({
  dataRoot,
  configRoot,
  secretFile: process.env.QIUSHUI_AIRADAR_V2_SECRET_FILE,
  promptsRoot: path.resolve(
    import.meta.dirname,
    '../docs/prompts/single-table-content'
  ),
})
const address = await service.start({ host: '127.0.0.1', port })
process.stdout.write(
  `Single-table API ready at http://${address.host}:${address.port}\n`
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void service.stop().then(() => process.exit(0))
  })
}
