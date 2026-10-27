import { createServer, type IncomingMessage, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import {
  createFileSecretReader,
  editableConfigFileNames,
  loadSingleTableConfig,
  loadSourceState,
  saveAnalysisModelConfig,
  saveAnalysisTranscriptionConfig,
  saveEditableConfigFile,
  saveProvidersConfig,
  saveSourcesConfig,
  saveSourceState,
  sourcesConfigSchema,
  providerRoutesSchema,
  updateFileSecret,
  type SingleTableConfig,
} from '@qiushuiai-airadar/config'
import {
  SingleTableRepository,
  type ContentRow,
} from '@qiushuiai-airadar/runtime'
import {
  classifyNonArticlePage,
  normalizeYouTubeIdentity,
} from '@qiushuiai-airadar/source-adapters'
import {
  createReadOnlyCodexCredentialStore,
  createFileModelCredentialStore,
  createProviderLoginManager,
  createSingleTableModelGateway,
  listSingleTableModelProviders,
  listSingleTableModels,
  normalizeSingleTableProviderId,
  processSingleTableContent,
  translateSingleTableContent,
  type SingleTableModelGateway,
} from '@qiushuiai-airadar/pipeline'
import { createSingleTableSourceProvider } from './single-table-provider.js'
import {
  checkXVideoTranscription,
  transcribeXVideo,
} from './x-video-transcriber.js'
import {
  collectSingleTable,
  createCollectionControl,
  type CollectionControl,
} from './collect-single-table.js'
import { readCollectionRun } from './collection-run.js'

const scoreNames = {
  interest_fit: 'interestFit',
  concrete_gain: 'concreteGain',
  substance: 'substance',
  new_information: 'newInformation',
} as const

const providerDefinitions = [
  {
    id: 'twitterapi.io',
    name: 'TwitterAPI.io',
    sourceType: 'x',
    secretName: 'TWITTERAPI_IO_KEY',
  },
  {
    id: 'tikhub-x',
    name: 'TikHub X',
    sourceType: 'x',
    secretName: 'TIKHUB_API_KEY',
  },
  {
    id: 'youtube-data-api',
    name: 'YouTube Data API',
    sourceType: 'youtube',
    secretName: 'YOUTUBE_API_KEY',
  },
  {
    id: 'tikhub-youtube',
    name: 'TikHub YouTube',
    sourceType: 'youtube',
    secretName: 'TIKHUB_API_KEY',
  },
  {
    id: 'native-rss',
    name: '原生 RSS',
    sourceType: 'rss',
  },
  {
    id: 'native-http',
    name: '原生网页抓取',
    sourceType: 'web',
  },
] as const

const providerRouteDefinitions = [
  {
    id: 'x_list',
    name: 'X 博主作品列表',
    description: '获取 X 博主发布的作品列表及随列表返回的互动数据。',
    availableProviders: ['twitterapi.io', 'tikhub-x'],
  },
  {
    id: 'x_article',
    name: 'X 文章正文',
    description: '补全 X Article 或帖子中链接文章的正文。',
    availableProviders: ['twitterapi.io', 'native-http'],
  },
  {
    id: 'youtube_list',
    name: 'YouTube 博主作品列表',
    description: '获取 YouTube 频道的视频列表及列表自带的互动数据。',
    availableProviders: ['youtube-data-api', 'tikhub-youtube'],
  },
  {
    id: 'youtube_captions',
    name: 'YouTube 字幕',
    description: '获取视频已有字幕，不单独查询互动数据。',
    availableProviders: ['tikhub-youtube'],
  },
  {
    id: 'rss_list',
    name: 'RSS 作品列表',
    description: '读取 RSS Feed 中的作品列表。',
    availableProviders: ['native-rss'],
  },
  {
    id: 'web_article',
    name: '网页文章正文',
    description: '抓取普通网页文章正文。',
    availableProviders: ['native-http'],
  },
] as const

function sourceItem(
  source: SingleTableConfig['sources']['sources'][number],
  enabled: boolean
) {
  return {
    id: source.id,
    name: source.account_name,
    type: source.platform,
    language: source.language,
    externalIdentity: source.external_identity,
    status: enabled ? ('enabled' as const) : ('disabled' as const),
    health: enabled ? ('healthy' as const) : ('disabled' as const),
    effectiveParameters: { ids: [], values: {} },
  }
}

function sourceFromBody(body: Record<string, unknown>) {
  const candidate = {
    id: body.id,
    platform: body.type,
    account_name: body.name,
    external_identity: body.externalIdentity,
    language: body.language,
    enabled: body.enabled !== false,
  }
  return sourcesConfigSchema.parse({ sources: [candidate] }).sources[0]!
}

function arrayValue(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]')) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

interface LogEntry {
  index: number
  timestamp: string
  action: string
  status: string
  stage?: string
  trigger?: string
  duration?: string
  retryCount?: string
  processor?: string
  prompt?: string
  error?: string
  request?: string
  response?: string
}

interface RuntimeLogEntry extends Omit<LogEntry, 'request' | 'response'> {
  id: string
  kind: 'collection' | 'content'
  message: string
  contentId?: string
  contentTitle?: string
  sourceId?: string
  sourceName?: string
}

function logEntries(markdown: string): LogEntry[] {
  const sections = markdown.split(/^## /mu).slice(1)
  return sections.flatMap((section, index) => {
    const [heading] = section.split('\n', 1)
    const parts = /^(.*?) \| (.*?) \| (.*?)$/u.exec(heading ?? '')
    if (!parts) return []
    const field = (name: string) =>
      new RegExp(`^- ${name}：\x60([^\x60]*)\x60`, 'mu').exec(section)?.[1]
    const payload = (name: string) =>
      new RegExp(
        `^### ${name}\\n\\n\\x60{3}json\\n([\\s\\S]*?)\\n\\x60{3}`,
        'mu'
      ).exec(section)?.[1]
    return [
      {
        index,
        timestamp: parts[1]!,
        action: parts[2]!,
        status: parts[3]!,
        stage: field('阶段'),
        trigger: field('触发方式'),
        duration: field('耗时'),
        retryCount: field('重试次数'),
        processor: field('处理器'),
        prompt: field('提示词'),
        error: field('错误摘要'),
        request: payload('request'),
        response: payload('response'),
      },
    ]
  })
}

const actionMessages: Record<string, string> = {
  'save-original': '已保存原始内容',
  discover: '已获取信源内容',
  enrich: '已补充内容详情',
  classify: '已完成内容判断',
  score: '已完成内容分析和评分',
  translate: '已完成英文内容翻译',
  'write-content': '已写入内容文件',
  'manual-retry': '已开始人工重试',
  'manual-junk': '已更新人工垃圾标记',
  'rule-junk': '已按规则排除内容',
}

function contentLogMessage(entry: LogEntry): string {
  const base = actionMessages[entry.action] ?? `执行 ${entry.action}`
  if (entry.status === 'failed') return `${base.replace(/^已/u, '')}失败`
  return base
}

async function runtimeLogs(
  repository: SingleTableRepository,
  collection: Awaited<ReturnType<typeof readCollectionRun>>
): Promise<RuntimeLogEntry[]> {
  const documents = repository.runtimeLogDocuments()
  let summaries = await repository.readRuntimeLogSummaries()
  if (!summaries.length && documents.length) {
    const rebuilt: typeof summaries = []
    for (const document of documents) {
      const markdown = await repository.readLog(document.contentId)
      if (!markdown) continue
      rebuilt.push(
        ...logEntries(markdown).map(
          ({ request: _request, response: _response, ...entry }) => ({
            ...entry,
            stage: entry.stage ?? entry.action,
            trigger: entry.trigger ?? 'scheduled',
            duration: entry.duration ?? '0 ms',
            retryCount: entry.retryCount ?? '0',
            contentId: document.contentId,
            contentTitle: document.title,
            sourceId: document.sourceId,
            sourceName: document.sourceName,
          })
        )
      )
    }
    await repository.replaceRuntimeLogSummaries(rebuilt)
    summaries = rebuilt
  }
  const contentEntries: RuntimeLogEntry[] = summaries.map((entry) => ({
    ...entry,
    id: `content:${entry.contentId}:${entry.index}`,
    kind: 'content',
    message: contentLogMessage(entry),
  }))
  const collectionEntries: RuntimeLogEntry[] = (collection?.events ?? []).map(
    (event, index) => ({
      id: `collection:${collection?.id ?? 'unknown'}:${event.id ?? index}`,
      index,
      timestamp: event.timestamp,
      action: event.action,
      status: event.status,
      stage: event.action,
      kind: 'collection',
      message: event.message,
      sourceId: event.sourceId,
      sourceName: event.sourceName,
    })
  )
  return [...collectionEntries, ...contentEntries].sort(
    (left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp)
  )
}

async function feedItem(
  repository: SingleTableRepository,
  row: ContentRow,
  sources: SingleTableConfig['sources']['sources']
) {
  const source = sources.find(
    (candidate) => candidate.id === row.source_account_id
  )
  const scores = Object.fromEntries(
    Object.entries(scoreNames).flatMap(([column, name]) => {
      const level = row[`${column}_level`]
      return typeof level === 'number'
        ? [[name, { level, reason: row[`${column}_reason`] }]]
        : []
    })
  )
  const chinese =
    row.original_language === 'zh' || row.translated_to_chinese
      ? await repository.readBody(row.id, 'zh')
      : undefined
  const english = await repository.readBody(row.id, 'en')
  return {
    id: row.id,
    title: row.title,
    chineseTitle: row.chinese_title ?? undefined,
    url: row.canonical_url ?? undefined,
    publishedAt: row.published_at ?? undefined,
    discoveredAt: row.discovered_at,
    firstInflowAt: row.first_inflow_at,
    originalFormat: row.original_format,
    externalContentId: row.external_content_id,
    processStage: row.processing_stage,
    retryCount: row.retry_count,
    lastError: row.last_error,
    lastProcessedAt: row.last_processed_at,
    analyzedAt: row.analyzed_at,
    body: english ?? chinese ?? '',
    hasEnglishBody: Boolean(english),
    summary: row.summary ?? '',
    keywordsText: row.keywords_text,
    valueSummary: row.value_summary ?? undefined,
    originalLanguage: row.original_language,
    chineseTranslation: row.original_language === 'en' ? chinese : undefined,
    translatedToChinese: Boolean(row.translated_to_chinese),
    translationStatus: row.translation_status,
    translationSkipReason: row.translation_skip_reason ?? undefined,
    translationError: row.translation_error ?? undefined,
    translationChunkCount: row.translation_chunk_count,
    translationCompletedChunks: row.translation_completed_chunks,
    topics: arrayValue(row.keywords_json),
    scores,
    totalScore: row.total_score,
    recommendation: row.recommendation,
    kind: row.content_kind,
    source: source
      ? {
          id: source.id,
          name: source.account_name,
          type: source.platform,
          language: source.language,
        }
      : {
          id: row.source_account_id,
          name: row.source_account_name,
          type: row.source_platform,
          language: row.original_language,
        },
    images: arrayValue(row.images_json),
    quotedPost: row.quoted_post_json
      ? JSON.parse(String(row.quoted_post_json))
      : undefined,
    repostedBy: row.reposted_by_json
      ? JSON.parse(String(row.reposted_by_json))
      : undefined,
    video:
      row.video_duration_seconds ||
      row.video_thumbnail_url ||
      row.video_media_url
        ? {
            durationSeconds: row.video_duration_seconds,
            thumbnailUrl: row.video_thumbnail_url,
            mediaUrl: row.video_media_url,
          }
        : undefined,
    processStatus: row.process_status,
    originalStatus: row.original_status,
    read: Boolean(row.read),
    utilizationActions: arrayValue(row.utilization_actions_json),
    junk: {
      isJunk: Boolean(row.is_junk),
      source: row.junk_source,
      reason: row.junk_reason ?? undefined,
      note: row.junk_note ?? undefined,
    },
    interaction: row.interaction_captured_at
      ? {
          capturedAt: row.interaction_captured_at,
          views: row.views,
          likes: row.likes,
          comments: row.comments,
          shares: row.shares,
          saves: row.saves,
        }
      : undefined,
    analysis: row.analysis_provider
      ? {
          provider: row.analysis_provider,
          model: row.analysis_model,
          profileVersionId: row.analysis_profile_version_id,
          ruleVersion: row.analysis_rule_version,
        }
      : undefined,
  }
}

async function bodyOf(
  request: IncomingMessage
): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of request) {
    body += String(chunk)
    if (body.length > 1_000_000) throw new Error('Request is too large')
  }
  const parsed = JSON.parse(body || '{}') as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('JSON object required')
  return parsed as Record<string, unknown>
}

function send(
  response: import('node:http').ServerResponse,
  status: number,
  body: unknown
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

function localOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return (
      ['http:', 'https:'].includes(parsed.protocol) &&
      (['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname) ||
        parsed.host === host)
    )
  } catch {
    return false
  }
}

export function createSingleTableServiceApp(options: {
  dataRoot: string
  configRoot: string
  secretFile?: string
  promptsRoot?: string
  webRoot?: string
  gateway?: SingleTableModelGateway
  modelConnectionTest?: (
    providerId: string,
    modelId: string
  ) => Promise<{ status: 'succeeded'; message: string }>
  providerFetch?: typeof fetch
  collectionProvider?: import('@qiushuiai-airadar/pipeline').SingleTableSourceProvider
}) {
  let repository: SingleTableRepository | undefined
  let server: Server | undefined
  const retrying = new Set<string>()
  const translating = new Set<string>()
  const translationTasks = new Set<Promise<unknown>>()
  let collection: Promise<unknown> | undefined
  let collectionControl: CollectionControl | undefined
  type RetryBatch = {
    id: string
    status: 'running' | 'paused' | 'completed' | 'canceled'
    ids: string[]
    cursor: number
    succeeded: number
    failed: number
    message?: string
  }
  const batchFile = path.join(options.dataRoot, 'model-retry-batch.json')
  let batchWorker: Promise<void> | undefined
  let activeBatch: RetryBatch | undefined
  const readBatch = async (): Promise<RetryBatch | null> => {
    if (activeBatch) return activeBatch
    try {
      const batch = JSON.parse(await readFile(batchFile, 'utf8')) as RetryBatch
      if (batch.status === 'running' && !batchWorker) {
        batch.status = 'paused'
        batch.message = '服务已重启。请检查模型后手动继续批量重试。'
        await writeFile(batchFile, JSON.stringify(batch))
      }
      return batch
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  const saveBatch = (batch: RetryBatch) => {
    activeBatch = batch
    return writeFile(batchFile, JSON.stringify(batch))
  }
  const secretFile = options.secretFile ?? path.join(options.dataRoot, '.env')
  const credentialFile = path.join(options.dataRoot, 'model-auth.json')
  const credentialStore = createFileModelCredentialStore(credentialFile)
  const pendingCredentialStore = createFileModelCredentialStore(
    path.join(options.dataRoot, 'model-pending-auth.json')
  )
  const logins = createProviderLoginManager(credentialStore)
  const pendingLogins = createProviderLoginManager(pendingCredentialStore)
  const verificationFile = path.join(
    options.dataRoot,
    'model-verification.json'
  )
  const verifiedModels = async (): Promise<Record<string, string[]>> => {
    try {
      return JSON.parse(await readFile(verificationFile, 'utf8')) as Record<
        string,
        string[]
      >
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }
  const recordVerified = async (
    providerId: string,
    modelId: string,
    reset = false
  ) => {
    const state = await verifiedModels()
    state[providerId] = reset
      ? [modelId]
      : [...new Set([...(state[providerId] ?? []), modelId])]
    const temporary = `${verificationFile}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
    await rename(temporary, verificationFile)
  }
  const testModel = (providerId: string, modelId: string, pending = false) =>
    options.modelConnectionTest
      ? options.modelConnectionTest(providerId, modelId)
      : (pending ? pendingLogins : logins).test(providerId, modelId)
  const validateRoutes = async (
    routes: Array<{ provider: string; model: string }>
  ) => {
    for (const route of routes.filter(
      (item, index, all) =>
        all.findIndex(
          (other) =>
            other.provider === item.provider && other.model === item.model
        ) === index
    )) {
      if (!(await credentialStore.read(route.provider)))
        throw new Error(`${route.provider} 尚未通过连接测试。`)
      try {
        await testModel(route.provider, route.model)
        await recordVerified(route.provider, route.model)
      } catch {
        throw new Error(
          `${route.provider} / ${route.model} 调用失败，请检查密钥、权限或额度。`
        )
      }
    }
  }
  const configuredRoutes = async () => {
    const config = await loadSingleTableConfig(options.configRoot)
    const provider = normalizeSingleTableProviderId(
      config.analysis.model.provider
    )
    return [
      { provider, model: config.analysis.model.default },
      ...Object.values(config.analysis.model.stages ?? {}).map((route) =>
        typeof route === 'string'
          ? { provider, model: route }
          : {
              provider: normalizeSingleTableProviderId(route.provider),
              model: route.model,
            }
      ),
    ]
  }
  const readSecret = async (name: string) => {
    try {
      return await createFileSecretReader(secretFile).get(name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  const codexProviderStatus = async () => {
    const defaultAuthPath = path.join(homedir(), '.codex', 'auth.json')
    const configuredAuthPath = await readSecret('CODEX_AUTH_PATH')
    const authPath = configuredAuthPath || defaultAuthPath
    return {
      authPath,
      usesDefaultPath: !configuredAuthPath,
    }
  }
  const modelProviders = async () => {
    const config = await loadSingleTableConfig(options.configRoot)
    const activeProvider = normalizeSingleTableProviderId(
      config.analysis.model.provider
    )
    const codex = await codexProviderStatus()
    const credentials = new Map(
      (await credentialStore.list()).map((credential) => [
        credential.providerId,
        credential.type,
      ])
    )
    const pendingCredentials = new Map(
      (await pendingCredentialStore.list()).map((credential) => [
        credential.providerId,
        credential.type,
      ])
    )
    const verified = await verifiedModels()
    return Promise.all(
      listSingleTableModelProviders().map(async (provider) => ({
        ...provider,
        active: provider.id === activeProvider,
        configured: credentials.has(provider.id),
        verified:
          credentials.has(provider.id) &&
          Boolean(verified[provider.id]?.length),
        pending: pendingCredentials.has(provider.id),
        credentialType: credentials.get(provider.id),
        ...(provider.id === 'openai-codex'
          ? {
              authLabel: 'ChatGPT 订阅 OAuth',
              authPath: codex.authPath,
              usesDefaultPath: codex.usesDefaultPath,
            }
          : { authLabel: 'API Key' }),
      }))
    )
  }
  return {
    async start(address: { host: string; port: number }) {
      if (server) throw new Error('Service is already running')
      if (!['127.0.0.1', '::1', '0.0.0.0'].includes(address.host))
        throw new Error('Unsupported service host')
      repository = await SingleTableRepository.open(options.dataRoot)
      const activeRepository = repository
      const executeBatch = (batch: RetryBatch) => {
        activeBatch = batch
        const task = (async () => {
          const address = server?.address()
          if (!address || typeof address === 'string') return
          while (
            batch.status === 'running' &&
            batch.cursor < batch.ids.length
          ) {
            const id = batch.ids[batch.cursor]!
            const current = activeRepository.getById(id)
            if (!current || current.process_status === 'completed') {
              batch.cursor++
              await saveBatch(batch)
              continue
            }
            try {
              const response = await fetch(
                `http://127.0.0.1:${address.port}/api/contents/${encodeURIComponent(id)}/retry`,
                {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    'x-model-retry-batch': batch.id,
                  },
                  body: '{}',
                }
              )
              if (!response.ok) {
                batch.failed++
                batch.status = 'paused'
                batch.message = '模型重试失败，已暂停。检查模型连接后可继续。'
                await saveBatch(batch)
                break
              }
              batch.succeeded++
              batch.cursor++
              await saveBatch(batch)
            } catch {
              batch.failed++
              batch.status = 'paused'
              batch.message = '重试请求失败，已暂停。'
              await saveBatch(batch)
              break
            }
          }
          if (batch.status === 'running') {
            batch.status = 'completed'
            batch.message = '批量重试已完成。'
            await saveBatch(batch)
          }
        })()
        batchWorker = task.finally(() => {
          batchWorker = undefined
        })
      }
      server = createServer((request, response) => {
        void (async () => {
          const url = new URL(request.url ?? '/', `http://${address.host}`)
          const method = request.method ?? 'GET'
          if (method === 'GET' && url.pathname === '/api/model-retry/preview') {
            const rows = activeRepository.modelFailureRows()
            return send(response, 200, {
              count: rows.length,
              estimatedModelCalls: rows.length * 2,
              message: '仅包含模型错误；实际调用次数取决于内容和翻译环节。',
            })
          }
          if (method === 'GET' && url.pathname === '/api/model-retry')
            return send(response, 200, { batch: await readBatch() })
          if (
            method === 'POST' &&
            url.pathname.startsWith('/api/model-retry/')
          ) {
            if (!localOrigin(request.headers.origin, request.headers.host))
              return send(response, 403, { error: 'origin_not_allowed' })
            if (
              !request.headers['content-type']?.startsWith('application/json')
            )
              return send(response, 415, { error: 'json_required' })
          }
          if (method === 'POST' && url.pathname === '/api/model-retry/start') {
            await bodyOf(request)
            const existing = await readBatch()
            if (existing && ['running', 'paused'].includes(existing.status))
              return send(response, 409, {
                message: '已有批量重试任务，请继续或取消。',
              })
            if (collection)
              return send(response, 409, {
                message: '采集正在运行，请完成后再批量重试。',
              })
            if (!options.gateway) {
              try {
                await validateRoutes(await configuredRoutes())
              } catch (error) {
                return send(response, 409, {
                  message:
                    error instanceof Error ? error.message : '模型测试失败。',
                })
              }
            }
            const ids = activeRepository.modelFailureRows().map((row) => row.id)
            const batch: RetryBatch = {
              id: randomUUID(),
              status: 'running',
              ids,
              cursor: 0,
              succeeded: 0,
              failed: 0,
            }
            await saveBatch(batch)
            executeBatch(batch)
            return send(response, 202, { batch })
          }
          if (
            method === 'POST' &&
            /^\/api\/model-retry\/(pause|resume|cancel)$/u.test(url.pathname)
          ) {
            await bodyOf(request)
            const batch = await readBatch()
            if (!batch)
              return send(response, 404, { message: '没有批量重试任务。' })
            const action = url.pathname.split('/').at(-1)
            if (action === 'pause' && batch.status === 'running')
              batch.status = 'paused'
            else if (
              action === 'cancel' &&
              ['running', 'paused'].includes(batch.status)
            )
              batch.status = 'canceled'
            else if (
              action === 'resume' &&
              batch.status === 'paused' &&
              !batchWorker
            ) {
              if (!options.gateway) {
                try {
                  await validateRoutes(await configuredRoutes())
                } catch (error) {
                  return send(response, 409, {
                    message:
                      error instanceof Error ? error.message : '模型测试失败。',
                  })
                }
              }
              batch.status = 'running'
              executeBatch(batch)
            } else if (action !== 'resume' || batch.status !== 'running')
              return send(response, 409, {
                message: '当前任务不能执行此操作。',
              })
            await saveBatch(batch)
            return send(response, 200, { batch })
          }
          const loginStatus = /^\/api\/model-login\/([^/]+)$/u.exec(
            url.pathname
          )
          if (method === 'GET' && loginStatus)
            return send(response, 200, logins.get(loginStatus[1]!))
          if (method === 'GET' && url.pathname === '/health')
            return send(response, 200, {
              service: 'qiushuiai-airadar-single-table',
              status: 'ready',
            })
          if (method === 'GET' && url.pathname === '/api/runtime/logs') {
            const collection = await readCollectionRun(options.dataRoot)
            const status = url.searchParams.get('status')
            const source = url.searchParams.get('source')
            const stage = url.searchParams.get('stage')
            const keyword = url.searchParams
              .get('keyword')
              ?.trim()
              .toLocaleLowerCase()
            const limit = Math.min(
              Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1),
              500
            )
            const offset = Math.max(
              Number(url.searchParams.get('offset') ?? 0) || 0,
              0
            )
            const all = (
              await runtimeLogs(activeRepository, collection)
            ).filter(
              (entry) =>
                (!status || entry.status === status) &&
                (!source || entry.sourceId === source) &&
                (!stage || entry.stage === stage) &&
                (!keyword ||
                  [
                    entry.message,
                    entry.contentTitle,
                    entry.sourceName,
                    entry.error,
                  ].some((value) =>
                    value?.toLocaleLowerCase().includes(keyword)
                  ))
            )
            return send(response, 200, {
              items: all.slice(offset, offset + limit),
              total: all.length,
              running:
                collection?.status === 'running' ||
                collection?.status === 'paused',
              updatedAt: collection?.updatedAt,
            })
          }
          const logMatch = /^\/api\/contents\/([^/]+)\/logs$/u.exec(
            url.pathname
          )
          if (method === 'GET' && logMatch) {
            const id = decodeURIComponent(logMatch[1]!)
            const markdown = await activeRepository.readLog(id)
            if (markdown === undefined)
              return send(response, 404, { error: 'not_found' })
            const entries = logEntries(markdown)
            const entryIndex = url.searchParams.get('entry')
            if (entryIndex !== null) {
              const index = Number(entryIndex)
              if (
                !Number.isInteger(index) ||
                index < 0 ||
                index >= entries.length
              )
                return send(response, 404, { error: 'not_found' })
              return send(response, 200, { item: entries[index] })
            }
            return send(response, 200, {
              items: entries
                .map(({ request, response, ...entry }) => entry)
                .reverse(),
            })
          }
          if (
            method === 'GET' &&
            (url.pathname === '/api/contents' || url.pathname === '/api/daily')
          ) {
            const config = await loadSingleTableConfig(options.configRoot)
            const rows = activeRepository
              .search({
                keyword: url.searchParams.get('keyword') ?? undefined,
                isJunk: url.pathname === '/api/daily' ? false : undefined,
                limit: 500,
              })
              .filter(
                (row) =>
                  url.pathname !== '/api/daily' ||
                  (row.process_status === 'completed' &&
                    row.recommendation !== 'none')
              )
            return send(response, 200, {
              items: await Promise.all(
                rows.map((row) =>
                  feedItem(activeRepository, row, config.sources.sources)
                )
              ),
            })
          }
          if (method === 'GET' && url.pathname === '/api/sources') {
            const config = await loadSingleTableConfig(options.configRoot)
            const state = await loadSourceState(options.configRoot)
            return send(response, 200, {
              items: config.sources.sources.map((source) =>
                sourceItem(
                  source,
                  state.sources[source.id]?.enabled_override ?? source.enabled
                )
              ),
            })
          }
          if (method === 'GET' && url.pathname === '/api/providers') {
            const config = await loadSingleTableConfig(options.configRoot)
            const reader = createFileSecretReader(
              options.secretFile ?? path.join(options.dataRoot, '.env')
            )
            const items = await Promise.all(
              providerDefinitions.map(async (provider) => {
                let configured = !('secretName' in provider)
                if ('secretName' in provider) {
                  try {
                    configured = Boolean(await reader.get(provider.secretName))
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                      throw error
                  }
                }
                const listRoute =
                  provider.sourceType === 'x'
                    ? config.providers.routes.x_list
                    : provider.sourceType === 'youtube'
                      ? config.providers.routes.youtube_list
                      : provider.sourceType === 'rss'
                        ? config.providers.routes.rss_list
                        : []
                const priority =
                  (listRoute as readonly string[]).indexOf(provider.id) + 1
                return {
                  id: provider.id,
                  name: provider.name,
                  sourceType: provider.sourceType,
                  priority: priority || undefined,
                  preferred: priority === 1,
                  secretName:
                    'secretName' in provider ? provider.secretName : undefined,
                  health: { state: configured ? 'healthy' : 'unconfigured' },
                  secretStatus:
                    'secretName' in provider ? { configured } : undefined,
                }
              })
            )
            return send(response, 200, {
              items,
              routes: providerRouteDefinitions.map((route) => ({
                ...route,
                providers: config.providers.routes[route.id],
              })),
            })
          }
          if (method === 'GET' && url.pathname === '/api/models') {
            const config = await loadSingleTableConfig(options.configRoot)
            const provider = normalizeSingleTableProviderId(
              url.searchParams.get('provider') ?? config.analysis.model.provider
            )
            const configuredProviders = (await modelProviders()).filter(
              (item) => item.configured
            )
            return send(response, 200, {
              provider,
              defaultModel: config.analysis.model.default,
              stages: config.analysis.model.stages,
              availableModels: listSingleTableModels(provider),
              availableModelGroups: configuredProviders.map((item) => ({
                providerId: item.id,
                providerName: item.name,
                models: listSingleTableModels(item.id),
              })),
            })
          }
          if (method === 'GET' && url.pathname === '/api/model-providers')
            return send(response, 200, { items: await modelProviders() })
          if (
            method === 'POST' &&
            (url.pathname === '/api/collection/start' ||
              (url.pathname === '/api/collection/resume' && !collection))
          ) {
            const restarting = url.pathname.endsWith('/resume')
            const origin = request.headers.origin
            if (!localOrigin(origin, request.headers.host))
              return send(response, 403, {
                message: '只能从本机页面启动采集。',
              })
            const previousRun = await readCollectionRun(options.dataRoot)
            if (restarting && previousRun?.status !== 'interrupted')
              return send(response, 409, {
                message: '当前没有可继续的中断任务。',
              })
            if (!restarting && previousRun?.status === 'interrupted')
              return send(response, 409, {
                message: '上轮采集中断，请先点击“继续采集”。',
              })
            if (
              collection ||
              ['running', 'paused'].includes(previousRun?.status ?? '')
            )
              return send(response, 409, { message: '已有采集任务正在执行。' })
            if (!options.promptsRoot)
              return send(response, 400, {
                message: '服务未配置分析提示词目录，无法启动采集。',
              })
            if (!options.gateway) {
              try {
                await validateRoutes(await configuredRoutes())
              } catch (error) {
                return send(response, 409, {
                  error: 'model_preflight_failed',
                  message:
                    error instanceof Error
                      ? error.message
                      : '模型连接测试失败。',
                })
              }
            }
            let started!: () => void
            let rejected!: (error: unknown) => void
            const ready = new Promise<void>((resolve, reject) => {
              started = resolve
              rejected = reject
            })
            const control = createCollectionControl()
            collectionControl = control
            collection = collectSingleTable({
              dataRoot: options.dataRoot,
              templateRoot: options.configRoot,
              promptsRoot: options.promptsRoot,
              secretFile: options.secretFile,
              repository: activeRepository,
              gateway: options.gateway,
              provider: options.collectionProvider,
              onStarted: started,
              control,
              resume: restarting,
            })
              .catch((error: unknown) => {
                rejected(error)
              })
              .finally(() => {
                collection = undefined
                if (collectionControl === control) collectionControl = undefined
              })
            await ready
            return send(response, 202, {
              message: restarting
                ? '已继续上轮采集，已成功内容不会重复分析。'
                : '采集已启动，关闭页面后仍会继续执行。',
            })
          }
          if (
            method === 'POST' &&
            (url.pathname === '/api/collection/pause' ||
              url.pathname === '/api/collection/resume')
          ) {
            const origin = request.headers.origin
            if (!localOrigin(origin, request.headers.host))
              return send(response, 403, {
                message: '只能从本机页面控制采集。',
              })
            if (!collection || !collectionControl)
              return send(response, 409, { message: '当前没有采集任务。' })
            const pausing = url.pathname.endsWith('/pause')
            const current = await readCollectionRun(options.dataRoot)
            if (
              (pausing && current?.status !== 'running') ||
              (!pausing && current?.status !== 'paused')
            )
              return send(response, 409, {
                message: pausing ? '当前任务不能暂停。' : '当前任务没有暂停。',
              })
            if (!pausing && !options.gateway) {
              try {
                await validateRoutes(await configuredRoutes())
              } catch (error) {
                return send(response, 409, {
                  error: 'model_preflight_failed',
                  message:
                    error instanceof Error
                      ? error.message
                      : '模型连接测试失败。',
                })
              }
            }
            await (pausing
              ? collectionControl.pause()
              : collectionControl.resume())
            return send(response, 200, {
              message: pausing
                ? '已暂停；当前正在处理的内容会安全结束。'
                : '已恢复，将从暂停位置继续采集。',
            })
          }
          if (method === 'GET' && url.pathname === '/api/runtime') {
            const config = await loadSingleTableConfig(options.configRoot)
            return send(response, 200, {
              mode: 'single-table',
              ...activeRepository.runtimeOverview(),
              collection: await readCollectionRun(options.dataRoot),
              schedule: {
                expression: config.runtime.collection.schedule,
                timezone: config.runtime.timezone,
                active: false,
              },
            })
          }
          if (method === 'GET' && url.pathname === '/api/config') {
            const files = await Promise.all(
              editableConfigFileNames.map(async (name) => ({
                name,
                content: await readFile(
                  path.join(options.configRoot, name),
                  'utf8'
                ),
              }))
            )
            return send(response, 200, { mode: 'file', files })
          }
          if (method === 'GET' && url.pathname === '/api/transcription') {
            const config = await loadSingleTableConfig(options.configRoot)
            return send(response, 200, {
              enabled: config.analysis.transcription.auto,
            })
          }
          if (['POST', 'PUT', 'DELETE'].includes(method)) {
            const origin = request.headers.origin
            if (
              !localOrigin(origin, request.headers.host)
            )
              return send(response, 403, { error: 'origin_not_allowed' })
            if (
              !request.headers['content-type']?.startsWith('application/json')
            )
              return send(response, 415, { error: 'json_required' })
            if (method === 'PUT' && url.pathname === '/api/transcription') {
              const body = await bodyOf(request)
              if (typeof body.enabled !== 'boolean')
                return send(response, 400, { error: 'enabled_required' })
              if (collection)
                return send(response, 409, {
                  message: '采集进行中，请结束后修改音频转写开关。',
                })
              if (body.enabled) {
                try {
                  await checkXVideoTranscription(options.dataRoot)
                } catch {
                  return send(response, 409, {
                    message: '本机转写组件尚未就绪，无法开启。',
                  })
                }
              }
              await saveAnalysisTranscriptionConfig(
                options.configRoot,
                body.enabled
              )
              return send(response, 200, { enabled: body.enabled })
            }
            if (method === 'POST' && url.pathname === '/api/model-login') {
              const body = await bodyOf(request)
              return send(
                response,
                200,
                logins.start(
                  String(body.providerId ?? ''),
                  body.method === 'device_code' ? 'device_code' : 'browser'
                )
              )
            }
            const loginAction =
              /^\/api\/model-login\/([^/]+)\/(respond|cancel)$/u.exec(
                url.pathname
              )
            if (method === 'POST' && loginAction) {
              const body = await bodyOf(request)
              return send(
                response,
                200,
                loginAction[2] === 'cancel'
                  ? logins.cancel(loginAction[1]!)
                  : logins.respond(
                      loginAction[1]!,
                      String(body.promptId ?? ''),
                      String(body.answer ?? '')
                    )
              )
            }
            const connectionTest =
              /^\/api\/model-providers\/([^/]+)\/connection-test$/u.exec(
                url.pathname
              )
            if (method === 'POST' && connectionTest) {
              const body = await bodyOf(request)
              try {
                return send(
                  response,
                  200,
                  await logins.test(
                    connectionTest[1]!,
                    String(body.modelId ?? '')
                  )
                )
              } catch {
                return send(response, 400, {
                  message: '连接测试未成功，请检查账号权限、额度或网络后重试。',
                })
              }
            }
            if (method === 'PUT' && url.pathname === '/api/models') {
              const body = await bodyOf(request)
              const config = await loadSingleTableConfig(options.configRoot)
              const provider = normalizeSingleTableProviderId(
                typeof body.provider === 'string'
                  ? body.provider.trim()
                  : config.analysis.model.provider
              )
              const defaultModel =
                typeof body.defaultModel === 'string'
                  ? body.defaultModel.trim()
                  : ''
              const stages =
                body.stages &&
                typeof body.stages === 'object' &&
                !Array.isArray(body.stages)
                  ? (body.stages as Record<string, unknown>)
                  : {}
              const stageRoutes: Record<
                string,
                string | { provider: string; model: string }
              > = {}
              for (const stage of ['classify', 'score', 'translate']) {
                const value = stages[stage]
                if (typeof value === 'string' && value.trim()) {
                  stageRoutes[stage] = value.trim()
                  continue
                }
                if (
                  value &&
                  typeof value === 'object' &&
                  !Array.isArray(value)
                ) {
                  const route = value as Record<string, unknown>
                  const stageProvider = normalizeSingleTableProviderId(
                    typeof route.provider === 'string'
                      ? route.provider.trim()
                      : ''
                  )
                  const model =
                    typeof route.model === 'string' ? route.model.trim() : ''
                  if (stageProvider && model)
                    stageRoutes[stage] = { provider: stageProvider, model }
                }
              }
              const routes = [
                { provider, model: defaultModel },
                ...Object.values(stageRoutes).map((route) =>
                  typeof route === 'string' ? { provider, model: route } : route
                ),
              ]
              if (
                !defaultModel ||
                routes.some(
                  (route) =>
                    !listSingleTableModels(route.provider).some(
                      (model) => model.id === route.model
                    )
                )
              )
                return send(response, 400, {
                  error: 'invalid_model',
                  message: '请选择已配置提供商支持的模型。',
                })
              try {
                await validateRoutes(routes)
              } catch (error) {
                return send(response, 409, {
                  error: 'model_preflight_failed',
                  message:
                    error instanceof Error
                      ? error.message
                      : '模型连接测试失败。',
                })
              }
              await saveAnalysisModelConfig(options.configRoot, {
                provider,
                default: defaultModel,
                stages: stageRoutes,
              })
              return send(response, 200, { saved: 'models' })
            }
            const modelProviderMutation =
              /^\/api\/model-providers\/([^/]+)$/u.exec(url.pathname)
            if (method === 'PUT' && modelProviderMutation) {
              const providerId = decodeURIComponent(modelProviderMutation[1]!)
              const definition = listSingleTableModelProviders().find(
                (provider) => provider.id === providerId
              )
              if (!definition)
                return send(response, 404, {
                  error: 'model_provider_not_found',
                })
              const body = await bodyOf(request)
              if (providerId === 'openai-codex') {
                const useDefaultPath = body.useDefaultPath === true
                const requestedPath =
                  typeof body.authPath === 'string' ? body.authPath.trim() : ''
                const authPath = useDefaultPath
                  ? path.join(homedir(), '.codex', 'auth.json')
                  : requestedPath
                if (!authPath || !path.isAbsolute(authPath))
                  return send(response, 400, {
                    error: 'invalid_auth_path',
                    message: '请输入授权文件的绝对路径。',
                  })
                try {
                  const imported =
                    await createReadOnlyCodexCredentialStore(authPath).read(
                      'openai-codex'
                    )
                  if (!imported) throw new Error('Codex credential is missing')
                  await pendingCredentialStore.modify(
                    providerId,
                    async () => imported
                  )
                } catch {
                  return send(response, 400, {
                    error: 'invalid_codex_auth',
                    message: '该文件不是可用的 Codex ChatGPT 授权文件。',
                  })
                }
                await updateFileSecret(
                  secretFile,
                  'CODEX_AUTH_PATH',
                  useDefaultPath ? undefined : authPath
                )
              } else {
                if (!definition.authMethods.includes('api_key'))
                  return send(response, 400, {
                    error: 'api_key_not_supported',
                    message: '该提供商不支持 API Key 配置。',
                  })
                if (body.clearApiKey === true) {
                  await credentialStore.delete(providerId)
                  await pendingCredentialStore.delete(providerId)
                } else if (
                  typeof body.apiKey === 'string' &&
                  body.apiKey.trim()
                ) {
                  const env =
                    body.env &&
                    typeof body.env === 'object' &&
                    !Array.isArray(body.env)
                      ? Object.fromEntries(
                          Object.entries(body.env).flatMap(([name, value]) =>
                            typeof value === 'string' && value.trim()
                              ? [[name, value.trim()]]
                              : []
                          )
                        )
                      : undefined
                  await pendingCredentialStore.modify(providerId, async () => ({
                    type: 'api_key',
                    key: body.apiKey!.toString().trim(),
                    ...(env && Object.keys(env).length ? { env } : {}),
                  }))
                } else
                  return send(response, 400, {
                    error: 'api_key_required',
                    message: '请输入 API Key。',
                  })
              }
              return send(response, 200, {
                saved: providerId,
                providers: await modelProviders(),
              })
            }
            const modelProviderDelete =
              /^\/api\/model-providers\/([^/]+)$/u.exec(url.pathname)
            if (method === 'DELETE' && modelProviderDelete) {
              const providerId = decodeURIComponent(modelProviderDelete[1]!)
              if (
                !listSingleTableModelProviders().some(
                  (provider) => provider.id === providerId
                )
              )
                return send(response, 404, {
                  error: 'model_provider_not_found',
                })
              await credentialStore.delete(providerId)
              await pendingCredentialStore.delete(providerId)
              return send(response, 200, {
                deleted: providerId,
                providers: await modelProviders(),
              })
            }
            const modelProviderTest =
              /^\/api\/model-providers\/([^/]+)\/test$/u.exec(url.pathname)
            if (method === 'POST' && modelProviderTest) {
              const body = await bodyOf(request)
              const providerId = decodeURIComponent(modelProviderTest[1]!)
              const provider = (await modelProviders()).find(
                (item) => item.id === providerId
              )
              if (!provider)
                return send(response, 404, {
                  error: 'model_provider_not_found',
                })
              if (!provider.configured && !provider.pending)
                return send(response, 409, {
                  error: 'model_provider_unconfigured',
                  message: `${provider.name} 凭据尚未配置。`,
                })
              const config = await loadSingleTableConfig(options.configRoot)
              const availableModels = listSingleTableModels(providerId)
              const requestedModel =
                typeof body.modelId === 'string' ? body.modelId.trim() : ''
              const modelId =
                (requestedModel &&
                availableModels.some((model) => model.id === requestedModel)
                  ? requestedModel
                  : undefined) ??
                (normalizeSingleTableProviderId(
                  config.analysis.model.provider
                ) === providerId &&
                availableModels.some(
                  (model) => model.id === config.analysis.model.default
                )
                  ? config.analysis.model.default
                  : availableModels[0]?.id)
              if (!modelId)
                return send(response, 409, {
                  error: 'model_provider_has_no_models',
                  message: `${provider.name} 暂无可测试的模型。`,
                })
              try {
                const result = await testModel(
                  providerId,
                  modelId,
                  provider.pending
                )
                if (provider.pending) {
                  const candidate =
                    await pendingCredentialStore.read(providerId)
                  if (candidate)
                    await credentialStore.modify(
                      providerId,
                      async () => candidate
                    )
                  await pendingCredentialStore.delete(providerId)
                }
                await recordVerified(providerId, modelId, provider.pending)
                return send(response, 200, {
                  ...result,
                  message: `${provider.name} 连通性测试成功，模型 ${modelId} 已响应。`,
                  modelId,
                })
              } catch {
                return send(response, 400, {
                  error: 'model_connection_failed',
                  message: `${provider.name} 连通性测试失败，请检查凭据、额度或网络后重试。`,
                })
              }
            }
            if (method === 'POST' && url.pathname === '/api/sources') {
              const body = await bodyOf(request)
              const source = sourceFromBody(body)
              const config = await loadSingleTableConfig(options.configRoot)
              if (
                config.sources.sources.some(
                  (candidate) => candidate.id === source.id
                )
              )
                return send(response, 409, {
                  error: 'source_id_exists',
                  message: '信源 ID 已存在。',
                })
              await saveSourcesConfig(options.configRoot, [
                ...config.sources.sources,
                source,
              ])
              return send(response, 201, {
                source: sourceItem(source, source.enabled),
              })
            }
            const sourceCrud = /^\/api\/sources\/([^/]+)$/u.exec(url.pathname)
            if (sourceCrud && (method === 'PUT' || method === 'DELETE')) {
              const id = decodeURIComponent(sourceCrud[1]!)
              const config = await loadSingleTableConfig(options.configRoot)
              const index = config.sources.sources.findIndex(
                (candidate) => candidate.id === id
              )
              if (index < 0)
                return send(response, 404, { error: 'source_not_found' })
              const state = await loadSourceState(options.configRoot)
              if (method === 'DELETE') {
                await bodyOf(request)
                await saveSourcesConfig(
                  options.configRoot,
                  config.sources.sources.filter(
                    (candidate) => candidate.id !== id
                  )
                )
                delete state.sources[id]
                await saveSourceState(options.configRoot, state)
                return send(response, 200, { deleted: id })
              }
              const source = sourceFromBody({
                ...(await bodyOf(request)),
                id,
              })
              const next = [...config.sources.sources]
              next[index] = source
              await saveSourcesConfig(options.configRoot, next)
              delete state.sources[id]
              await saveSourceState(options.configRoot, state)
              return send(response, 200, {
                source: sourceItem(source, source.enabled),
              })
            }
            const providerRouteMutation =
              /^\/api\/provider-routes\/([^/]+)$/u.exec(url.pathname)
            if (providerRouteMutation && method === 'PUT') {
              const capability = decodeURIComponent(providerRouteMutation[1]!)
              if (
                !providerRouteDefinitions.some(
                  (definition) => definition.id === capability
                )
              )
                return send(response, 404, {
                  error: 'provider_route_not_found',
                })
              const body = await bodyOf(request)
              const config = await loadSingleTableConfig(options.configRoot)
              const routes = providerRoutesSchema.parse({
                ...config.providers.routes,
                [capability]: body.providers,
              })
              await saveProvidersConfig(options.configRoot, { routes })
              return send(response, 200, {
                saved: capability,
                providers: routes[capability as keyof typeof routes],
              })
            }
            const providerMutation = /^\/api\/providers\/([^/]+)$/u.exec(
              url.pathname
            )
            if (providerMutation && method === 'PUT') {
              const id = decodeURIComponent(providerMutation[1]!)
              const definition = providerDefinitions.find(
                (provider) => provider.id === id
              )
              if (!definition)
                return send(response, 404, { error: 'provider_not_found' })
              const body = await bodyOf(request)
              if ('secretName' in definition) {
                if (typeof body.secret === 'string' && body.secret.trim())
                  await updateFileSecret(
                    options.secretFile ?? path.join(options.dataRoot, '.env'),
                    definition.secretName,
                    body.secret.trim()
                  )
                if (body.clearSecret === true)
                  await updateFileSecret(
                    options.secretFile ?? path.join(options.dataRoot, '.env'),
                    definition.secretName,
                    undefined
                  )
              }
              return send(response, 200, { saved: id })
            }
            const providerTest = /^\/api\/providers\/([^/]+)\/test$/u.exec(
              url.pathname
            )
            if (providerTest && method === 'POST') {
              await bodyOf(request)
              const id = decodeURIComponent(providerTest[1]!)
              const definition = providerDefinitions.find(
                (provider) => provider.id === id
              )
              if (!definition)
                return send(response, 404, { error: 'provider_not_found' })
              const config = await loadSingleTableConfig(options.configRoot)
              const source = config.sources.sources.find(
                (candidate) => candidate.platform === definition.sourceType
              )
              if (!source)
                return send(response, 409, {
                  error: 'provider_has_no_source',
                  message: '请先为这个平台添加一个信源。',
                })
              const reader = createFileSecretReader(
                options.secretFile ?? path.join(options.dataRoot, '.env')
              )
              const credential = async (name: string) =>
                reader.get(name).catch((error: unknown) => {
                  if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                    return undefined
                  throw error
                })
              try {
                const provider = createSingleTableSourceProvider({
                  tikHubToken: await credential('TIKHUB_API_KEY'),
                  twitterApiKey: await credential('TWITTERAPI_IO_KEY'),
                  youtubeApiKey: await credential('YOUTUBE_API_KEY'),
                  fetch: options.providerFetch,
                  providerRoutes:
                    definition.sourceType === 'x'
                      ? { x_list: [id as 'twitterapi.io' | 'tikhub-x'] }
                      : definition.sourceType === 'youtube'
                        ? {
                            youtube_list: [
                              id as 'youtube-data-api' | 'tikhub-youtube',
                            ],
                          }
                        : undefined,
                })
                const page = await provider.discover(source, 3)
                return send(response, 200, {
                  status: 'succeeded',
                  providerId: page.providerId,
                  items: page.items.map((item) => ({
                    title: item.title,
                    url: item.url,
                  })),
                })
              } catch (error) {
                return send(response, 502, {
                  status: 'failed',
                  message:
                    error instanceof Error ? error.message : '远端连接失败。',
                })
              }
            }
            const configMutation = /^\/api\/config\/files\/([^/]+)$/u.exec(
              url.pathname
            )
            if (configMutation && method === 'PUT') {
              const name = decodeURIComponent(configMutation[1]!)
              if (
                !editableConfigFileNames.includes(
                  name as (typeof editableConfigFileNames)[number]
                )
              )
                return send(response, 404, { error: 'config_not_found' })
              const body = await bodyOf(request)
              if (typeof body.content !== 'string')
                return send(response, 400, {
                  error: 'config_content_required',
                })
              await saveEditableConfigFile(
                options.configRoot,
                name as (typeof editableConfigFileNames)[number],
                body.content
              )
              return send(response, 200, { saved: name })
            }
            const sourceMatch = /^\/api\/sources\/([^/]+)\/status$/u.exec(
              url.pathname
            )
            if (sourceMatch) {
              const id = decodeURIComponent(sourceMatch[1]!)
              const body = await bodyOf(request)
              if (body.status !== 'enabled' && body.status !== 'disabled')
                return send(response, 400, {
                  error: 'Only enabled and disabled are supported in file mode',
                })
              const config = await loadSingleTableConfig(options.configRoot)
              const source = config.sources.sources.find(
                (candidate) => candidate.id === id
              )
              if (!source)
                return send(response, 404, { error: 'source_not_found' })
              const state = await loadSourceState(options.configRoot)
              state.sources[id] = {
                ...state.sources[id],
                enabled_override: body.status === 'enabled',
              }
              await saveSourceState(options.configRoot, state)
              return send(response, 200, {
                source: {
                  id,
                  name: source.account_name,
                  type: source.platform,
                  externalIdentity: source.external_identity,
                  language: source.language,
                  status: body.status,
                },
              })
            }
            const sourceTest = /^\/api\/sources\/([^/]+)\/test-fetch$/u.exec(
              url.pathname
            )
            if (sourceTest) {
              await bodyOf(request)
              const id = decodeURIComponent(sourceTest[1]!)
              const config = await loadSingleTableConfig(options.configRoot)
              const source = config.sources.sources.find(
                (candidate) => candidate.id === id
              )
              if (!source)
                return send(response, 404, { error: 'source_not_found' })
              const reader = createFileSecretReader(
                options.secretFile ?? path.join(options.dataRoot, '.env')
              )
              const credential = async (name: string) => {
                try {
                  return await reader.get(name)
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                    return undefined
                  throw error
                }
              }
              const provider = createSingleTableSourceProvider({
                tikHubToken: await credential('TIKHUB_API_KEY'),
                twitterApiKey: await credential('TWITTERAPI_IO_KEY'),
                youtubeApiKey: await credential('YOUTUBE_API_KEY'),
                fetch: options.providerFetch,
                providerRoutes: config.providers.routes,
              })
              try {
                const page = await provider.discover(source, 3)
                return send(response, 200, {
                  status: 'succeeded',
                  providerId: page.providerId,
                  items: page.items.map((item) => ({
                    title: item.title,
                    url: item.url,
                    publishedAt: item.publishedAt,
                  })),
                })
              } catch {
                return send(response, 502, {
                  status: 'failed',
                  message: '远端试抓失败，请检查凭据、余额和供应商状态。',
                })
              }
            }
            if (url.pathname === '/api/contents/batch') {
              const body = await bodyOf(request)
              if (
                !Array.isArray(body.ids) ||
                body.ids.length === 0 ||
                body.ids.length > 100 ||
                body.ids.some((id) => typeof id !== 'string')
              )
                return send(response, 400, { error: 'invalid_content_ids' })
              if (
                body.operation !== 'mark-read' &&
                body.operation !== 'mark-unread'
              )
                return send(response, 400, {
                  error: 'unsupported_batch_operation',
                })
              for (const id of body.ids)
                activeRepository.setRead(
                  String(id),
                  body.operation === 'mark-read'
                )
              return send(response, 200, { updated: body.ids.length })
            }
            const translateMatch =
              /^\/api\/contents\/([^/]+)\/translate$/u.exec(url.pathname)
            if (translateMatch) {
              await bodyOf(request)
              const id = decodeURIComponent(translateMatch[1]!)
              const row = activeRepository.getById(id)
              if (!row)
                return send(response, 404, { error: 'content_not_found' })
              if (translating.has(id))
                return send(response, 409, {
                  error: 'translation_already_running',
                })
              if (row.translated_to_chinese)
                return send(response, 200, {
                  item: await feedItem(
                    activeRepository,
                    row,
                    (await loadSingleTableConfig(options.configRoot)).sources
                      .sources
                  ),
                })
              if (
                row.original_language !== 'en' ||
                row.is_junk ||
                row.process_status !== 'completed'
              )
                return send(response, 409, {
                  error: 'content_not_translatable',
                })
              const body = await activeRepository.readBody(id, 'en')
              if (!body)
                return send(response, 409, { error: 'english_body_missing' })
              const config = await loadSingleTableConfig(options.configRoot)
              const gateway =
                options.gateway ??
                createSingleTableModelGateway(
                  credentialStore,
                  config.analysis.model.provider,
                  config.analysis.model
                )
              const original: import('@qiushuiai-airadar/runtime').OriginalContent =
                {
                  platform: String(row.source_platform),
                  sourceType: String(row.source_type),
                  sourceAccountId: String(row.source_account_id),
                  sourceAccountName: String(row.source_account_name),
                  externalContentId: row.external_content_id as
                    string | undefined,
                  canonicalUrl: row.canonical_url as string | undefined,
                  title: row.title,
                  originalTitle: row.original_title ?? undefined,
                  body,
                  kind: row.content_kind,
                  format:
                    row.original_format as import('@qiushuiai-airadar/runtime').OriginalContent['format'],
                  language: 'en',
                  videoDurationSeconds:
                    typeof row.video_duration_seconds === 'number'
                      ? row.video_duration_seconds
                      : undefined,
                  publishedAt: row.published_at as string | undefined,
                }
              translating.add(id)
              const translationTask = translateSingleTableContent({
                repository: activeRepository,
                gateway,
                promptsRoot:
                  options.promptsRoot ??
                  path.resolve(
                    import.meta.dirname,
                    '../../../docs/prompts/single-table-content'
                  ),
                original,
                row,
                manual: true,
                profile: config.profile,
                profileVersion: String(config.profile.version),
                scoring: {
                  weights: config.analysis.scoring.weights,
                  coreThreshold: config.analysis.scoring.core_threshold,
                  exploreThreshold: config.analysis.scoring.explore_threshold,
                  coreMinLevels: config.analysis.scoring.core_min_levels,
                  exploreMinLevels: config.analysis.scoring.explore_min_levels,
                },
                longContentMinChars:
                  config.analysis.summarization.long_content_min_chars,
                translationMinimumTotalScore:
                  config.analysis.translation.minimum_total_score,
              })
                .catch(() => undefined)
                .finally(() => {
                  translating.delete(id)
                  translationTasks.delete(translationTask)
                })
              translationTasks.add(translationTask)
              return send(response, 202, { taskId: id })
            }
            const retryMatch = /^\/api\/contents\/([^/]+)\/retry$/u.exec(
              url.pathname
            )
            if (retryMatch) {
              const retryInput = await bodyOf(request)
              const id = decodeURIComponent(retryMatch[1]!)
              const row = activeRepository.getById(id)
              if (!row)
                return send(response, 404, { error: 'content_not_found' })
              if (retrying.has(id))
                return send(response, 409, { error: 'retry_already_running' })
              if (
                row.process_status !== 'failed' &&
                row.process_status !== 'waiting-manual-transcription'
              )
                return send(response, 409, { error: 'content_not_retryable' })
              if (
                !options.gateway &&
                request.headers['x-model-retry-batch'] !== activeBatch?.id
              ) {
                try {
                  await validateRoutes(await configuredRoutes())
                } catch (error) {
                  return send(response, 409, {
                    error: 'model_preflight_failed',
                    message:
                      error instanceof Error
                        ? error.message
                        : '模型连接测试失败。',
                  })
                }
              }
              retrying.add(id)
              try {
                const config = await loadSingleTableConfig(options.configRoot)
                const source = config.sources.sources.find(
                  (item) => item.id === row.source_account_id
                )
                if (!source)
                  return send(response, 409, { error: 'source_not_configured' })
                const nonArticleReason =
                  row.source_platform === 'x' &&
                  row.content_kind === 'article' &&
                  row.canonical_url
                    ? classifyNonArticlePage(String(row.canonical_url))
                    : undefined
                if (nonArticleReason) {
                  const excluded = await activeRepository.setRuleJunk(
                    id,
                    nonArticleReason
                  )
                  return send(response, 200, {
                    item: await feedItem(
                      activeRepository,
                      excluded,
                      config.sources.sources
                    ),
                  })
                }
                const reader = createFileSecretReader(
                  options.secretFile ?? path.join(options.dataRoot, '.env')
                )
                const credential = async (name: string) => {
                  try {
                    return await reader.get(name)
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                      return undefined
                    throw error
                  }
                }
                const provider = createSingleTableSourceProvider({
                  tikHubToken: await credential('TIKHUB_API_KEY'),
                  twitterApiKey: await credential('TWITTERAPI_IO_KEY'),
                  youtubeApiKey: await credential('YOUTUBE_API_KEY'),
                  fetch: options.providerFetch,
                  providerRoutes: config.providers.routes,
                  xVideoTranscriber: config.analysis.transcription.auto
                    ? (url) => transcribeXVideo(options.dataRoot, url)
                    : undefined,
                })
                const originalBody = await activeRepository.readBody(
                  id,
                  row.original_language === 'zh' ? 'zh' : 'en'
                )
                let original: import('@qiushuiai-airadar/runtime').OriginalContent
                let capturedCalls: import('@qiushuiai-airadar/runtime').LogEvent[] =
                  []
                const suppliedTranscript =
                  typeof retryInput.transcript === 'string'
                    ? retryInput.transcript.trim()
                    : ''
                if (suppliedTranscript) {
                  if (
                    row.process_status !== 'waiting-manual-transcription' ||
                    row.content_kind !== 'video' ||
                    suppliedTranscript.length < 20
                  )
                    return send(response, 400, {
                      error: 'invalid_transcript',
                    })
                  original = {
                    platform: String(row.source_platform),
                    sourceType: String(row.source_type),
                    sourceAccountId: String(row.source_account_id),
                    sourceAccountName: String(row.source_account_name),
                    externalContentId: row.external_content_id as
                      string | undefined,
                    canonicalUrl: row.canonical_url as string | undefined,
                    title: row.title,
                    originalTitle: row.original_title ?? undefined,
                    body: suppliedTranscript,
                    kind: 'video',
                    format: 'subtitle',
                    language: row.original_language === 'zh' ? 'zh' : 'en',
                    publishedAt: row.published_at as string | undefined,
                  }
                  capturedCalls = [
                    {
                      action: 'manual-transcription',
                      stage: 'enriching',
                      status: 'succeeded',
                      trigger: 'manual-retry',
                      request: { contentId: id },
                      response: { characters: suppliedTranscript.length },
                    },
                  ]
                } else if (
                  config.analysis.transcription.auto &&
                  row.process_status === 'waiting-manual-transcription' &&
                  row.source_platform === 'x' &&
                  row.content_kind === 'video' &&
                  row.canonical_url
                ) {
                  const transcript = await transcribeXVideo(
                    options.dataRoot,
                    String(row.canonical_url)
                  )
                  original = {
                    platform: 'x',
                    sourceType: String(row.source_type),
                    sourceAccountId: String(row.source_account_id),
                    sourceAccountName: String(row.source_account_name),
                    externalContentId: row.external_content_id as
                      string | undefined,
                    canonicalUrl: String(row.canonical_url),
                    title: row.title,
                    originalTitle: row.original_title ?? undefined,
                    body: transcript,
                    kind: 'video',
                    format: 'subtitle',
                    language: row.original_language === 'zh' ? 'zh' : 'en',
                    publishedAt: row.published_at as string | undefined,
                  }
                } else if (originalBody) {
                  original = {
                    platform: String(row.source_platform),
                    sourceType: String(row.source_type),
                    sourceAccountId: String(row.source_account_id),
                    sourceAccountName: String(row.source_account_name),
                    externalContentId: row.external_content_id as
                      string | undefined,
                    canonicalUrl: row.canonical_url as string | undefined,
                    title: row.title,
                    originalTitle: row.original_title ?? undefined,
                    body: originalBody,
                    kind: row.content_kind,
                    format:
                      row.original_format as import('@qiushuiai-airadar/runtime').OriginalContent['format'],
                    language: row.original_language === 'zh' ? 'zh' : 'en',
                    videoDurationSeconds:
                      typeof row.video_duration_seconds === 'number'
                        ? row.video_duration_seconds
                        : undefined,
                    publishedAt: row.published_at as string | undefined,
                  }
                } else {
                  let youtubeVideo = false
                  if (
                    row.process_status === 'waiting-manual-transcription' &&
                    row.source_platform === 'x' &&
                    row.content_kind === 'video' &&
                    row.canonical_url
                  ) {
                    try {
                      normalizeYouTubeIdentity(String(row.canonical_url))
                      youtubeVideo = true
                    } catch {
                      // Native X videos need the source discovery path.
                    }
                  }
                  if (youtubeVideo) {
                    const resolved = await provider.resolve(source, {
                      externalId: String(row.external_content_id ?? ''),
                      url: String(row.canonical_url),
                      title: row.title,
                      kind: 'video',
                    })
                    original = resolved.original
                    capturedCalls = resolved.calls ?? []
                  } else {
                    const page = await provider.discover(source)
                    const item = page.items.find(
                      (candidate) =>
                        candidate.externalId === row.external_content_id ||
                        candidate.url === row.canonical_url
                    )
                    if (!item)
                      return send(response, 409, {
                        error: 'original_not_in_current_source_page',
                      })
                    const resolved = await provider.resolve(source, item)
                    original = resolved.original
                    capturedCalls = [
                      {
                        action: 'discover',
                        stage: 'discovered',
                        status: 'succeeded',
                        trigger: 'manual-retry',
                        request: page.request,
                        response: page.response,
                      },
                      ...(resolved.calls ?? []).map((call) => ({
                        ...call,
                        trigger: 'manual-retry' as const,
                      })),
                    ]
                  }
                }
                await activeRepository.appendLog(id, {
                  action: 'manual-retry',
                  stage: 'discovered',
                  status: 'succeeded',
                  trigger: 'manual-retry',
                  request: { contentId: id },
                  response: { accepted: true },
                })
                const gateway =
                  options.gateway ??
                  createSingleTableModelGateway(
                    credentialStore,
                    config.analysis.model.provider,
                    config.analysis.model
                  )
                const completed = await processSingleTableContent({
                  repository: activeRepository,
                  gateway,
                  promptsRoot:
                    options.promptsRoot ??
                    path.resolve(
                      import.meta.dirname,
                      '../../../docs/prompts/single-table-content'
                    ),
                  original,
                  capturedCalls,
                  profile: config.profile,
                  profileVersion: String(config.profile.version),
                  scoring: {
                    weights: config.analysis.scoring.weights,
                    coreThreshold: config.analysis.scoring.core_threshold,
                    exploreThreshold: config.analysis.scoring.explore_threshold,
                    coreMinLevels: config.analysis.scoring.core_min_levels,
                    exploreMinLevels:
                      config.analysis.scoring.explore_min_levels,
                  },
                  longContentMinChars:
                    config.analysis.summarization.long_content_min_chars,
                  translationMinimumTotalScore:
                    config.analysis.translation.minimum_total_score,
                  automaticTranslationLimits: {
                    maximumVideoDurationSeconds:
                      config.analysis.translation
                        .automatic_video_max_duration_seconds,
                    maximumSourceCharacters:
                      config.analysis.translation
                        .automatic_max_source_characters,
                  },
                })
                return send(response, 200, {
                  item: await feedItem(
                    activeRepository,
                    completed,
                    config.sources.sources
                  ),
                })
              } catch {
                return send(response, 502, {
                  error: 'manual_retry_failed',
                  message: '重试失败，详情见该内容的执行日志。',
                })
              } finally {
                retrying.delete(id)
              }
            }
            const match =
              /^\/api\/contents\/([^/]+)\/(read|actions|junk)$/u.exec(
                url.pathname
              )
            if (match) {
              const id = decodeURIComponent(match[1]!)
              const body = await bodyOf(request)
              if (match[2] === 'read')
                activeRepository.setRead(id, body.read === true)
              if (match[2] === 'actions') {
                const allowed = new Set([
                  'favorite',
                  'card',
                  'video',
                  'article',
                  'project',
                ])
                if (
                  !Array.isArray(body.actions) ||
                  body.actions.some((action) => !allowed.has(String(action)))
                )
                  throw new Error('Invalid utilization action')
                activeRepository.setUtilizationActions(
                  id,
                  body.actions as Array<
                    'favorite' | 'card' | 'video' | 'article' | 'project'
                  >
                )
              }
              if (match[2] === 'junk')
                await activeRepository.setManualJunk(
                  id,
                  body.isJunk === true,
                  typeof body.reason === 'string' ? body.reason : undefined,
                  typeof body.note === 'string' ? body.note : undefined
                )
              const config = await loadSingleTableConfig(options.configRoot)
              return send(response, 200, {
                item: await feedItem(
                  activeRepository,
                  activeRepository.getById(id)!,
                  config.sources.sources
                ),
              })
            }
          }
          if (
            options.webRoot &&
            (method === 'GET' || method === 'HEAD') &&
            !url.pathname.startsWith('/api/')
          ) {
            const root = path.resolve(options.webRoot)
            const requested = path.resolve(
              root,
              `.${decodeURIComponent(url.pathname)}`
            )
            if (
              !requested.startsWith(`${root}${path.sep}`) &&
              requested !== root
            )
              return send(response, 403, { error: 'forbidden' })
            const extension = path.extname(requested)
            const file = extension ? requested : path.join(root, 'index.html')
            try {
              const body = await readFile(file)
              const types: Record<string, string> = {
                '.html': 'text/html; charset=utf-8',
                '.js': 'text/javascript',
                '.css': 'text/css',
                '.svg': 'image/svg+xml',
                '.png': 'image/png',
                '.ico': 'image/x-icon',
                '.woff2': 'font/woff2',
              }
              response.writeHead(200, {
                'content-type':
                  types[path.extname(file)] ?? 'application/octet-stream',
                'x-content-type-options': 'nosniff',
                'cache-control': 'no-cache',
              })
              response.end(method === 'HEAD' ? undefined : body)
              return
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error
            }
          }
          return send(response, 404, { error: 'not_found' })
        })().catch((error: unknown) => {
          if (!response.headersSent)
            send(response, 400, {
              error: 'request_failed',
              message:
                error instanceof Error ? error.message : '请求处理失败。',
            })
          else response.end()
        })
      })
      try {
        await new Promise<void>((resolve, reject) => {
          server?.once('error', reject)
          server?.listen(address.port, address.host, resolve)
        })
      } catch (error) {
        server = undefined
        repository.close()
        repository = undefined
        throw error
      }
      const bound = server.address()
      if (!bound || typeof bound === 'string')
        throw new Error('Invalid listen address')
      return { host: address.host, port: bound.port }
    },
    async stop() {
      logins.stop()
      if ((await readCollectionRun(options.dataRoot))?.status === 'paused')
        collectionControl?.interrupt()
      if (activeBatch?.status === 'running') {
        activeBatch.status = 'paused'
        activeBatch.message = '服务已停止，请重新验证模型后继续。'
        await saveBatch(activeBatch)
      }
      const current = server
      server = undefined
      if (current)
        await new Promise<void>((resolve) => current.close(() => resolve()))
      await collection
      await batchWorker
      await Promise.allSettled([...translationTasks])
      repository?.close()
      repository = undefined
    },
  }
}
