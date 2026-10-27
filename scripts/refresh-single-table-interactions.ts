import path from 'node:path'

import {
  createFileSecretReader,
  loadSingleTableConfig,
} from '../packages/config/src/index.js'
import { SingleTableRepository } from '../packages/runtime/src/index.js'
import { createSingleTableSourceProvider } from '../apps/service/src/single-table-provider.js'

const dataRootValue = process.env.QIUSHUI_AIRADAR_V2_DATA_ROOT
if (!dataRootValue || !path.isAbsolute(dataRootValue))
  throw new Error('QIUSHUI_AIRADAR_V2_DATA_ROOT must be an absolute path')

const dataRoot = path.resolve(dataRootValue)
const config = await loadSingleTableConfig(path.join(dataRoot, 'config'))
const reader = createFileSecretReader(
  process.env.QIUSHUI_AIRADAR_V2_SECRET_FILE ?? path.join(dataRoot, '.env')
)
async function credential(name: string): Promise<string | undefined> {
  try {
    return await reader.get(name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const provider = createSingleTableSourceProvider({
  tikHubToken: await credential('TIKHUB_API_KEY'),
  twitterApiKey: await credential('TWITTERAPI_IO_KEY'),
  youtubeApiKey: await credential('YOUTUBE_API_KEY'),
})
const repository = await SingleTableRepository.open(dataRoot)
try {
  const rows = repository.search({ limit: 500 })
  const sourceIds = new Set(rows.map((row) => String(row.source_account_id)))
  for (const source of config.sources.sources) {
    if (!sourceIds.has(source.id) || source.platform === 'rss') continue
    const existingCount = rows.filter(
      (row) => row.source_account_id === source.id
    ).length
    const limit = Math.max(existingCount, source.platform === 'x' ? 100 : 0)
    try {
      const page = await provider.discover(source, limit)
      let updated = 0
      for (const item of page.items) {
        if (!item.interaction) continue
        updated += repository.updateInteractionBySourceId(
          source.id,
          item.externalId,
          item.interaction
        )
      }
      process.stdout.write(`${source.id}: ${updated} existing rows updated\n`)
    } catch (error) {
      process.stderr.write(
        `${source.id}: interaction refresh failed (${error instanceof Error ? error.name : 'unknown'})\n`
      )
    }
  }
} finally {
  repository.close()
}
