export { collectSingleTable } from './collect-single-table.js'
export { createSingleTableServiceApp } from './single-table-service.js'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'

import {
  RuntimeRepository,
  type ContentListRecord,
  runPendingTasks,
  type ContentUserState,
  type JunkReason,
  type ManagedSource,
  type ParameterScope,
  type RuntimeTask,
  type UtilizationAction,
  validateRuntimeParameters,
} from '@qiushui-airadar/runtime'
import {
  analyzeStoredContent,
  createCodexPiGateway,
  detectOriginalLanguage,
  enrichArticle,
  enrichImagePostContent,
  enrichPlatformVideoContent,
  enrichYouTubeContent,
  runPlatformDiscovery,
  runRssDiscovery,
} from '@qiushui-airadar/pipeline'
import {
  classifyNonArticlePage,
  createGetBijiDouyinProvider,
  createGetBijiDouyinTranscriber,
  createProviderRouter,
  createTikHubDouyinProvider,
  createTikHubWechatChannelsProvider,
  createTikHubXiaohongshuDetailProvider,
  createTikHubXiaohongshuProvider,
  createTikHubXProvider,
  createTikHubYouTubeProvider,
  createTikHubYouTubeTranscriptProvider,
  createTwitterApiIoProvider,
  fetchTwitterApiIoArticle,
  isXArticleUrl,
  createYouTubeDataApiProvider,
  type CaptureProviderResponse,
  type SourceAdapter,
  type VideoTranscriber,
} from '@qiushui-airadar/source-adapters'

import { initialSources, retiredSourceIds } from './source-seeds.js'

type Recommendation = 'core' | 'explore' | 'none'
type ContentKind = 'short_post' | 'video' | 'image_post' | 'article'

interface FeedItem {
  id: string
  title: string
  chineseTitle?: string
  url?: string
  publishedAt?: string
  discoveredAt?: string
  firstInflowAt?: string
  body: string
  summary: string
  originalLanguage: 'zh' | 'en' | 'unknown'
  chineseTranslation?: string
  translatedToChinese: boolean
  topics: string[]
  scores: Record<string, unknown>
  totalScore: number
  recommendation: Recommendation
  analyzedAt?: string
  kind?: ContentKind
  source?: { id: string; name: string; type: string; language: 'en' | 'zh' }
  images?: Array<{ order?: number; url: string }>
  quotedPost?: {
    url: string
    authorName?: string
    authorHandle?: string
    text: string
    images: Array<{ order?: number; url: string }>
  }
  repostedBy?: { name: string; handle?: string; url: string }
  video?: {
    durationSeconds?: number
    thumbnailUrl?: string
    mediaUrl?: string
  }
  processStatus:
    'processing' | 'completed' | 'failed' | 'waiting-manual-transcription'
  originalStatus?: unknown
  read: boolean
  utilizationActions: UtilizationAction[]
  junk: {
    isJunk: boolean
    source: 'ai' | 'manual' | 'rule' | 'none'
    reason?: string
    note?: string
  }
  evidence?: unknown
  interaction?: {
    capturedAt: string
    views: number | null
    likes: number | null
    comments: number | null
    shares: number | null
    saves: number | null
  }
  analysis?: {
    provider: string
    model: string
    profileVersionId: string
    ruleVersion: string
  }
}

function safeMediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? value
      : undefined
  } catch {
    return undefined
  }
}

function contentImages(value: unknown): FeedItem['images'] {
  if (!Array.isArray(value)) return undefined
  const images = value.flatMap((entry) => {
    const record = asRecord(entry)
    const url = safeMediaUrl(record.url)
    if (!url) return []
    return [
      {
        ...(typeof record.order === 'number' ? { order: record.order } : {}),
        url,
      },
    ]
  })
  return images.length ? images : undefined
}

function contentVideo(value: unknown): FeedItem['video'] {
  const record = asRecord(value)
  const durationSeconds =
    typeof record.durationSeconds === 'number'
      ? record.durationSeconds
      : undefined
  const thumbnailUrl = safeMediaUrl(
    record.thumbnailUrl ?? record.coverUrl ?? record.thumbnail
  )
  const mediaUrl = safeMediaUrl(record.mediaUrl ?? record.url)
  if (
    durationSeconds === undefined &&
    thumbnailUrl === undefined &&
    mediaUrl === undefined
  )
    return undefined
  return { durationSeconds, thumbnailUrl, mediaUrl }
}

interface ProviderDefinition {
  id: string
  name: string
  sourceType: ManagedSource['type']
  priority: number
  secretEnv?: string
}

const providerDefinitions: ProviderDefinition[] = [
  {
    id: 'twitterapi.io',
    name: 'TwitterAPI.io',
    sourceType: 'x',
    priority: 1,
    secretEnv: 'TWITTERAPI_IO_KEY',
  },
  {
    id: 'tikhub-x',
    name: 'TikHub',
    sourceType: 'x',
    priority: 2,
    secretEnv: 'TIKHUB_API_KEY',
  },
  {
    id: 'youtube-data-api',
    name: 'Google Data API',
    sourceType: 'youtube',
    priority: 1,
    secretEnv: 'YOUTUBE_API_KEY',
  },
  {
    id: 'tikhub-youtube',
    name: 'TikHub',
    sourceType: 'youtube',
    priority: 2,
    secretEnv: 'TIKHUB_API_KEY',
  },
  {
    id: 'native-rss',
    name: '原生 RSS',
    sourceType: 'rss',
    priority: 1,
  },
  {
    id: 'tikhub-douyin',
    name: 'TikHub',
    sourceType: 'douyin',
    priority: 1,
    secretEnv: 'TIKHUB_API_KEY',
  },
  {
    id: 'getbiji-douyin',
    name: 'Get笔记',
    sourceType: 'douyin',
    priority: 2,
    secretEnv: 'GETBIJI_API_KEY',
  },
  {
    id: 'tikhub-wechat-channels',
    name: 'TikHub',
    sourceType: 'wechat_channels',
    priority: 1,
    secretEnv: 'TIKHUB_API_KEY',
  },
  {
    id: 'tikhub-xiaohongshu',
    name: 'TikHub',
    sourceType: 'xiaohongshu',
    priority: 1,
    secretEnv: 'TIKHUB_API_KEY',
  },
]

const fixedRules = [
  '平台内容身份不可修改',
  '一条内容只能有一种内容形态',
  '补全完整后才能分析',
  '正文首次成功后冻结',
  '缺失互动数据保存为空',
  '归档信源保留历史关系',
  'X 主载体顺序固定',
]

const defaultParameters = {
  collection: {
    schedule: '0 8 * * *',
    batchLimit: 100,
    initialLookbackDays: 7,
    initialLimit: 20,
    retryLimit: 3,
    providerCooldownMinutes: 30,
  },
  transcription: { auto: false, maximumMinutes: 120 },
  storage: { rawResponseRetentionDays: 30 },
  profile: {
    background: '20+ 年技术、产品、方案与销售经验',
    interests: ['人工智能产品', '智能体', '开发工具', '内容生产', '企业落地'],
    exclusions: [],
  },
  scoring: {
    weights: {
      topicMatch: 20,
      substance: 15,
      credibility: 15,
      novelty: 10,
      actionability: 15,
      workValue: 15,
      clarity: 10,
    },
    coreThreshold: 80,
    exploreThreshold: 60,
  },
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function contentKind(value: unknown): ContentKind | undefined {
  return value === 'short_post' ||
    value === 'video' ||
    value === 'image_post' ||
    value === 'article'
    ? value
    : undefined
}

function recommendation(value: unknown): Recommendation {
  return value === 'core' || value === 'explore' ? value : 'none'
}

function maskSecret(value: string): string {
  if (value.length <= 4) return '•'.repeat(value.length)
  return `${value.slice(0, 2)}${'•'.repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`
}

function effectiveJunk(
  state: Pick<ContentUserState, 'manualJunk'> | undefined,
  analysisResult: Record<string, unknown>,
  content?: { kind?: unknown; canonicalUrl?: string }
): FeedItem['junk'] {
  if (state?.manualJunk) {
    return {
      isJunk: state.manualJunk.isJunk,
      source: 'manual',
      reason: state.manualJunk.reason,
      note: state.manualJunk.note,
    }
  }
  const nonArticleReason =
    content?.kind === 'article' && content.canonicalUrl
      ? classifyNonArticlePage(content.canonicalUrl)
      : undefined
  if (nonArticleReason) {
    return {
      isJunk: true,
      source: 'rule',
      reason: 'other',
      note: nonArticleReason,
    }
  }
  const spam = asRecord(analysisResult.spam)
  return spam.isSpam === true
    ? {
        isJunk: true,
        source: 'ai',
        reason: typeof spam.reason === 'string' ? spam.reason : undefined,
      }
    : { isJunk: false, source: 'none' }
}

const acceptanceSourceAliases: Record<string, string> = {
  'accept-x-openai': 'x_openai',
  'accept-x-ycombinator': 'x_ycombinator',
  'accept-youtube-openai': 'yt_openai',
  'accept-youtube-ycombinator': 'yt_ycombinator',
  'accept-douyin-jiang': 'douyin_qinghua_jiang',
  'accept-wechat-zhangzhang': 'wechat_zhangzhang_ai',
  'accept-xiaohongshu-wendy': 'xhs_itechtokai',
}

const retiredSourceNames: Record<string, string> = {
  douyin_qinghua_jiang: '抖音 / 清华姜学长',
  wechat_zhangzhang_ai: '视频号 / 张张AI视界',
  xhs_itechtokai: '小红书 / iTechTokAI',
}

function contentItems(repository: RuntimeRepository): FeedItem[] {
  return repository
    .listContentList()
    .map(contentListItem)
    .sort((left, right) =>
      (
        right.analyzedAt ??
        right.publishedAt ??
        right.discoveredAt ??
        ''
      ).localeCompare(
        left.analyzedAt ?? left.publishedAt ?? left.discoveredAt ?? ''
      )
    )
}

function contentListItem(content: ContentListRecord): FeedItem {
  const analysis = content.analysis
  const result = asRecord(analysis?.result)
  const sourceId = content.sourceId
    ? (acceptanceSourceAliases[content.sourceId] ?? content.sourceId)
    : undefined
  const source = content.source
  const detectedLanguage = detectOriginalLanguage(content.bodyPreview)
  const originalLanguage =
    detectedLanguage === 'unknown'
      ? (source?.language ?? 'unknown')
      : detectedLanguage
  const chineseTranslation = content.chinesePreview
  const state = content.state
  const junk = effectiveJunk(state, result, content)
  const latestInteraction = content.interaction
  return {
    id: content.id,
    title: content.title,
    chineseTitle:
      !junk.isJunk && typeof result.chineseTitle === 'string'
        ? result.chineseTitle.trim() || undefined
        : undefined,
    url: content.canonicalUrl,
    publishedAt: content.publishedAt,
    discoveredAt: content.discoveredAt,
    firstInflowAt: content.firstInflowAt,
    body: content.bodyPreview,
    originalLanguage,
    chineseTranslation: !junk.isJunk ? chineseTranslation : undefined,
    translatedToChinese:
      !junk.isJunk && originalLanguage === 'en' && Boolean(chineseTranslation),
    summary:
      typeof result.summary === 'string'
        ? result.summary
        : content.bodyPreview || content.enrichmentError || '等待处理',
    topics: Array.isArray(result.topics)
      ? result.topics.filter(
          (topic): topic is string => typeof topic === 'string'
        )
      : [],
    scores: asRecord(result.scores),
    totalScore: typeof result.totalScore === 'number' ? result.totalScore : 0,
    recommendation: recommendation(result.recommendation),
    analyzedAt: analysis?.createdAt,
    kind: contentKind(content.kind),
    images: contentImages(content.images),
    quotedPost: (() => {
      const quote = asRecord(content.quotedPost)
      const url = safeMediaUrl(quote.url)
      if (!url) return undefined
      return {
        url,
        authorName:
          typeof quote.authorName === 'string' ? quote.authorName : undefined,
        authorHandle:
          typeof quote.authorHandle === 'string'
            ? quote.authorHandle
            : undefined,
        text: typeof quote.text === 'string' ? quote.text : '',
        images: contentImages(quote.images) ?? [],
      }
    })(),
    repostedBy: (() => {
      const repost = asRecord(content.repostedBy)
      const url = safeMediaUrl(repost.url)
      if (!url) return undefined
      return {
        url,
        name: typeof repost.name === 'string' ? repost.name : 'X 用户',
        handle: typeof repost.handle === 'string' ? repost.handle : undefined,
      }
    })(),
    video: contentVideo(content.video),
    source: source
      ? {
          id: source.id,
          name: source.name,
          type: source.type,
          language: source.language,
        }
      : content.sourceId
        ? {
            id: content.sourceId,
            name:
              retiredSourceNames[sourceId ?? ''] ??
              content.sourceId.replace(/^accept-/u, '').replaceAll('-', ' / '),
            type: content.id.split(':')[0] ?? 'unknown',
            language: 'en',
          }
        : undefined,
    processStatus: content.processStatus,
    originalStatus: content.originalStatus,
    read: state?.read ?? false,
    utilizationActions: junk.isJunk ? [] : (state?.utilizationActions ?? []),
    junk,
    evidence: undefined,
    interaction: latestInteraction
      ? {
          capturedAt: latestInteraction.capturedAt,
          views: latestInteraction.views,
          likes: latestInteraction.likes,
          comments: latestInteraction.comments,
          shares: latestInteraction.shares,
          saves: latestInteraction.saves,
        }
      : undefined,
    analysis: analysis
      ? {
          provider: analysis.provider,
          model: analysis.model,
          profileVersionId: analysis.profileVersionId,
          ruleVersion: analysis.ruleVersion,
        }
      : undefined,
  }
}

function allowLocalWebOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined
  try {
    const url = new URL(origin)
    const configured = new Set(
      (process.env.QIUSHUI_AIRADAR_WEB_ORIGINS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    )
    return configured.has(origin) ||
      (url.protocol === 'http:' &&
        (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))
      ? origin
      : undefined
  } catch {
    return undefined
  }
}

async function readJson(
  request: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 64 * 1024) throw new Error('Request body is too large')
    chunks.push(bytes)
  }
  if (!chunks.length) return {}
  return asRecord(JSON.parse(Buffer.concat(chunks).toString('utf8')))
}

function send(
  response: ServerResponse,
  status: number,
  payload: unknown
): void {
  response.statusCode = status
  response.end(JSON.stringify(payload))
}

function parseScope(value: unknown): ParameterScope {
  const scope = asRecord(value)
  if (scope.level === 'global') return { level: 'global' }
  if (
    scope.level === 'sourceType' &&
    [
      'x',
      'youtube',
      'rss',
      'douyin',
      'wechat_channels',
      'xiaohongshu',
    ].includes(String(scope.sourceType))
  ) {
    return {
      level: 'sourceType',
      sourceType: scope.sourceType as ManagedSource['type'],
    }
  }
  if (scope.level === 'source' && typeof scope.sourceId === 'string') {
    return { level: 'source', sourceId: scope.sourceId }
  }
  throw new Error('Invalid parameter scope')
}

function affectedSourceCount(
  repository: RuntimeRepository,
  scope: ParameterScope
): number {
  if (scope.level === 'global') return repository.listSources().length
  if (scope.level === 'sourceType') {
    return repository
      .listSources()
      .filter((source) => source.type === scope.sourceType).length
  }
  return repository.getSource(scope.sourceId) ? 1 : 0
}

function resolveScopeParameters(
  repository: RuntimeRepository,
  scope: ParameterScope
): { ids: string[]; values: Record<string, unknown> } {
  if (scope.level === 'global') return repository.resolveParameters()
  if (scope.level === 'sourceType') {
    return repository.resolveParameters(scope.sourceType)
  }
  const source = repository.getSource(scope.sourceId)
  if (!source) throw new Error('Source does not exist')
  return repository.resolveParameters(source.type, source.id)
}

function resolveParentParameters(
  repository: RuntimeRepository,
  scope: ParameterScope
): { ids: string[]; values: Record<string, unknown> } {
  if (scope.level === 'global') return { ids: [], values: {} }
  if (scope.level === 'sourceType') return repository.resolveParameters()
  const source = repository.getSource(scope.sourceId)
  if (!source) throw new Error('Source does not exist')
  return repository.resolveParameters(source.type)
}

function ownParameters(
  repository: RuntimeRepository,
  scope: ParameterScope
): Record<string, unknown> {
  return repository.listParameterVersions(scope)[0]?.values ?? {}
}

function normalizedOwnValues(
  repository: RuntimeRepository,
  scope: ParameterScope,
  values: Record<string, unknown>
): Record<string, unknown> {
  return scope.level === 'global'
    ? mergeValues(ownParameters(repository, scope), values)
    : values
}

function validateAffectedParameters(
  repository: RuntimeRepository,
  scope: ParameterScope,
  ownValues: Record<string, unknown>
): void {
  const globalScope = { level: 'global' } as const
  const globalValues =
    scope.level === 'global'
      ? ownValues
      : ownParameters(repository, globalScope)
  validateRuntimeParameters(globalValues)
  for (const source of repository.listSources()) {
    if (scope.level === 'sourceType' && source.type !== scope.sourceType)
      continue
    if (scope.level === 'source' && source.id !== scope.sourceId) continue
    const typeScope = { level: 'sourceType', sourceType: source.type } as const
    const sourceScope = { level: 'source', sourceId: source.id } as const
    const typeValues =
      scope.level === 'sourceType' && scope.sourceType === source.type
        ? ownValues
        : ownParameters(repository, typeScope)
    const sourceValues =
      scope.level === 'source' && scope.sourceId === source.id
        ? ownValues
        : ownParameters(repository, sourceScope)
    validateRuntimeParameters(
      mergeValues(mergeValues(globalValues, typeValues), sourceValues)
    )
  }
}

function mergeValues(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...base }
  for (const [key, value] of Object.entries(override)) {
    merged[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      merged[key] &&
      typeof merged[key] === 'object' &&
      !Array.isArray(merged[key])
        ? mergeValues(
            merged[key] as Record<string, unknown>,
            value as Record<string, unknown>
          )
        : value
  }
  return merged
}

function cronFieldMatches(
  field: string,
  value: number,
  sunday = false
): boolean {
  return field.split(',').some((entry) => {
    const [range = '*', stepText] = entry.split('/')
    const step = stepText ? Number(stepText) : 1
    const normalize = (candidate: number) =>
      sunday && candidate === 7 ? 0 : candidate
    if (range === '*') return value % step === 0
    const [startText, endText] = range.split('-')
    const start = normalize(Number(startText))
    const end = normalize(Number(endText ?? startText))
    if (sunday && Number(endText) === 7 && start > end) {
      return (value >= start || value <= end) && value % step === start % step
    }
    return value >= start && value <= end && (value - start) % step === 0
  })
}

function cronMatches(schedule: string, date: Date): boolean {
  const fields = schedule.trim().split(/\s+/u)
  if (fields.length !== 5) return false
  const dayOfMonth = cronFieldMatches(fields[2]!, date.getDate())
  const dayOfWeek = cronFieldMatches(fields[4]!, date.getDay(), true)
  const dayMatches =
    fields[2] !== '*' && fields[4] !== '*'
      ? dayOfMonth || dayOfWeek
      : dayOfMonth && dayOfWeek
  return (
    cronFieldMatches(fields[0]!, date.getMinutes()) &&
    cronFieldMatches(fields[1]!, date.getHours()) &&
    dayMatches &&
    cronFieldMatches(fields[3]!, date.getMonth() + 1)
  )
}

function adapterFor(
  providerId: string,
  source: ManagedSource,
  captureResponse?: CaptureProviderResponse
): SourceAdapter | undefined {
  const tikhub = process.env.TIKHUB_API_KEY
  if (providerId === 'twitterapi.io' && process.env.TWITTERAPI_IO_KEY) {
    return createTwitterApiIoProvider({
      apiKey: process.env.TWITTERAPI_IO_KEY,
      captureResponse,
    })
  }
  if (providerId === 'youtube-data-api' && process.env.YOUTUBE_API_KEY) {
    return createYouTubeDataApiProvider({
      apiKey: process.env.YOUTUBE_API_KEY,
      captureResponse,
    })
  }
  if (
    providerId === 'getbiji-douyin' &&
    source.id === 'douyin_qinghua_jiang' &&
    process.env.GETBIJI_API_KEY &&
    process.env.GETBIJI_CLIENT_ID
  ) {
    return createGetBijiDouyinProvider({
      apiKey: process.env.GETBIJI_API_KEY,
      clientId: process.env.GETBIJI_CLIENT_ID,
      topicId: '1n3ODBLn',
      followId: '1286623',
      captureResponse,
    })
  }
  if (!tikhub) return undefined
  if (providerId === 'tikhub-x')
    return createTikHubXProvider({ token: tikhub, captureResponse })
  if (providerId === 'tikhub-youtube') {
    return {
      providerId,
      sourceType: 'youtube',
      async discover(request) {
        const identity = new URL(source.externalIdentity)
        if (
          identity.protocol !== 'https:' ||
          !['youtube.com', 'www.youtube.com'].includes(identity.hostname)
        ) {
          throw new Error('YouTube source URL is invalid')
        }
        const page = await fetch(identity, {
          signal: AbortSignal.timeout(10_000),
        })
        if (!page.ok) throw new Error('YouTube channel lookup failed')
        const html = await page.text()
        const channelId =
          html.match(/"channelId":"(UC[A-Za-z0-9_-]+)"/u)?.[1] ??
          html.match(/itemprop="channelId" content="(UC[A-Za-z0-9_-]+)"/u)?.[1]
        if (!channelId) throw new Error('YouTube channel ID was not found')
        return createTikHubYouTubeProvider({
          token: tikhub,
          channelId,
          captureResponse,
        }).discover(request)
      },
    }
  }
  if (providerId === 'tikhub-douyin') {
    return createTikHubDouyinProvider({ token: tikhub, captureResponse })
  }
  if (providerId === 'tikhub-wechat-channels') {
    return createTikHubWechatChannelsProvider({
      token: tikhub,
      captureResponse,
    })
  }
  if (providerId === 'tikhub-xiaohongshu') {
    return createTikHubXiaohongshuProvider({ token: tikhub, captureResponse })
  }
  return undefined
}

async function probeSource(
  source: ManagedSource,
  providerId?: string
): Promise<{ providerId: string; items: Array<Record<string, unknown>> }> {
  if (source.type === 'rss') {
    const response = await fetch(source.externalIdentity, {
      headers: { accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error('RSS probe failed')
    const text = await response.text()
    const titles = [
      ...text.matchAll(
        /<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gisu
      ),
    ]
      .slice(1, 4)
      .map((match) => match[1]?.replace(/<[^>]+>/gu, '').trim())
      .filter((title): title is string => Boolean(title))
    return {
      providerId: 'native-rss',
      items: titles.map((title) => ({ title })),
    }
  }
  const candidates = providerDefinitions
    .filter((provider) => provider.sourceType === source.type)
    .sort((left, right) => left.priority - right.priority)
  const selected = providerId
    ? candidates.find((provider) => provider.id === providerId)
    : candidates.find((provider) => Boolean(adapterFor(provider.id, source)))
  const adapter = selected ? adapterFor(selected.id, source) : undefined
  if (!adapter) throw new Error('Provider credential is not configured')
  const batch = await adapter.discover({ source, limit: 3 })
  return {
    providerId: batch.providerId,
    items: batch.items.map((item) => ({
      title: item.content.title,
      url: item.content.canonicalUrl,
      publishedAt: item.publishedAt,
    })),
  }
}

function configuredAdapter(
  repository: RuntimeRepository,
  source: ManagedSource,
  task: RuntimeTask
) {
  const providers = providerDefinitions
    .filter((provider) => provider.sourceType === source.type)
    .sort((left, right) => left.priority - right.priority)
    .map((provider) =>
      adapterFor(provider.id, source, async (response) => {
        await repository.saveRawResponse({
          id: `provider-${randomUUID()}`,
          providerId: response.providerId,
          receivedAt: response.receivedAt,
          retentionDays: taskNumber(
            task,
            'storage',
            'rawResponseRetentionDays',
            30
          ),
          payload: { request: response.request, response: response.payload },
        })
      })
    )
    .filter((adapter): adapter is SourceAdapter => Boolean(adapter))
  if (!providers.length) return undefined
  return createProviderRouter({
    providers,
    cooldownMs:
      taskNumber(task, 'collection', 'providerCooldownMinutes', 30) * 60_000,
    maxAttempts: Math.max(1, taskNumber(task, 'collection', 'retryLimit', 3)),
    audit: async (attempt) => {
      await repository.saveProviderAttempt({ id: randomUUID(), ...attempt })
    },
    healthStore: {
      async load(providerId) {
        const stored = repository.getProviderHealth(providerId)
        return stored
          ? {
              state: stored.state,
              retryAt: stored.retryAt,
              errorClass: stored.errorClass,
            }
          : undefined
      },
      async save(providerId, health) {
        await repository.saveProviderHealth({ providerId, ...health })
      },
    },
  })
}

function configuredVideoTranscriber(): VideoTranscriber | undefined {
  const endpoint = process.env.QIUSHUI_AIRADAR_TRANSCRIBER_URL
  if (!endpoint) return undefined
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1') {
    throw new Error('Transcriber URL must use HTTPS or loopback')
  }
  return {
    providerId: 'configured-transcriber',
    async transcribe(input) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(120_000),
      })
      if (!response.ok) throw new Error('Configured transcriber failed')
      const body = asRecord(await response.json())
      if (typeof body.text !== 'string' || !body.text.trim()) {
        throw new Error('Configured transcriber returned no text')
      }
      return body.text.trim()
    },
  }
}

function analysisOptions(task: RuntimeTask, manual: boolean) {
  const profile = asRecord(task.parameterSnapshot.profile)
  const scoring = asRecord(task.parameterSnapshot.scoring)
  const storage = asRecord(task.parameterSnapshot.storage)
  const weights = asRecord(scoring.weights)
  const weight = (key: string, fallback: number) =>
    typeof weights[key] === 'number' ? weights[key] : fallback
  const valueVersion = (kind: string, value: Record<string, unknown>) =>
    `${kind}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)}`
  return {
    modelGateway: createCodexPiGateway(
      process.env.CODEX_AUTH_PATH ??
        path.join(homedir(), '.codex', 'auth.json'),
      'gpt-5.6-terra'
    ),
    profile: JSON.stringify(profile),
    profileVersionId: valueVersion('profile', profile),
    ruleVersion: valueVersion('scoring', scoring),
    rawResponseRetentionDays:
      typeof storage.rawResponseRetentionDays === 'number'
        ? storage.rawResponseRetentionDays
        : 30,
    scoringRule: {
      weights: {
        topicMatch: weight('topicMatch', 20),
        substance: weight('substance', 15),
        credibility: weight('credibility', 15),
        novelty: weight('novelty', 10),
        actionability: weight('actionability', 15),
        workValue: weight('workValue', 15),
        clarity: weight('clarity', 10),
      },
      coreThreshold:
        typeof scoring.coreThreshold === 'number' ? scoring.coreThreshold : 80,
      exploreThreshold:
        typeof scoring.exploreThreshold === 'number'
          ? scoring.exploreThreshold
          : 60,
    },
    modelRouteVersion: 'gpt-5.6-terra',
    manual,
  }
}

function taskNumber(
  task: RuntimeTask,
  group: string,
  key: string,
  fallback: number
): number {
  const value = asRecord(task.parameterSnapshot[group])[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

async function analyzeTaskContent(
  repository: RuntimeRepository,
  task: RuntimeTask,
  contentId: string,
  manual = false
): Promise<void> {
  const content = repository.getContent(contentId)
  const sourceId = content?.sourceId
    ? (acceptanceSourceAliases[content.sourceId] ?? content.sourceId)
    : undefined
  await analyzeStoredContent(repository, contentId, {
    ...analysisOptions(task, manual),
    sourceLanguage: sourceId
      ? repository.getSource(sourceId)?.language
      : undefined,
  })
}

async function executeTask(
  repository: RuntimeRepository,
  task: RuntimeTask
): Promise<void> {
  const contentId =
    typeof task.payload.contentId === 'string'
      ? task.payload.contentId
      : undefined
  const rawSourceId =
    task.sourceId ??
    (contentId ? repository.getContent(contentId)?.sourceId : undefined)
  const sourceId = rawSourceId
    ? (acceptanceSourceAliases[rawSourceId] ?? rawSourceId)
    : undefined
  const source = sourceId ? repository.getSource(sourceId) : undefined
  if (task.type === 'analyze') {
    if (!contentId) throw new Error('Analyze task has no content id')
    await analyzeTaskContent(
      repository,
      task,
      contentId,
      task.payload.manual === true
    )
    return
  }
  if (!source) throw new Error('Task source does not exist')
  if (task.type === 'enrich') {
    if (!contentId) throw new Error('Enrichment task has no content id')
    const content = repository.getContent(contentId)
    if (!content) throw new Error('Content does not exist')
    let completedContentId = contentId
    const mode =
      typeof task.payload.mode === 'string'
        ? task.payload.mode
        : content.kind === 'video'
          ? 'auto-transcription'
          : content.kind === 'image_post'
            ? 'image-post-enrichment'
            : 'article-enrichment'
    if (mode === 'article-enrichment') {
      if (!content.canonicalUrl) throw new Error('Article URL is missing')
      const enriched =
        source.type === 'x' && isXArticleUrl(content.canonicalUrl)
          ? await fetchTwitterApiIoArticle({
              apiKey: process.env.TWITTERAPI_IO_KEY ?? '',
              tweetId: content.externalId ?? '',
              canonicalUrl: content.canonicalUrl,
            })
          : await enrichArticle(content.canonicalUrl)
      if (source.type === 'rss') {
        const canonicalId = `rss-${createHash('sha256')
          .update(`article:${enriched.canonicalUrl}`)
          .digest('hex')
          .slice(0, 32)}`
        completedContentId = (
          await repository.mergeContentIdentity(
            contentId,
            canonicalId,
            enriched
          )
        ).id
      } else {
        await repository.completeContentEnrichment(contentId, enriched)
      }
    } else if (source.type === 'youtube' || contentId.startsWith('youtube:')) {
      const token = process.env.TIKHUB_API_KEY
      if (!token)
        throw new Error('YouTube transcript provider is not configured')
      const result = await enrichYouTubeContent({
        repository,
        contentId,
        transcriptProvider: createTikHubYouTubeTranscriptProvider({ token }),
        autoTranscribe:
          task.payload.manual === true ||
          Boolean(asRecord(task.parameterSnapshot.transcription).auto),
        transcriber: configuredVideoTranscriber(),
      })
      if (result.status === 'processing') {
        throw new Error('YouTube transcript is still processing')
      }
      if (result.status !== 'succeeded') return
    } else if (mode === 'image-post-enrichment') {
      const token = process.env.TIKHUB_API_KEY
      if (!token)
        throw new Error('Image-post detail provider is not configured')
      await enrichImagePostContent({
        repository,
        contentId,
        detailProvider: createTikHubXiaohongshuDetailProvider({ token }),
      })
    } else if (mode === 'auto-transcription') {
      const apiKey = process.env.GETBIJI_API_KEY
      const clientId = process.env.GETBIJI_CLIENT_ID
      const transcriber =
        source.type === 'douyin' && apiKey && clientId
          ? createGetBijiDouyinTranscriber({
              apiKey,
              clientId,
              topicId: '1n3ODBLn',
            })
          : configuredVideoTranscriber()
      if (!transcriber) {
        throw new Error(
          'Video transcriber is not configured; set QIUSHUI_AIRADAR_TRANSCRIBER_URL'
        )
      }
      const result = await enrichPlatformVideoContent({
        repository,
        contentId,
        transcriber,
        autoTranscribe:
          task.payload.manual === true ||
          Boolean(asRecord(task.parameterSnapshot.transcription).auto),
        maxDurationSeconds:
          taskNumber(task, 'transcription', 'maximumMinutes', 120) * 60,
        manual: task.payload.manual === true,
      })
      if (result.status !== 'succeeded') return
    } else {
      throw new Error(`Unsupported enrichment mode: ${mode}`)
    }
    await repository.enqueueTask({
      id: randomUUID(),
      type: 'analyze',
      sourceId: source.id,
      sourceType: source.type,
      idempotencyKey: `analyze:${task.id}:${completedContentId}`,
      payload: { contentId: completedContentId, manual: false },
    })
    return
  }
  if (task.payload.preview === true) {
    await probeSource(source)
    return
  }
  const progress = repository.getProgress(source.id)
  const batchLimit = progress
    ? taskNumber(task, 'collection', 'batchLimit', 100)
    : taskNumber(task, 'collection', 'initialLimit', 20)
  const initialLookbackDays = taskNumber(
    task,
    'collection',
    'initialLookbackDays',
    7
  )
  if (source.type === 'rss') {
    await runRssDiscovery({
      repository,
      source: { id: source.id, feedUrl: source.externalIdentity },
      limit: batchLimit,
      initialLookbackDays,
      rawResponseRetentionDays: taskNumber(
        task,
        'storage',
        'rawResponseRetentionDays',
        30
      ),
    })
  } else {
    const adapter = configuredAdapter(repository, source, task)
    if (!adapter) throw new Error('No configured provider for source')
    const result = await runPlatformDiscovery({
      repository,
      runner: adapter,
      source,
      cursor: progress?.cursor,
      limit: batchLimit,
      autoTranscribe: Boolean(
        asRecord(task.parameterSnapshot.transcription).auto
      ),
      publishedAfter: progress
        ? undefined
        : new Date(
            Date.now() - initialLookbackDays * 24 * 60 * 60 * 1000
          ).toISOString(),
    })
    for (const item of result.items) {
      const id = item.platformIdentity
      if (
        typeof id === 'string' &&
        repository.getContent(id)?.enrichmentStatus === 'succeeded'
      ) {
        await repository.enqueueTask({
          id: randomUUID(),
          type: 'analyze',
          sourceId: source.id,
          sourceType: source.type,
          idempotencyKey: `analyze:${task.id}:${id}`,
          payload: { contentId: id, manual: false },
        })
      }
    }
  }
}

async function ensureInitialState(
  repository: RuntimeRepository
): Promise<void> {
  await repository.retireSourceConfigs(retiredSourceIds)
  await repository.importSources(initialSources)
  if (repository.listParameterVersions({ level: 'global' }).length === 0) {
    await repository.saveParameterVersion({
      id: 'parameters-global-initial',
      scope: { level: 'global' },
      values: defaultParameters,
      description: 'qiushui-airadar 初始运行参数',
    })
  }
}

async function enqueueTranslationBackfill(
  repository: RuntimeRepository
): Promise<number> {
  const sources = new Map(
    repository.listSources().map((source) => [source.id, source])
  )
  const analyses = new Map<string, Record<string, unknown>>()
  for (const analysis of repository.listAnalyses()) {
    if (!analyses.has(analysis.contentId)) {
      analyses.set(analysis.contentId, asRecord(analysis.result))
    }
  }
  let queued = 0
  for (const content of repository.listContents()) {
    const sourceId = content.sourceId
      ? (acceptanceSourceAliases[content.sourceId] ?? content.sourceId)
      : undefined
    const source = sourceId ? sources.get(sourceId) : undefined
    if (
      !source ||
      source.language !== 'en' ||
      content.enrichmentStatus !== 'succeeded' ||
      !content.body.trim() ||
      detectOriginalLanguage(content.body) === 'zh'
    )
      continue
    const result = analyses.get(content.id) ?? {}
    if (
      effectiveJunk(repository.getContentUserState(content.id), result, content)
        .isJunk
    )
      continue
    if (
      typeof result.chineseTitle === 'string' &&
      result.chineseTitle.trim() &&
      typeof result.chineseTranslation === 'string' &&
      result.chineseTranslation.trim()
    )
      continue
    const task = await repository.enqueueTask({
      id: `translation-backfill-${createHash('sha256').update(content.id).digest('hex').slice(0, 24)}`,
      type: 'analyze',
      sourceId: source.id,
      sourceType: source.type,
      idempotencyKey: `translation-backfill:english-full-translation-v2:${content.id}`,
      payload: { contentId: content.id },
    })
    if (task.status === 'pending') queued += 1
  }
  return queued
}

async function enqueueRetry(
  repository: RuntimeRepository,
  contentId: string
): Promise<string> {
  const content = repository.getContent(contentId)
  if (!content) throw new Error('Content does not exist')
  const sourceId = content.sourceId
    ? (acceptanceSourceAliases[content.sourceId] ?? content.sourceId)
    : undefined
  const source = sourceId ? repository.getSource(sourceId) : undefined
  const id = randomUUID()
  await repository.enqueueTask({
    id,
    type: content.enrichmentStatus === 'succeeded' ? 'analyze' : 'enrich',
    sourceId,
    sourceType: source?.type,
    idempotencyKey: `manual-retry:${contentId}:${id}`,
    payload: { contentId, manual: true },
  })
  return id
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  repository: RuntimeRepository,
  scheduleTasks: () => void,
  webRoot?: string
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const method = request.method ?? 'GET'
  if (method === 'OPTIONS') return send(response, 204, {})
  if (method === 'POST') {
    const origin = request.headers.origin
    if (origin && !allowLocalWebOrigin(origin)) {
      return send(response, 403, { error: 'origin_not_allowed' })
    }
    if (!request.headers['content-type']?.startsWith('application/json')) {
      return send(response, 415, { error: 'json_required' })
    }
  }
  if (method === 'GET' && url.pathname === '/health') {
    return send(response, 200, {
      service: 'qiushui-airadar',
      status: 'ready',
    })
  }
  if (
    method === 'GET' &&
    (url.pathname === '/api/contents' || url.pathname === '/api/daily')
  ) {
    const items = contentItems(repository)
    return send(response, 200, {
      items:
        url.pathname === '/api/daily'
          ? items.filter(
              (item) =>
                !item.junk.isJunk &&
                item.processStatus === 'completed' &&
                (item.recommendation === 'core' ||
                  item.recommendation === 'explore')
            )
          : items,
    })
  }
  if (method === 'GET' && url.pathname === '/api/sources') {
    const audits = repository.listAudits()
    return send(response, 200, {
      items: repository.listSources().map((source) => {
        const sourceAudits = audits
          .filter((audit) => audit.sourceId === source.id)
          .sort((left, right) =>
            left.finishedAt.localeCompare(right.finishedAt)
          )
        const latest = sourceAudits.at(-1)
        let consecutiveFailures = 0
        for (const audit of [...sourceAudits].reverse()) {
          if (!audit.error) break
          consecutiveFailures += 1
        }
        return {
          ...source,
          health:
            source.status !== 'enabled'
              ? 'disabled'
              : consecutiveFailures >= 3
                ? 'unavailable'
                : latest?.error
                  ? 'warning'
                  : 'healthy',
          latestAudit: latest,
          effectiveParameters: repository.resolveParameters(
            source.type,
            source.id
          ),
        }
      }),
    })
  }
  if (method === 'GET' && url.pathname === '/api/providers') {
    return send(response, 200, {
      items: providerDefinitions.map((provider) => {
        const value = provider.secretEnv
          ? process.env[provider.secretEnv]
          : undefined
        return {
          ...provider,
          health: repository.getProviderHealth(provider.id) ?? {
            state: 'healthy',
          },
          secretStatus: provider.secretEnv
            ? {
                configured: Boolean(value),
                maskedValue: value ? maskSecret(value) : undefined,
              }
            : undefined,
        }
      }),
    })
  }
  if (method === 'GET' && url.pathname === '/api/runtime') {
    return send(response, 200, {
      tasks: repository.listTasks(),
      audits: repository.listAudits(),
      providerAttempts: repository.listProviderAttempts(),
    })
  }
  if (method === 'GET' && url.pathname === '/api/config') {
    const scope = parseScope({
      level: url.searchParams.get('level') ?? 'global',
      sourceType: url.searchParams.get('sourceType') ?? undefined,
      sourceId: url.searchParams.get('sourceId') ?? undefined,
    })
    return send(response, 200, {
      scope,
      own: repository.listParameterVersions(scope)[0]?.values ?? {},
      effective: resolveScopeParameters(repository, scope),
      versions: repository.listParameterVersions(scope),
      fixedRules,
    })
  }

  const contentMutation = url.pathname.match(
    /^\/api\/contents\/([^/]+)\/(read|actions|junk|retry)$/u
  )
  if (method === 'POST' && contentMutation) {
    const contentId = decodeURIComponent(contentMutation[1]!)
    const operation = contentMutation[2]
    const body = await readJson(request)
    if (operation === 'read') {
      return send(response, 200, {
        state: await repository.setContentRead(contentId, body.read === true),
      })
    }
    if (operation === 'actions') {
      const item = contentItems(repository).find(
        (entry) => entry.id === contentId
      )
      if (item?.junk.isJunk) {
        throw new Error('Junk content cannot have utilization actions')
      }
      const actions = Array.isArray(body.actions) ? body.actions : []
      return send(response, 200, {
        state: await repository.setUtilizationActions(
          contentId,
          actions as UtilizationAction[]
        ),
      })
    }
    if (operation === 'junk') {
      return send(response, 200, {
        state: await repository.setManualJunk(contentId, {
          isJunk: body.isJunk === true,
          reason:
            typeof body.reason === 'string'
              ? (body.reason as JunkReason)
              : undefined,
          note: typeof body.note === 'string' ? body.note : undefined,
        }),
      })
    }
    const taskId = await enqueueRetry(repository, contentId)
    scheduleTasks()
    return send(response, 202, { taskId })
  }

  if (method === 'POST' && url.pathname === '/api/contents/batch') {
    const body = await readJson(request)
    const ids = Array.isArray(body.ids)
      ? body.ids
          .filter((id): id is string => typeof id === 'string')
          .slice(0, 100)
      : []
    if (!ids.length) throw new Error('Batch requires content ids')
    if (body.operation === 'mark-read' || body.operation === 'mark-unread') {
      const read = body.operation === 'mark-read'
      await Promise.all(ids.map((id) => repository.setContentRead(id, read)))
    } else if (body.operation === 'retry') {
      for (const id of ids) await enqueueRetry(repository, id)
      scheduleTasks()
    } else {
      throw new Error('Unsupported safe batch operation')
    }
    return send(response, 200, { updated: ids.length })
  }

  const sourceMutation = url.pathname.match(
    /^\/api\/sources\/([^/]+)\/(status|test-fetch)$/u
  )
  if (method === 'POST' && sourceMutation) {
    const sourceId = decodeURIComponent(sourceMutation[1]!)
    if (sourceMutation[2] === 'status') {
      const body = await readJson(request)
      if (
        body.status !== 'enabled' &&
        body.status !== 'disabled' &&
        body.status !== 'archived'
      ) {
        throw new Error('Invalid source status')
      }
      return send(response, 200, {
        source: await repository.updateSourceStatus(sourceId, body.status),
      })
    }
    const source = repository.getSource(sourceId)
    if (!source) throw new Error('Source does not exist')
    const body = await readJson(request)
    if (body.execute === true) {
      try {
        return send(response, 200, {
          status: 'succeeded',
          ...(await probeSource(source)),
        })
      } catch {
        return send(response, 502, {
          status: 'failed',
          message: '远端试抓失败，请检查凭据、余额和供应商状态。',
        })
      }
    }
    const taskId = randomUUID()
    await repository.enqueueTask({
      id: taskId,
      type: 'discover',
      sourceId,
      sourceType: source.type,
      idempotencyKey: `test-fetch:${sourceId}:${taskId}`,
      payload: { sourceId, manual: true, preview: true },
    })
    scheduleTasks()
    return send(response, 202, { taskId })
  }

  const providerTest = url.pathname.match(/^\/api\/providers\/([^/]+)\/test$/u)
  if (method === 'POST' && providerTest) {
    const provider = providerDefinitions.find(
      (entry) => entry.id === decodeURIComponent(providerTest[1]!)
    )
    if (!provider) throw new Error('Provider does not exist')
    const source = repository
      .listSources()
      .find(
        (candidate) =>
          candidate.type === provider.sourceType &&
          candidate.status === 'enabled'
      )
    if (!source) return send(response, 409, { status: 'no-enabled-source' })
    try {
      const preview = await probeSource(source, provider.id)
      return send(response, 200, { status: 'succeeded', ...preview })
    } catch {
      return send(response, 502, {
        status: 'failed',
        message: '远端连接失败，请检查凭据、余额和供应商状态。',
      })
    }
  }

  if (method === 'POST' && url.pathname === '/api/config/preview') {
    const body = await readJson(request)
    const scope = parseScope(body.scope)
    const values = normalizedOwnValues(repository, scope, asRecord(body.values))
    const before = resolveScopeParameters(repository, scope).values
    const after = mergeValues(
      resolveParentParameters(repository, scope).values,
      values
    )
    validateAffectedParameters(repository, scope, values)
    return send(response, 200, {
      scope,
      ownBefore: repository.listParameterVersions(scope)[0]?.values ?? {},
      ownAfter: values,
      before,
      after,
      affectedSources: affectedSourceCount(repository, scope),
    })
  }
  if (method === 'POST' && url.pathname === '/api/config/versions') {
    const body = await readJson(request)
    const scope = parseScope(body.scope)
    const values = normalizedOwnValues(repository, scope, asRecord(body.values))
    validateAffectedParameters(repository, scope, values)
    const version = await repository.saveParameterVersion({
      id: randomUUID(),
      scope,
      values,
      description:
        typeof body.description === 'string' && body.description.trim()
          ? body.description.trim()
          : 'Web 配置变更',
    })
    return send(response, 201, { version })
  }
  if (method === 'POST' && url.pathname === '/api/config/rollback') {
    const body = await readJson(request)
    const target = repository
      .listParameterVersions()
      .find((version) => version.id === body.versionId)
    if (!target) throw new Error('Parameter version does not exist')
    validateAffectedParameters(repository, target.scope, target.values)
    const version = await repository.saveParameterVersion({
      id: randomUUID(),
      scope: target.scope,
      values: target.values,
      description: `回退到 ${target.id}`,
    })
    return send(response, 201, { version })
  }

  if (
    webRoot &&
    (method === 'GET' || method === 'HEAD') &&
    !url.pathname.startsWith('/api/')
  ) {
    const requestedPath = decodeURIComponent(url.pathname)
    const hasExtension = path.posix.basename(requestedPath).includes('.')
    const relativePath = hasExtension
      ? requestedPath.replace(/^\/+/, '')
      : 'index.html'
    const root = path.resolve(webRoot)
    const filePath = path.resolve(root, relativePath)
    if (filePath === root || filePath.startsWith(`${root}${path.sep}`)) {
      try {
        const body = await readFile(filePath)
        const extension = path.extname(filePath).toLowerCase()
        const contentTypes: Record<string, string> = {
          '.css': 'text/css; charset=utf-8',
          '.html': 'text/html; charset=utf-8',
          '.ico': 'image/x-icon',
          '.js': 'text/javascript; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.webp': 'image/webp',
          '.woff2': 'font/woff2',
        }
        response.statusCode = 200
        response.setHeader(
          'content-type',
          contentTypes[extension] ?? 'application/octet-stream'
        )
        response.setHeader('x-content-type-options', 'nosniff')
        response.end(method === 'HEAD' ? undefined : body)
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  send(response, method === 'DELETE' ? 405 : 404, { error: 'not_found' })
}

export interface ServiceAddress {
  host: string
  port: number
}

export interface ServiceApp {
  start(options: ServiceAddress): Promise<ServiceAddress>
  stop(): Promise<void>
}

export function createServiceApp(
  options: {
    dataRoot?: string
    executeTasks?: boolean
    taskIntervalMs?: number
    webRoot?: string
  } = {}
): ServiceApp {
  let server: Server | undefined
  let repository: RuntimeRepository | undefined
  let workerTail: Promise<void> = Promise.resolve()
  let workerTimer: ReturnType<typeof setInterval> | undefined
  let schedulerTail: Promise<void> = Promise.resolve()
  let schedulerTimer: ReturnType<typeof setInterval> | undefined
  const dataRoot =
    options.dataRoot ??
    process.env.QIUSHUI_AIRADAR_DATA_ROOT ??
    path.join(homedir(), '.qiushui-airadar', 'data')
  const scheduleTasks = () => {
    if (!options.executeTasks || !repository) return
    const activeRepository = repository
    workerTail = workerTail
      .catch(() => undefined)
      .then(() =>
        runPendingTasks(activeRepository, {
          concurrency: 1,
          workerIdPrefix: 'web-service',
          handler: (task) => executeTask(activeRepository, task),
        })
      )
  }
  const scheduleCollections = () => {
    if (!options.executeTasks || !repository) return
    const activeRepository = repository
    schedulerTail = schedulerTail
      .catch(() => undefined)
      .then(async () => {
        const now = new Date()
        for (const source of activeRepository
          .listSources()
          .filter((candidate) => candidate.status === 'enabled')) {
          const parameters = activeRepository.resolveParameters(
            source.type,
            source.id
          )
          const collection = asRecord(parameters.values.collection)
          const schedule = collection.schedule
          if (typeof schedule !== 'string' || !cronMatches(schedule, now)) {
            continue
          }
          const minute = [
            now.getFullYear(),
            String(now.getMonth() + 1).padStart(2, '0'),
            String(now.getDate()).padStart(2, '0'),
            String(now.getHours()).padStart(2, '0'),
            String(now.getMinutes()).padStart(2, '0'),
          ].join('-')
          await activeRepository.enqueueTask({
            id: `scheduled-${source.id}-${minute}`,
            type: 'discover',
            sourceId: source.id,
            sourceType: source.type,
            idempotencyKey: `scheduled:${source.id}:${minute}`,
            payload: {
              scheduledAt: now.toISOString(),
              providerRouterOwnsBudget: source.type !== 'rss',
            },
          })
        }
        await activeRepository.purgeExpiredRawResponses(now.toISOString())
        scheduleTasks()
      })
  }

  return {
    async start(address) {
      if (server)
        throw new Error('qiushui-airadar service is already running')
      repository = await RuntimeRepository.open(dataRoot)
      await ensureInitialState(repository)
      await enqueueTranslationBackfill(repository)
      server = createServer((request, response) => {
        response.setHeader('content-type', 'application/json; charset=utf-8')
        const allowedOrigin = allowLocalWebOrigin(request.headers.origin)
        if (allowedOrigin) {
          response.setHeader('access-control-allow-origin', allowedOrigin)
          response.setHeader('vary', 'origin')
        }
        void handleRequest(
          request,
          response,
          repository!,
          scheduleTasks,
          options.webRoot
        ).catch(() => {
          if (!response.headersSent) {
            send(response, 400, { error: 'request_failed' })
          } else {
            response.end()
          }
        })
      })
      try {
        await new Promise<void>((resolve, reject) => {
          server?.once('error', reject)
          server?.listen(address.port, address.host, resolve)
        })
      } catch (error) {
        server = undefined
        await repository.close()
        repository = undefined
        throw error
      }
      const activeAddress = server.address()
      if (!activeAddress || typeof activeAddress === 'string') {
        throw new Error('Service did not bind a TCP address')
      }
      scheduleTasks()
      if (options.executeTasks) {
        workerTimer = setInterval(
          scheduleTasks,
          options.taskIntervalMs ?? 30_000
        )
        workerTimer.unref()
        scheduleCollections()
        schedulerTimer = setInterval(scheduleCollections, 30_000)
        schedulerTimer.unref()
      }
      return { host: address.host, port: activeAddress.port }
    },
    async stop() {
      const activeServer = server
      const activeRepository = repository
      server = undefined
      repository = undefined
      if (workerTimer) clearInterval(workerTimer)
      workerTimer = undefined
      if (schedulerTimer) clearInterval(schedulerTimer)
      schedulerTimer = undefined
      if (activeServer) {
        await new Promise<void>((resolve, reject) => {
          activeServer.close((error) => (error ? reject(error) : resolve()))
        })
      }
      await schedulerTail
      await workerTail
      await activeRepository?.close()
    },
  }
}
