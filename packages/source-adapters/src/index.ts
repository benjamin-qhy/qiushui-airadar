import {
  canonicalizeContentUrl,
  type Content,
  type ContentKind,
  type Source,
  type SourceType,
} from '@qiushuiai-airadar/domain'

/** Confirmed destinations that cannot provide a standalone article body. */
export function classifyNonArticlePage(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  const host = url.hostname.toLowerCase()
  const pathname = url.pathname.replace(/\/+$/, '') || '/'
  if (host === 'events.ycombinator.com') {
    return '活动页：活动报名与介绍，不是文章正文'
  }
  if (host === 'aws-experience.com' && /^\/apj\/smb\/e\//u.test(pathname)) {
    return '活动页：工作坊报名与介绍，不是文章正文'
  }
  if (host === 'claude.ai' && pathname.startsWith('/artifact/')) {
    return '互动作品：游戏或应用，不是文章正文'
  }
  if (
    host === 'chatgpt.com' &&
    (pathname === '/plugins' || pathname.startsWith('/plugins/'))
  ) {
    return '目录页：插件列表，不是单篇文章'
  }
  if (host === 'openai.com' && pathname === '/gpt-tv') {
    return '互动页：播放器与操作界面，不是文章正文'
  }
  return undefined
}

export interface DiscoveryRequest {
  source: Source
  cursor?: string
  limit?: number
}

function limitItems<T>(items: T[], limit?: number): T[] {
  return limit === undefined ? items : items.slice(0, limit)
}

export interface DiscoveredItem {
  externalId: string
  content: Omit<Content, 'id'>
  publishedAt?: string
  platformIdentity?: string
  description?: string
  enrichmentError?: string
  interaction?: InteractionSnapshot
  evidence?: ContentEvidence
  video?: {
    scope: 'normal' | 'short' | 'live-replay' | 'live'
    durationSeconds?: number
    mediaUrl?: string
    providerReference?: string
  }
  images?: Array<{ order: number; url: string }>
  quotedPost?: XQuotedPost
  repostedBy?: { name: string; handle?: string; url: string }
  thread?: {
    conversationId: string
    complete: boolean
    parts: Array<{ id: string; text: string; publishedAt?: string }>
  }
  discoveryParts?: Array<{
    externalId: string
    discoveryUrl: string
    sourceText?: string
    interaction?: InteractionSnapshot
  }>
}

export interface XQuotedPost {
  url: string
  authorName?: string
  authorHandle?: string
  text: string
  images: Array<{ order: number; url: string }>
}

export interface DiscoveryBatch {
  items: DiscoveredItem[]
  providerId: string
  nextCursor?: string
}

export interface SourceAdapter {
  providerId: string
  sourceType: SourceType
  discover(request: DiscoveryRequest): Promise<DiscoveryBatch>
}

export interface SourceAdapterDefinition {
  providerId: string
  sourceType: SourceType
  discover(
    request: DiscoveryRequest
  ): Promise<Omit<DiscoveryBatch, 'providerId'>>
}

export type ProviderErrorClass =
  | 'temporary'
  | 'rate-limit'
  | 'credential'
  | 'balance'
  | 'invalid-request'
  | 'invalid-response'

export interface ProviderAttemptAudit {
  providerId: string
  sourceId: string
  startedAt: string
  finishedAt: string
  durationMs: number
  status: 'succeeded' | 'failed' | 'skipped'
  itemCount: number
  errorClass?: ProviderErrorClass
  error?: string
}

export interface ProviderHealth {
  state: 'healthy' | 'cooldown' | 'manual-recovery'
  retryAt?: string
  errorClass?: ProviderErrorClass
}

export interface ProviderHealthStore {
  load(providerId: string): Promise<ProviderHealth | undefined>
  save(providerId: string, health: ProviderHealth): Promise<void>
}

export interface InteractionSnapshot {
  capturedAt: string
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  saves: number | null
}

export interface ContentEvidence {
  discoveryUrl: string
  carrier:
    | 'youtube'
    | 'x-article'
    | 'external-article'
    | 'x-native-video'
    | 'x-short'
    | 'platform-video'
    | 'platform-image-post'
  sourceText?: string
  transcriptStatus?: 'available' | 'missing'
}

export interface ProviderResponseCapture {
  providerId: string
  receivedAt: string
  request: { method: 'GET' | 'POST'; url: string }
  payload: unknown
}

interface ProviderCursorEnvelope {
  providers: Record<string, string>
}

export function providerCursor(
  cursor: string | undefined,
  providerId: string
): string | undefined {
  if (!cursor) return undefined
  try {
    const parsed = JSON.parse(cursor) as ProviderCursorEnvelope
    return parsed.providers?.[providerId]
  } catch {
    return cursor
  }
}

export function updateProviderCursor(
  cursor: string | undefined,
  providerId: string,
  next: string | undefined
): string | undefined {
  let providers: Record<string, string> = {}
  if (cursor) {
    try {
      providers = {
        ...(JSON.parse(cursor) as ProviderCursorEnvelope).providers,
      }
    } catch {
      providers = {}
    }
  }
  if (next) providers[providerId] = next
  else delete providers[providerId]
  return Object.keys(providers).length
    ? JSON.stringify({ providers })
    : undefined
}

export type CaptureProviderResponse = (
  response: ProviderResponseCapture
) => void | Promise<void>

export class ProviderDiscoveryError extends Error {
  constructor(
    readonly errorClass: ProviderErrorClass,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'ProviderDiscoveryError'
  }
}

interface ProviderRouterOptions {
  providers: SourceAdapter[]
  audit(attempt: ProviderAttemptAudit): void | Promise<void>
  cooldownMs?: number
  maxAttempts?: number
  now?: () => Date
  healthStore?: ProviderHealthStore
}

export interface ProviderRouter {
  discover(request: DiscoveryRequest): Promise<DiscoveryBatch>
  health(providerId: string): ProviderHealth
  restore(providerId: string, verify: () => Promise<void>): Promise<void>
}

const secretPattern =
  /(["']?(?:api[_-]?key|token|authorization|cookie|secret|bearer|password)["']?\s*[:=]\s*["']?)([^\s,;"'}]+)/giu

function redactErrorValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactErrorValue)
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? redactPlainText(value) : value
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /(?:api[_-]?key|token|authorization|cookie|secret|bearer|password)/iu.test(
        key
      )
        ? '[REDACTED]'
        : redactErrorValue(entry),
    ])
  )
}

function redactPlainText(value: string): string {
  return value
    .replace(
      /((?:authorization|proxy-authorization)\s*:\s*)(?:bearer|basic)\s+[^\s,;]+/giu,
      '$1[REDACTED]'
    )
    .replace(/((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/giu, '$1[REDACTED]')
    .replace(/(bearer\s+)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(
      /([?&](?:api[_-]?key|key|token|access_token|secret)=)[^&#\s]+/giu,
      '$1[REDACTED]'
    )
    .replace(secretPattern, '$1[REDACTED]')
}

export function redactProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  try {
    return JSON.stringify(
      redactErrorValue(JSON.parse(message) as unknown)
    ).slice(0, 2_000)
  } catch {
    return redactPlainText(message).slice(0, 2_000)
  }
}

function asProviderError(error: unknown): ProviderDiscoveryError {
  if (error instanceof ProviderDiscoveryError) return error
  return new ProviderDiscoveryError('temporary', redactProviderError(error))
}

export function createProviderRouter(
  options: ProviderRouterOptions
): ProviderRouter {
  const now = options.now ?? (() => new Date())
  const cooldownMs = options.cooldownMs ?? 30 * 60_000
  const maxAttempts = options.maxAttempts ?? 3
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new Error('Provider attempt budget must be between 1 and 3')
  }
  const health = new Map<string, ProviderHealth>()

  const loadHealth = async (providerId: string): Promise<ProviderHealth> => {
    const cached = health.get(providerId)
    if (cached) return cached
    const stored = await options.healthStore?.load(providerId)
    const current = stored ?? { state: 'healthy' as const }
    health.set(providerId, current)
    return current
  }

  const saveHealth = async (
    providerId: string,
    state: ProviderHealth
  ): Promise<void> => {
    health.set(providerId, state)
    await options.healthStore?.save(providerId, state)
  }

  return {
    async discover(request) {
      const failures: string[] = []
      let attempts = 0
      for (const provider of options.providers) {
        if (provider.sourceType !== request.source.type) continue
        const state = await loadHealth(provider.providerId)
        const current = now()
        if (
          state.state === 'manual-recovery' ||
          (state.state === 'cooldown' &&
            state.retryAt &&
            new Date(state.retryAt) > current)
        ) {
          await options.audit({
            providerId: provider.providerId,
            sourceId: request.source.id,
            startedAt: current.toISOString(),
            finishedAt: current.toISOString(),
            durationMs: 0,
            status: 'skipped',
            itemCount: 0,
            errorClass: state.errorClass,
            error:
              state.state === 'manual-recovery'
                ? 'Provider requires manual recovery'
                : `Provider cooling down until ${state.retryAt}`,
          })
          continue
        }

        if (attempts >= maxAttempts) break
        attempts += 1

        const started = now()
        try {
          const batch = await provider.discover(request)
          const finished = now()
          await saveHealth(provider.providerId, { state: 'healthy' })
          await options.audit({
            providerId: provider.providerId,
            sourceId: request.source.id,
            startedAt: started.toISOString(),
            finishedAt: finished.toISOString(),
            durationMs: Math.max(0, finished.getTime() - started.getTime()),
            status: 'succeeded',
            itemCount: batch.items.length,
          })
          return { ...batch, providerId: provider.providerId }
        } catch (error) {
          const providerError = asProviderError(error)
          const finished = now()
          const manual =
            providerError.errorClass === 'credential' ||
            providerError.errorClass === 'balance' ||
            providerError.errorClass === 'invalid-request'
          await saveHealth(
            provider.providerId,
            manual
              ? {
                  state: 'manual-recovery',
                  errorClass: providerError.errorClass,
                }
              : {
                  state: 'cooldown',
                  retryAt: new Date(
                    finished.getTime() + cooldownMs
                  ).toISOString(),
                  errorClass: providerError.errorClass,
                }
          )
          const message = redactProviderError(providerError)
          failures.push(`${provider.providerId}: ${message}`)
          await options.audit({
            providerId: provider.providerId,
            sourceId: request.source.id,
            startedAt: started.toISOString(),
            finishedAt: finished.toISOString(),
            durationMs: Math.max(0, finished.getTime() - started.getTime()),
            status: 'failed',
            itemCount: 0,
            errorClass: providerError.errorClass,
            error: message,
          })
        }
      }
      throw new ProviderDiscoveryError(
        'temporary',
        `All providers failed for ${request.source.id}: ${failures.join('; ')}`
      )
    },
    health(providerId) {
      return health.get(providerId) ?? { state: 'healthy' }
    },
    async restore(providerId, verify) {
      await verify()
      await saveHealth(providerId, { state: 'healthy' })
    },
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const compact = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMB])\b/iu)
    if (compact) {
      const multiplier = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[
        compact[2]?.toUpperCase() as 'K' | 'M' | 'B'
      ]
      return Math.round(Number(compact[1]) * multiplier)
    }
    const parsed = Number(value.replace(/[^0-9.-]/gu, ''))
    if (Number.isFinite(parsed) && value.trim()) return parsed
  }
  return null
}

export function assertTikHubSuccess(payload: Record<string, unknown>): void {
  const code = numberOrNull(payload.code)
  if (code === 200) return
  if (code === null) {
    throw new ProviderDiscoveryError(
      'invalid-response',
      'TikHub response has no business status code'
    )
  }
  const body = JSON.stringify(payload)
  throw new ProviderDiscoveryError(
    classifyStatus(code, body),
    redactProviderError(body),
    code
  )
}

export function isoDate(value: unknown): string | undefined {
  const candidate = text(value)
  if (!candidate) return undefined
  const date = new Date(candidate)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export function titleFrom(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized ? normalized.slice(0, 160) : fallback
}

function youtubeVideoId(value: string): string | undefined {
  try {
    const url = new URL(value)
    const host = url.hostname.replace(/^www\./u, '')
    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0]
    if (host !== 'youtube.com' && host !== 'm.youtube.com') return undefined
    if (url.pathname === '/watch') return url.searchParams.get('v') ?? undefined
    const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/u)
    return match?.[1]
  } catch {
    return undefined
  }
}

export function normalizeYouTubeIdentity(value: string): {
  platformIdentity: string
  canonicalUrl: string
  videoId: string
} {
  const videoId =
    youtubeVideoId(value) ??
    (/^[A-Za-z0-9_-]{11}$/u.test(value) ? value : undefined)
  if (!videoId) throw new Error(`Invalid YouTube video identity: ${value}`)
  return {
    platformIdentity: `youtube:${videoId}`,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
  }
}

export interface XCarrierInput {
  tweetId: string
  text: string
  urls?: Array<{
    expandedUrl: string
    kind?: 'x-article' | 'article' | 'external'
  }>
  nativeVideo?: boolean
  tweetUrl?: string
}

export interface XCarrier {
  kind: ContentKind
  carrier: ContentEvidence['carrier']
  platformIdentity: string
  canonicalUrl: string
}

function canonicalArticleUrl(value: string): string {
  return canonicalizeContentUrl(value)
}

export function isXArticleUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(
        url.hostname.toLowerCase()
      ) && /^\/i\/article\/\d+\/?$/u.test(url.pathname)
    )
  } catch {
    return false
  }
}

export function selectXCarrier(input: XCarrierInput): XCarrier {
  for (const link of input.urls ?? []) {
    const videoId = youtubeVideoId(link.expandedUrl)
    if (videoId) {
      const identity = normalizeYouTubeIdentity(videoId)
      return { kind: 'video', carrier: 'youtube', ...identity }
    }
  }
  const xArticle = (input.urls ?? []).find(
    (link) => link.kind === 'x-article' || isXArticleUrl(link.expandedUrl)
  )
  if (xArticle) {
    return {
      kind: 'article',
      carrier: 'x-article',
      platformIdentity: `url:${canonicalArticleUrl(xArticle.expandedUrl)}`,
      canonicalUrl: canonicalArticleUrl(xArticle.expandedUrl),
    }
  }
  const externalArticle = (input.urls ?? []).find(
    (link) => link.kind === 'article' || link.kind === 'external'
  )
  if (externalArticle) {
    const canonicalUrl = canonicalArticleUrl(externalArticle.expandedUrl)
    return {
      kind: 'article',
      carrier: 'external-article',
      platformIdentity: `url:${canonicalUrl}`,
      canonicalUrl,
    }
  }
  const canonicalUrl =
    input.tweetUrl ??
    `https://x.com/i/status/${encodeURIComponent(input.tweetId)}`
  return {
    kind: input.nativeVideo ? 'video' : 'short_post',
    carrier: input.nativeVideo ? 'x-native-video' : 'x-short',
    platformIdentity: `x:${input.tweetId}`,
    canonicalUrl,
  }
}

function classifyStatus(status: number, body: string): ProviderErrorClass {
  if (/please retry|try again|请重试|稍后重试/iu.test(body)) return 'temporary'
  if (status === 401 || status === 403) return 'credential'
  if (status === 402 || /balance|credit|余额/iu.test(body)) return 'balance'
  if (status === 429) return 'rate-limit'
  if (status >= 500 || status === 408) return 'temporary'
  return 'invalid-request'
}

export async function fetchJson(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit,
  capture?: { providerId: string; callback?: CaptureProviderResponse }
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetcher(url, init)
  } catch (error) {
    throw new ProviderDiscoveryError('temporary', redactProviderError(error))
  }
  const body = await response.text()
  let payload: unknown
  try {
    payload = JSON.parse(body) as unknown
  } catch {
    payload = body
  }
  if (capture?.callback) {
    const safeUrl = new URL(url)
    for (const key of [...safeUrl.searchParams.keys()]) {
      if (/^(?:api[_-]?key|key|token|access_token|secret)$/iu.test(key)) {
        safeUrl.searchParams.set(key, '[REDACTED]')
      }
    }
    await capture.callback({
      providerId: capture.providerId,
      receivedAt: new Date().toISOString(),
      request: {
        method: init.method === 'POST' ? 'POST' : 'GET',
        url: safeUrl.toString(),
      },
      payload,
    })
  }
  if (!response.ok) {
    throw new ProviderDiscoveryError(
      classifyStatus(response.status, body),
      `HTTP ${response.status}: ${redactProviderError(body)}`,
      response.status
    )
  }
  if (typeof payload === 'string') {
    throw new ProviderDiscoveryError(
      'invalid-response',
      'Provider returned invalid JSON'
    )
  }
  return record(payload)
}

function xLinks(tweet: Record<string, unknown>): XCarrierInput['urls'] {
  const entities = record(tweet.entities)
  const candidates = [
    ...array(entities.urls),
    ...array(tweet.urls),
    ...array(record(tweet.extendedEntities).urls),
  ]
  const links: NonNullable<XCarrierInput['urls']> = candidates.flatMap(
    (candidate) => {
      if (typeof candidate === 'string')
        return [{ expandedUrl: candidate, kind: 'external' as const }]
      const value = record(candidate)
      const expandedUrl =
        text(value.expandedUrl) ?? text(value.expanded_url) ?? text(value.url)
      if (!expandedUrl) return []
      const kind: 'x-article' | 'external' =
        value.kind === 'x-article' || value.type === 'article'
          ? 'x-article'
          : 'external'
      return [{ expandedUrl, kind }]
    }
  )
  const article = record(tweet.article)
  const articleUrl = text(article.url) ?? text(article.article_url)
  if (articleUrl) links.push({ expandedUrl: articleUrl, kind: 'x-article' })
  return links
}

function xPostText(tweet: Record<string, unknown>): string | undefined {
  const note = record(tweet.note_tweet ?? tweet.noteTweet)
  return [
    text(tweet.text),
    text(tweet.fullText),
    text(tweet.full_text),
    text(note.text),
  ].sort((left, right) => (right?.length ?? 0) - (left?.length ?? 0))[0]
}

function xImages(
  tweet: Record<string, unknown>
): Array<{ order: number; url: string }> {
  const media = [
    ...array(record(tweet.extendedEntities).media),
    ...array(record(tweet.extended_entities).media),
    ...array(record(tweet.entities).media),
    ...array(tweet.media),
  ]
  const seen = new Set<string>()
  return media.flatMap((entry) => {
    const item = record(entry)
    const url =
      text(item.media_url_https) ?? text(item.media_url) ?? text(item.image_url)
    if (item.type !== 'photo' || !url || seen.has(url)) return []
    seen.add(url)
    return [{ order: seen.size - 1, url }]
  })
}

function xQuotedPost(tweet: Record<string, unknown>): XQuotedPost | undefined {
  const quoted = record(tweet.quoted_tweet ?? tweet.quotedTweet)
  const id = tweetId(quoted)
  if (!id) return undefined
  const author = record(quoted.author)
  return {
    url:
      text(quoted.url) ??
      text(quoted.twitterUrl) ??
      `https://x.com/i/status/${id}`,
    authorName: text(author.name),
    authorHandle:
      text(author.userName) ??
      text(author.user_name) ??
      text(author.screen_name),
    text: xPostText(quoted) ?? '',
    images: xImages(quoted),
  }
}

function mapTweet(
  tweetValue: unknown,
  capturedAt: string
): DiscoveredItem | undefined {
  const tweet = record(tweetValue)
  const externalId =
    text(tweet.id) ??
    text(tweet.tweetId) ??
    text(tweet.tweet_id) ??
    text(tweet.rest_id)
  if (!externalId) return undefined
  const sourceText = xPostText(tweet) ?? ''
  const tweetUrl = text(tweet.url) ?? text(tweet.twitterUrl)
  const media =
    array(record(tweet.extendedEntities).media).length > 0 ||
    array(tweet.media).length > 0
  const carrier = selectXCarrier({
    tweetId: externalId,
    text: sourceText,
    urls: xLinks(tweet),
    nativeVideo:
      media &&
      /video/iu.test(JSON.stringify(tweet.media ?? tweet.extendedEntities)),
    tweetUrl,
  })
  return {
    externalId,
    platformIdentity: carrier.platformIdentity,
    content: {
      kind: carrier.kind,
      canonicalUrl: carrier.canonicalUrl,
      title: titleFrom(sourceText, `X post ${externalId}`),
    },
    publishedAt: isoDate(tweet.createdAt ?? tweet.created_at),
    description: sourceText || undefined,
    images: xImages(tweet),
    quotedPost: xQuotedPost(tweet),
    interaction: {
      capturedAt,
      views: numberOrNull(tweet.viewCount ?? tweet.view_count ?? tweet.views),
      likes: numberOrNull(
        tweet.likeCount ??
          tweet.favorite_count ??
          tweet.favorites ??
          tweet.likes
      ),
      comments: numberOrNull(
        tweet.replyCount ?? tweet.reply_count ?? tweet.replies
      ),
      shares: numberOrNull(
        tweet.retweetCount ?? tweet.retweet_count ?? tweet.retweets
      ),
      saves: numberOrNull(
        tweet.bookmarkCount ?? tweet.bookmark_count ?? tweet.bookmarks
      ),
    },
    evidence: {
      discoveryUrl: tweetUrl ?? `https://x.com/i/status/${externalId}`,
      carrier: carrier.carrier,
      sourceText: sourceText || undefined,
    },
  }
}

function tweetId(tweet: Record<string, unknown>): string | undefined {
  return (
    text(tweet.id) ??
    text(tweet.tweetId) ??
    text(tweet.tweet_id) ??
    text(tweet.rest_id)
  )
}

export function mapXTweets(
  values: unknown[],
  capturedAt: string
): DiscoveredItem[] {
  const threads = new Map<string, Record<string, unknown>[]>()
  const results: DiscoveredItem[] = []
  for (const tweet of values.map(record)) {
    const retweeted = record(tweet.retweeted_tweet ?? tweet.retweetedTweet)
    if (tweetId(retweeted)) {
      const mapped = mapTweet(retweeted, capturedAt)
      const discoveryItem = mapTweet(tweet, capturedAt)
      const discoveryId = tweetId(tweet)
      if (mapped && discoveryId) {
        results.push({
          ...mapped,
          repostedBy: {
            name:
              text(record(tweet.author).name) ??
              text(record(tweet.author).userName) ??
              'X 用户',
            handle: text(record(tweet.author).userName),
            url:
              text(tweet.url) ??
              text(tweet.twitterUrl) ??
              `https://x.com/i/status/${discoveryId}`,
          },
          evidence: {
            carrier: mapped.evidence?.carrier ?? 'x-short',
            sourceText: mapped.evidence?.sourceText,
            transcriptStatus: mapped.evidence?.transcriptStatus,
            discoveryUrl:
              text(tweet.url) ??
              text(tweet.twitterUrl) ??
              `https://x.com/i/status/${discoveryId}`,
          },
          discoveryParts: [
            {
              externalId: discoveryId,
              discoveryUrl:
                text(tweet.url) ??
                text(tweet.twitterUrl) ??
                `https://x.com/i/status/${discoveryId}`,
              sourceText: xPostText(tweet),
              interaction: discoveryItem?.interaction,
            },
          ],
        })
      }
      continue
    }

    const author = record(tweet.author)
    const authorId = text(author.id) ?? text(author.rest_id)
    const authorName =
      text(author.userName) ??
      text(author.user_name) ??
      text(author.screen_name)
    const replyUserId =
      text(tweet.inReplyToUserId) ?? text(tweet.in_reply_to_user_id)
    const replyUserName =
      text(tweet.inReplyToUsername) ?? text(tweet.in_reply_to_screen_name)
    const isReply =
      tweet.isReply === true ||
      Boolean(
        tweet.inReplyToId ??
        tweet.in_reply_to_status_id ??
        replyUserId ??
        replyUserName
      )
    const isSelfReply =
      isReply &&
      ((authorId && replyUserId === authorId) ||
        (authorName &&
          replyUserName?.toLowerCase() === authorName.toLowerCase()))
    if (isReply && !isSelfReply) continue
    const id = tweetId(tweet)
    if (!id) continue
    const conversationId =
      text(tweet.conversationId) ?? text(tweet.conversation_id) ?? id
    const group = threads.get(conversationId) ?? []
    group.push(tweet)
    threads.set(conversationId, group)
  }

  for (const [conversationId, tweets] of threads) {
    tweets.sort((left, right) => {
      const leftTime = Date.parse(text(left.createdAt ?? left.created_at) ?? '')
      const rightTime = Date.parse(
        text(right.createdAt ?? right.created_at) ?? ''
      )
      return (
        (Number.isNaN(leftTime) ? 0 : leftTime) -
        (Number.isNaN(rightTime) ? 0 : rightTime)
      )
    })
    const exactRoot = tweets.find((tweet) => tweetId(tweet) === conversationId)
    const root =
      exactRoot ??
      tweets.find(
        (tweet) =>
          !(tweet.isReply ?? tweet.inReplyToId ?? tweet.in_reply_to_status_id)
      ) ??
      tweets[0]
    if (!root) continue
    const combinedText = tweets
      .map((tweet) => xPostText(tweet))
      .filter((value): value is string => Boolean(value))
      .join('\n\n')
    const combinedUrls = tweets.flatMap((tweet) => xLinks(tweet) ?? [])
    const mapped = mapTweet(
      {
        ...root,
        id: conversationId,
        url: `https://x.com/i/status/${conversationId}`,
        text: combinedText,
        urls: combinedUrls,
        conversationId,
      },
      capturedAt
    )
    if (mapped) {
      const discoveryId = tweetId(root) ?? conversationId
      results.push({
        ...mapped,
        images: tweets
          .flatMap((tweet) => xImages(tweet))
          .map((image, order) => ({ ...image, order })),
        externalId: discoveryId,
        evidence: {
          carrier: mapped.evidence?.carrier ?? 'x-short',
          sourceText: mapped.evidence?.sourceText,
          transcriptStatus: mapped.evidence?.transcriptStatus,
          discoveryUrl:
            text(root.url) ??
            text(root.twitterUrl) ??
            `https://x.com/i/status/${discoveryId}`,
        },
        thread:
          mapped.content.kind === 'short_post'
            ? {
                conversationId,
                complete: Boolean(exactRoot),
                parts: tweets.flatMap((tweet) => {
                  const id = tweetId(tweet)
                  const partText = text(xPostText(tweet))
                  return id && partText
                    ? [
                        {
                          id,
                          text: partText,
                          publishedAt: isoDate(
                            tweet.createdAt ?? tweet.created_at
                          ),
                        },
                      ]
                    : []
                }),
              }
            : undefined,
        discoveryParts: tweets.flatMap((tweet) => {
          const externalId = tweetId(tweet)
          if (!externalId) return []
          return [
            {
              externalId,
              discoveryUrl:
                text(tweet.url) ??
                text(tweet.twitterUrl) ??
                `https://x.com/i/status/${externalId}`,
              sourceText: xPostText(tweet),
              interaction: mapTweet(tweet, capturedAt)?.interaction,
            },
          ]
        }),
      })
    }
  }

  const unique = new Map<string, DiscoveredItem>()
  for (const item of results) {
    const key = item.platformIdentity ?? item.externalId
    const discoveryParts = item.discoveryParts ?? [
      {
        externalId: item.externalId,
        discoveryUrl:
          item.evidence?.discoveryUrl ??
          `https://x.com/i/status/${item.externalId}`,
        sourceText: item.evidence?.sourceText,
        interaction: item.interaction,
      },
    ]
    const existing = unique.get(key)
    if (!existing) {
      unique.set(key, { ...item, discoveryParts })
      continue
    }
    const mergedParts = new Map(
      [...(existing.discoveryParts ?? []), ...discoveryParts].map((part) => [
        part.externalId,
        part,
      ])
    )
    const primary = key === `x:${item.externalId}` ? item : existing
    unique.set(key, {
      ...primary,
      discoveryParts: [...mergedParts.values()],
    })
  }
  return [...unique.values()]
}

export function createTwitterApiIoProvider(options: {
  apiKey: string
  fetch?: typeof fetch
  baseUrl?: string
  captureResponse?: CaptureProviderResponse
}): SourceAdapter {
  const fetcher = options.fetch ?? fetch
  const baseUrl = options.baseUrl ?? 'https://api.twitterapi.io'
  return defineSourceAdapter({
    providerId: 'twitterapi.io',
    sourceType: 'x',
    async discover(request) {
      const headers = { 'X-API-Key': options.apiKey }
      const profileUrl = new URL('/twitter/user/info', baseUrl)
      profileUrl.searchParams.set(
        'userName',
        request.source.externalIdentity.replace(/^@/u, '')
      )
      const profile = await fetchJson(
        fetcher,
        profileUrl,
        { headers },
        {
          providerId: 'twitterapi.io',
          callback: options.captureResponse,
        }
      )
      const profileData = record(profile.data)
      const userId =
        text(profileData.id) ??
        text(profileData.userId) ??
        text(profileData.rest_id)
      if (!userId)
        throw new ProviderDiscoveryError(
          'invalid-response',
          'Twitter profile has no user id'
        )
      const timelineUrl = new URL('/twitter/user/tweet_timeline', baseUrl)
      timelineUrl.searchParams.set('userId', userId)
      const cursor = providerCursor(request.cursor, 'twitterapi.io')
      if (cursor) timelineUrl.searchParams.set('cursor', cursor)
      const payload = await fetchJson(
        fetcher,
        timelineUrl,
        { headers },
        {
          providerId: 'twitterapi.io',
          callback: options.captureResponse,
        }
      )
      const data = record(payload.data)
      const capturedAt = new Date().toISOString()
      const items = limitItems(
        mapXTweets(array(data.tweets ?? payload.tweets), capturedAt),
        request.limit
      )
      return {
        items,
        nextCursor: updateProviderCursor(
          request.cursor,
          'twitterapi.io',
          text(data.next_cursor ?? data.nextCursor ?? payload.next_cursor)
        ),
      }
    },
  })
}

export async function fetchTwitterApiIoArticle(options: {
  apiKey: string
  tweetId: string
  canonicalUrl: string
  fetch?: typeof fetch
  baseUrl?: string
  captureResponse?: CaptureProviderResponse
}): Promise<{ title: string; body: string; canonicalUrl: string }> {
  if (!options.apiKey) {
    throw new ProviderDiscoveryError(
      'credential',
      'X Article provider is not configured'
    )
  }
  if (!/^\d+$/u.test(options.tweetId) || !isXArticleUrl(options.canonicalUrl)) {
    throw new ProviderDiscoveryError(
      'invalid-response',
      'X Article identity is invalid'
    )
  }
  const baseUrl = options.baseUrl ?? 'https://api.twitterapi.io'
  const fetcher = options.fetch ?? fetch
  const headers = { 'X-API-Key': options.apiKey }
  const fetchArticle = async (tweetId: string) => {
    const url = new URL('/twitter/article', baseUrl)
    url.searchParams.set('tweet_id', tweetId)
    return fetchJson(
      fetcher,
      url,
      { headers },
      {
        providerId: 'twitterapi.io-article',
        callback: options.captureResponse,
      }
    )
  }
  let payload = await fetchArticle(options.tweetId)
  if (payload.status === 'failed') {
    // Older records saved the repost ID as the content's external ID.
    // Resolve it once; discovery records continue to retain the repost ID.
    const tweetUrl = new URL('/twitter/tweets', baseUrl)
    tweetUrl.searchParams.set('tweet_ids', options.tweetId)
    const tweets = await fetchJson(
      fetcher,
      tweetUrl,
      { headers },
      {
        providerId: 'twitterapi.io-tweets',
        callback: options.captureResponse,
      }
    )
    const tweet = array(tweets.tweets)
      .map(record)
      .find((candidate) => tweetId(candidate) === options.tweetId)
    const originalId = tweetId(
      record(tweet?.retweeted_tweet ?? tweet?.retweetedTweet)
    )
    if (
      originalId &&
      /^\d+$/u.test(originalId) &&
      originalId !== options.tweetId
    ) {
      payload = await fetchArticle(originalId)
    }
  }
  if (payload.status !== 'success') {
    throw new ProviderDiscoveryError(
      'invalid-response',
      'X Article provider did not succeed'
    )
  }
  const article = record(payload.article)
  const title = text(article.title)
  const body = array(article.contents)
    .map((entry) => text(record(entry).text))
    .filter((part): part is string => Boolean(part))
    .join('\n\n')
  if (!title || body.length < 200) {
    throw new ProviderDiscoveryError(
      'invalid-response',
      'X Article body is incomplete'
    )
  }
  return {
    title,
    body,
    canonicalUrl: canonicalArticleUrl(options.canonicalUrl),
  }
}

function channelHandle(identity: string): string {
  const match = identity.match(/(?:youtube\.com\/)?@([^/?]+)/iu)
  return (match?.[1] ?? identity).replace(/^@/u, '')
}

function durationSeconds(value: unknown): number | undefined {
  const duration = text(value)
  if (!duration) return undefined
  const iso = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/u)
  if (iso)
    return (
      Number(iso[1] ?? 0) * 3600 +
      Number(iso[2] ?? 0) * 60 +
      Number(iso[3] ?? 0)
    )
  const parts = duration.split(':').map(Number)
  if (parts.some(Number.isNaN)) return undefined
  return parts.reduce((total, part) => total * 60 + part, 0)
}

function mapYouTubeVideo(
  value: unknown,
  capturedAt: string,
  scope: 'normal' | 'short' | 'live-replay' = 'normal'
): DiscoveredItem | undefined {
  const video = record(value)
  const videoId = text(video.id) ?? text(video.video_id) ?? text(video.videoId)
  if (!videoId) return undefined
  const snippet = record(video.snippet)
  const details = record(video.contentDetails)
  const statistics = record(video.statistics)
  if (snippet.liveBroadcastContent === 'live' || video.is_live === true)
    return undefined
  const seconds = durationSeconds(details.duration ?? video.duration)
  const identity = normalizeYouTubeIdentity(videoId)
  const title =
    text(snippet.title) ?? text(video.title) ?? `YouTube video ${videoId}`
  return {
    externalId: videoId,
    platformIdentity: identity.platformIdentity,
    content: { kind: 'video', canonicalUrl: identity.canonicalUrl, title },
    publishedAt: isoDate(
      snippet.publishedAt ?? video.published_at ?? video.publishedAt
    ),
    description: text(snippet.description) ?? text(video.description),
    interaction: {
      capturedAt,
      views: numberOrNull(statistics.viewCount ?? video.view_count),
      likes: numberOrNull(statistics.likeCount ?? video.like_count),
      comments: numberOrNull(statistics.commentCount ?? video.comment_count),
      shares: null,
      saves: null,
    },
    evidence: {
      discoveryUrl: text(video.url) ?? identity.canonicalUrl,
      carrier: 'youtube',
      transcriptStatus: 'missing',
    },
    video: { scope, durationSeconds: seconds },
  }
}

async function normalVideoPage(
  fetcher: typeof fetch,
  baseUrl: string,
  handle: string,
  continuation: string | undefined,
  captureResponse?: CaptureProviderResponse
): Promise<{ ids: string[]; nextCursor?: string }> {
  if (!/^[A-Za-z0-9._-]+$/u.test(handle)) {
    throw new ProviderDiscoveryError(
      'invalid-request',
      'YouTube handle contains unsupported characters'
    )
  }
  const url = new URL(`/@${handle}/videos`, baseUrl)
  let response: Response
  try {
    response = await fetcher(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  } catch (error) {
    throw new ProviderDiscoveryError('temporary', redactProviderError(error))
  }
  if (!response.ok) {
    throw new ProviderDiscoveryError(
      classifyStatus(response.status, ''),
      `YouTube videos tab failed: HTTP ${response.status}`,
      response.status
    )
  }
  const html = await response.text()
  let page = html
  if (continuation) {
    const apiKey = text(html.match(/"INNERTUBE_API_KEY":"([^"]+)"/u)?.[1])
    const clientVersion = text(
      html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/u)?.[1]
    )
    if (!apiKey || !clientVersion) {
      throw new ProviderDiscoveryError(
        'invalid-response',
        'YouTube videos tab has no continuation client metadata'
      )
    }
    const browseUrl = new URL('/youtubei/v1/browse', baseUrl)
    browseUrl.searchParams.set('key', apiKey)
    const continuationPayload = await fetchJson(
      fetcher,
      browseUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          context: {
            client: { clientName: 'WEB', clientVersion },
          },
          continuation,
        }),
      },
      { providerId: 'youtube-data-api', callback: captureResponse }
    )
    page = JSON.stringify(continuationPayload)
  }
  const ids = [
    ...new Set(
      [...page.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/gu)].map(
        (match) => match[1] as string
      )
    ),
  ]
  if (!ids.length) {
    throw new ProviderDiscoveryError(
      'invalid-response',
      'YouTube videos tab contains no normal video identities'
    )
  }
  const continuationTokens = [
    ...page.matchAll(/"continuationCommand":\{"token":"([^"]+)"/gu),
  ]
    .map((match) => match[1] as string)
    .sort((left, right) => right.length - left.length)
  return { ids, nextCursor: continuationTokens[0] }
}

export function createYouTubeDataApiProvider(options: {
  apiKey: string
  fetch?: typeof fetch
  baseUrl?: string
  webBaseUrl?: string
  captureResponse?: CaptureProviderResponse
}): SourceAdapter {
  const fetcher = options.fetch ?? fetch
  const baseUrl = options.baseUrl ?? 'https://www.googleapis.com/youtube/v3/'
  return defineSourceAdapter({
    providerId: 'youtube-data-api',
    sourceType: 'youtube',
    async discover(request) {
      const handle = channelHandle(request.source.externalIdentity)
      const page = await normalVideoPage(
        fetcher,
        options.webBaseUrl ?? 'https://www.youtube.com',
        handle,
        providerCursor(request.cursor, 'youtube-data-api'),
        options.captureResponse
      )
      const videosUrl = new URL('videos', baseUrl)
      videosUrl.search = new URLSearchParams({
        part: 'snippet,contentDetails,statistics,liveStreamingDetails',
        id: page.ids
          .slice(
            0,
            request.limit === undefined ? 50 : Math.min(50, request.limit)
          )
          .join(','),
        key: options.apiKey,
      }).toString()
      const videos = await fetchJson(
        fetcher,
        videosUrl,
        {},
        {
          providerId: 'youtube-data-api',
          callback: options.captureResponse,
        }
      )
      const capturedAt = new Date().toISOString()
      const pageIds = new Set(page.ids)
      const items = limitItems(
        array(videos.items)
          .filter((video) => {
            const value = record(video)
            const id =
              text(value.id) ?? text(value.video_id) ?? text(value.videoId)
            return Boolean(id && pageIds.has(id))
          })
          .map((video) => mapYouTubeVideo(video, capturedAt))
          .filter((item): item is DiscoveredItem => Boolean(item)),
        request.limit
      )
      return {
        items,
        nextCursor: updateProviderCursor(
          request.cursor,
          'youtube-data-api',
          page.nextCursor
        ),
      }
    },
  })
}

export function createTikHubXProvider(options: {
  token: string
  fetch?: typeof fetch
  baseUrl?: string
  captureResponse?: CaptureProviderResponse
}): SourceAdapter {
  const fetcher = options.fetch ?? fetch
  const baseUrl = options.baseUrl ?? 'https://api.tikhub.io'
  return defineSourceAdapter({
    providerId: 'tikhub-x',
    sourceType: 'x',
    async discover(request) {
      const url = new URL('/api/v1/twitter/web/fetch_user_post_tweet', baseUrl)
      url.searchParams.set(
        'screen_name',
        request.source.externalIdentity.replace(/^@/u, '')
      )
      const cursor = providerCursor(request.cursor, 'tikhub-x')
      if (cursor) url.searchParams.set('cursor', cursor)
      const payload = await fetchJson(
        fetcher,
        url,
        { headers: { Authorization: `Bearer ${options.token}` } },
        { providerId: 'tikhub-x', callback: options.captureResponse }
      )
      assertTikHubSuccess(payload)
      const data = record(payload.data)
      const capturedAt = new Date().toISOString()
      const candidates = array(
        data.timeline ?? data.tweets ?? data.items ?? data
      )
      const items = limitItems(
        mapXTweets(
          candidates.map((tweet) => record(record(tweet).tweet ?? tweet)),
          capturedAt
        ),
        request.limit
      )
      if (!items.length && candidates.length)
        throw new ProviderDiscoveryError(
          'invalid-response',
          'TikHub X response contains no recognizable tweets'
        )
      return {
        items,
        nextCursor: updateProviderCursor(
          request.cursor,
          'tikhub-x',
          text(data.cursor ?? data.next_cursor ?? data.nextCursor)
        ),
      }
    },
  })
}

export function createTikHubYouTubeProvider(options: {
  token: string
  channelId: string
  fetch?: typeof fetch
  baseUrl?: string
  captureResponse?: CaptureProviderResponse
}): SourceAdapter {
  const fetcher = options.fetch ?? fetch
  const baseUrl = options.baseUrl ?? 'https://api.tikhub.io'
  return defineSourceAdapter({
    providerId: 'tikhub-youtube',
    sourceType: 'youtube',
    async discover(request) {
      const url = new URL('/api/v1/youtube/web_v2/get_channel_videos', baseUrl)
      url.searchParams.set('channel_id', options.channelId)
      url.searchParams.set('need_format', 'true')
      const cursor = providerCursor(request.cursor, 'tikhub-youtube')
      if (cursor) url.searchParams.set('continuation_token', cursor)
      const payload = await fetchJson(
        fetcher,
        url,
        { headers: { Authorization: `Bearer ${options.token}` } },
        { providerId: 'tikhub-youtube', callback: options.captureResponse }
      )
      assertTikHubSuccess(payload)
      const data = record(payload.data)
      const capturedAt = new Date().toISOString()
      const items = limitItems(
        array(data.videos)
          .map((video) => mapYouTubeVideo(video, capturedAt))
          .filter((item): item is DiscoveredItem => Boolean(item)),
        request.limit
      )
      return {
        items,
        nextCursor: updateProviderCursor(
          request.cursor,
          'tikhub-youtube',
          text(data.continuation_token ?? data.continuationToken)
        ),
      }
    },
  })
}

export interface VideoTranscriptResult {
  status: 'available' | 'missing' | 'processing'
  text?: string
  languageCode?: string
  jobId?: string
}

export interface VideoTranscriptProvider {
  providerId: string
  fetchTranscript(videoId: string): Promise<VideoTranscriptResult>
}

export interface VideoTranscriber {
  providerId: string
  transcribe(input: {
    videoId: string
    canonicalUrl: string
    mediaUrl?: string
    providerReference?: string
  }): Promise<string>
}

export interface ImagePostDetailProvider {
  providerId: string
  fetchDetail(input: { contentId: string; canonicalUrl: string }): Promise<{
    sourceText: string
    images: Array<{ order: number; url: string }>
  }>
}

export function createTikHubYouTubeTranscriptProvider(options: {
  token: string
  fetch?: typeof fetch
  baseUrl?: string
  preferredLanguages?: string[]
  captureResponse?: CaptureProviderResponse
}): VideoTranscriptProvider {
  const fetcher = options.fetch ?? fetch
  const baseUrl = options.baseUrl ?? 'https://api.tikhub.io'
  const endpoint = '/api/v1/youtube/web_v2/get_video_captions'
  const providerId = 'tikhub-youtube-captions'
  return {
    providerId,
    async fetchTranscript(videoId) {
      normalizeYouTubeIdentity(videoId)
      const listUrl = new URL(endpoint, baseUrl)
      listUrl.searchParams.set('video_id', videoId)
      const listPayload = await fetchJson(
        fetcher,
        listUrl,
        { headers: { Authorization: `Bearer ${options.token}` } },
        { providerId, callback: options.captureResponse }
      )
      assertTikHubSuccess(listPayload)
      const listData = record(listPayload.data)
      if (text(listData.status) === 'processing') {
        return {
          status: 'processing',
          jobId: text(listData.job_id ?? listData.jobId),
        }
      }
      const captions = array(listData.captions)
      if (!captions.length) return { status: 'missing' }
      const available = captions
        .map((caption) => {
          const value = record(caption)
          return text(value.language_code ?? value.languageCode)
        })
        .filter((language): language is string => Boolean(language))
      const preferred = options.preferredLanguages ?? [
        'zh-Hans',
        'zh-CN',
        'en',
        'en-US',
        'a.en',
      ]
      const languageCode =
        preferred.find((language) => available.includes(language)) ??
        available[0]
      if (!languageCode) return { status: 'missing' }
      const contentUrl = new URL(endpoint, baseUrl)
      contentUrl.searchParams.set('video_id', videoId)
      contentUrl.searchParams.set('language_code', languageCode)
      contentUrl.searchParams.set('format', 'txt')
      const contentPayload = await fetchJson(
        fetcher,
        contentUrl,
        { headers: { Authorization: `Bearer ${options.token}` } },
        { providerId, callback: options.captureResponse }
      )
      assertTikHubSuccess(contentPayload)
      const contentData = record(contentPayload.data)
      if (text(contentData.status) === 'processing') {
        return {
          status: 'processing',
          jobId: text(contentData.job_id ?? contentData.jobId),
          languageCode,
        }
      }
      const transcript =
        text(contentPayload.data) ??
        text(contentData.content) ??
        text(contentData.text) ??
        text(contentData.transcript)
      return transcript
        ? { status: 'available', text: transcript, languageCode }
        : { status: 'missing' }
    },
  }
}

export function decideVideoEnrichment(input: {
  hasTranscript: boolean
  durationSeconds?: number
  autoTranscribe: boolean
}): {
  status:
    'ready' | 'auto-transcription-pending' | 'waiting-manual-transcription'
} {
  if (input.hasTranscript) return { status: 'ready' }
  if (
    input.autoTranscribe &&
    input.durationSeconds !== undefined &&
    input.durationSeconds <= 7_200
  ) {
    return { status: 'auto-transcription-pending' }
  }
  return { status: 'waiting-manual-transcription' }
}

export function defineSourceAdapter(
  adapter: SourceAdapterDefinition
): SourceAdapter {
  return {
    ...adapter,
    async discover(request) {
      if (request.source.type !== adapter.sourceType) {
        throw new Error(
          `Provider ${adapter.providerId} does not support source type ${request.source.type}`
        )
      }
      const batch = await adapter.discover(request)
      return { ...batch, providerId: adapter.providerId }
    },
  }
}

export {
  createTikHubDouyinProvider,
  createTikHubXiaohongshuDetailProvider,
  fetchTikHubWechatChannelsMedia,
  createTikHubWechatChannelsProvider,
  createTikHubXiaohongshuProvider,
} from './chinese-platforms.js'
export {
  createGetBijiDouyinProvider,
  createGetBijiDouyinTranscriber,
} from './getbiji.js'
