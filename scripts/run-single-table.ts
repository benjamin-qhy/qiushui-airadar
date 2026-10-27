import { homedir } from 'node:os'
import path from 'node:path'
import { collectSingleTable } from '../apps/service/src/collect-single-table.js'

const dataRootValue = process.env.QIUSHUI_AIRADAR_V2_DATA_ROOT
if (!dataRootValue || !path.isAbsolute(dataRootValue))
  throw new Error(
    'QIUSHUI_AIRADAR_V2_DATA_ROOT must be an absolute path to a new data directory'
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

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const results = await collectSingleTable({
  dataRoot,
  templateRoot: path.join(repositoryRoot, 'config'),
  promptsRoot: path.join(repositoryRoot, 'docs/prompts/single-table-content'),
  secretFile: process.env.QIUSHUI_AIRADAR_V2_SECRET_FILE,
})
process.stdout.write(`${JSON.stringify(results)}\n`)
if (results.some((result) => result.failed)) process.exitCode = 1
