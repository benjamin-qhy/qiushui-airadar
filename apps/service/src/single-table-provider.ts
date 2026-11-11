import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  enrichArticle,
  RssAdapter,
  type ConfiguredSource,
  type DiscoveredContent,
  type SingleTableSourceProvider,
} from '@qiushui-airadar/pipeline'
import {
  createTikHubXProvider,
  createTikHubYouTubeProvider,
  createTikHubYouTubeTranscriptProvider,
  createTwitterApiIoProvider,
  createYouTubeDataApiProvider,
  fetchTwitterApiIoArticle,
  isXArticleUrl,
  normalizeYouTubeIdentity,
  mapXTweets,
  fetchJson,
  type DiscoveredItem,
  type SourceAdapter,
} from '@qiushui-airadar/source-adapters'
import type { LogEvent } from '@qiushui-airadar/runtime'
import {
  defaultProviderRoutes,
  type ProviderRoutes,
} from '@qiushui-airadar/config'

interface ProviderOptions {
  tikHubToken?: string
  twitterApiKey?: string
  youtubeApiKey?: string
  fetch?: typeof fetch
  articleEnricher?: typeof enrichArticle
  xVideoTranscriber?: (url: string) => Promise<string>
  providerRoutes?: Partial<ProviderRoutes>
  onRequest?: (metric: ProviderRequestMetric) => Promise<void>
  userIdCacheFile?: string
  maxRetries?: number
  requestsPerSecond?: number
}

export interface ProviderRequestMetric {
  at: string
  sourceId: string
  endpoint: string
  status?: number
  durationMs: number
  returnedCount?: number
  estimatedCostUsd?: number
}

function routeFailure(capability: string, errors: string[]): Error {
  return new Error(
    `All providers failed for ${capability}: ${errors.join(' | ')}`
  )
}

function auditFetch(
  fetcher: typeof fetch,
  calls: Array<{ request: unknown; response: unknown }>,
  sourceId: string,
  onRequest?: ProviderOptions['onRequest'],
  maxRetries = 2
): typeof fetch {
  async function recordMetric(metric: ProviderRequestMetric) {
    try {
      await onRequest?.(metric)
    } catch (error) {
      throw Object.assign(
        new Error('请求统计写入失败，已停止额外重试', { cause: error }),
        { code: 'AUDIT_WRITE_FAILED' }
      )
    }
  }
  const attempt: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined
    const method = init?.method ?? request?.method ?? 'GET'
    const url = String(request?.url ?? input)
    const body = init?.body
      ? String(init.body)
      : request?.body
        ? await request.clone().text()
        : undefined
    const headers = Object.fromEntries(
      [...new Headers(init?.headers ?? request?.headers).entries()].map(
        ([key, value]) => [
          key,
          /authorization|api.?key|cookie/iu.test(key) ? '[REDACTED]' : value,
        ]
      )
    )
    const started = Date.now()
    let metric: ProviderRequestMetric = {
      at: new Date().toISOString(),
      sourceId,
      endpoint: new URL(url).origin + new URL(url).pathname,
      durationMs: 0,
    }
    try {
      const response = await fetcher(input, init)
      const responseBody = await response.clone().text()
      metric.status = response.status
      try {
        const payload = JSON.parse(responseBody)
        const tweets = payload.tweets ?? payload.data?.tweets
        if (Array.isArray(tweets)) metric.returnedCount = tweets.length
      } catch {
        /* Non-JSON responses are audited without a price estimate. */
      }
      if (response.ok && new URL(url).hostname === 'api.twitterapi.io') {
        const endpoint = new URL(url).pathname
        if (endpoint === '/twitter/user/info') metric.estimatedCostUsd = 0.00018
        else if (endpoint === '/twitter/article')
          metric.estimatedCostUsd = 0.001
        else if (metric.returnedCount !== undefined)
          metric.estimatedCostUsd = Math.max(1, metric.returnedCount) * 0.00015
      } else if (
        response.ok &&
        new URL(url).hostname === 'api.tikhub.io' &&
        new URL(url).pathname === '/api/v1/youtube/web_v2/get_video_captions'
      ) {
        metric.estimatedCostUsd = 0.008
      }
      calls.push({
        request: { method, url, headers, body },
        response: {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: responseBody,
        },
      })
      return response
    } catch (error) {
      calls.push({
        request: { method, url, headers, body },
        response: {
          received: false,
          errorType: error instanceof Error ? error.name : 'unknown',
        },
      })
      throw error
    } finally {
      metric = { ...metric, durationMs: Date.now() - started }
      await recordMetric(metric)
    }
  }
  return async (input, init) => {
    for (let retry = 0; ; retry++) {
      try {
        const response = await attempt(input, init)
        if (
          retry >= maxRetries ||
          (response.status !== 429 && response.status < 500)
        )
          return response
      } catch (error) {
        if (
          retry >= maxRetries ||
          init?.signal?.aborted ||
          (error as NodeJS.ErrnoException).code === 'AUDIT_WRITE_FAILED'
        )
          throw error
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2000, 250 * 2 ** retry))
      )
    }
  }
}

function toLogEvents(
  calls: Array<{ request: unknown; response: unknown }>,
  action: string
): LogEvent[] {
  return calls.map(({ request, response }) => {
    const result = response as { status?: number; received?: boolean }
    return {
      action,
      stage: action === 'discover' ? 'discovered' : 'enriching',
      status:
        result.received === false || (result.status ?? 200) >= 400
          ? 'failed'
          : 'succeeded',
      request,
      response,
    }
  })
}

function accountName(source: ConfiguredSource): string {
  return source.account_name.replace(/^(?:X|YouTube)\s*\/\s*/iu, '').trim()
}

export function createSingleTableSourceProvider(
  options: ProviderOptions
): SingleTableSourceProvider {
  const rawFetch = options.fetch ?? fetch
  let nextRequestAt = 0
  // Retries share the configured request-start rate with normal requests.
  const fetcher: typeof fetch = async (input, init) => {
    const now = Date.now()
    const reserved = Math.max(now, nextRequestAt)
    nextRequestAt =
      reserved +
      (options.fetch && options.requestsPerSecond === undefined
        ? 0
        : 1000 / (options.requestsPerSecond ?? 4))
    if (reserved > now)
      await new Promise((resolve) => setTimeout(resolve, reserved - now))
    return rawFetch(input, {
      ...init,
      signal: AbortSignal.any([
        ...(init?.signal ? [init.signal] : []),
        AbortSignal.timeout(20_000),
      ]),
    })
  }
  const discovered = new Map<string, DiscoveredItem>()
  const userIds = new Map<string, string>()
  const cacheReady = options.userIdCacheFile
    ? readFile(options.userIdCacheFile, 'utf8')
        .then((text) => {
          for (const [key, value] of Object.entries(JSON.parse(text)))
            if (typeof value === 'string') userIds.set(key, value)
        })
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        })
    : Promise.resolve()
  let savingIds = Promise.resolve()
  return {
    async discover(source, limit, window) {
      await cacheReady
      const calls: Array<{ request: unknown; response: unknown }> = []
      const trackedFetch = auditFetch(
        fetcher,
        calls,
        source.id,
        options.onRequest,
        options.maxRetries
      )
      if (source.platform === 'x' && window?.mode === 'search') {
        if (
          !options.twitterApiKey ||
          !(
            options.providerRoutes?.x_list ?? defaultProviderRoutes.x_list
          ).includes('twitterapi.io')
        )
          throw new Error(
            '增量搜索需要可用的 TwitterAPI.io；保留采集位置，可切换时间线模式核查。'
          )
        const url = new URL(
          'https://api.twitterapi.io/twitter/tweet/advanced_search'
        )
        const handle = source.external_identity.replace(/^@/u, '')
        if (!/^[a-z0-9_]{1,15}$/iu.test(handle)) throw new Error('X 用户名无效')
        url.searchParams.set(
          'query',
          `from:${handle} include:nativeretweets -filter:replies since_time:${Math.floor(Date.parse(window.since) / 1000)} until_time:${Math.ceil(Date.parse(window.until) / 1000)}`
        )
        url.searchParams.set('queryType', 'Latest')
        if (window.cursor) url.searchParams.set('cursor', window.cursor)
        const payload = await fetchJson(trackedFetch, url, {
          headers: { 'X-API-Key': options.twitterApiKey },
        })
        const raw =
          payload.tweets ??
          (payload.data as { tweets?: unknown[] } | undefined)?.tweets
        if (!Array.isArray(raw))
          throw new Error('Twitter 搜索响应缺少帖子列表，未推进位置')
        if (typeof payload.has_next_page !== 'boolean')
          throw new Error('Twitter 搜索响应缺少分页标志，未推进位置')
        const items = mapXTweets(raw, new Date().toISOString()).map((item) => {
          discovered.set(`${source.id}:${item.externalId}`, item)
          return {
            externalId: item.externalId,
            url: item.content.canonicalUrl,
            title: item.content.title,
            publishedAt: item.publishedAt,
            body: item.description,
            interaction: item.interaction,
            kind: item.content.kind,
            videoDurationSeconds: item.video?.durationSeconds,
            videoScope: item.video?.scope,
            opaque: item,
          }
        })
        const cursor = payload.next_cursor
        if (
          payload.has_next_page === true &&
          (typeof cursor !== 'string' || !cursor)
        )
          throw new Error('Twitter 搜索分页响应无效，未推进位置')
        return {
          providerId: 'twitterapi.io',
          items,
          rawCount: raw.length,
          nextCursor:
            payload.has_next_page === true ? String(cursor) : undefined,
          request: calls.map((call) => call.request),
          response: calls.map((call) => call.response),
        }
      }
      if (source.platform === 'rss') {
        if (
          !(
            options.providerRoutes?.rss_list ?? defaultProviderRoutes.rss_list
          ).includes('native-rss')
        )
          throw routeFailure('rss_list', ['native-rss is not configured'])
        const batch = await new RssAdapter(trackedFetch).discover({
          feedUrl: source.external_identity,
          limit,
        })
        return {
          providerId: 'native-rss',
          items: batch.items.map((item) => ({
            externalId: item.externalId,
            mediaType: item.mediaType,
            url: item.canonicalUrl,
            title: item.title,
            publishedAt: item.publishedAt,
            kind: 'article' as const,
            format: 'plain_text' as const,
          })),
          request: calls.map((call) => call.request),
          response: calls.map((call) => call.response),
        }
      }
      let adapter: SourceAdapter | undefined
      let batch: Awaited<ReturnType<SourceAdapter['discover']>> | undefined
      if (source.platform === 'x') {
        const errors: string[] = []
        for (const id of options.providerRoutes?.x_list ??
          defaultProviderRoutes.x_list) {
          try {
            if (id === 'twitterapi.io') {
              if (!options.twitterApiKey)
                throw new Error('credential is not configured')
              adapter = createTwitterApiIoProvider({
                apiKey: options.twitterApiKey,
                fetch: trackedFetch,
                userId: userIds.get(source.external_identity.toLowerCase()),
                strictPagination: Boolean(window),
                async onUserId(id) {
                  userIds.set(source.external_identity.toLowerCase(), id)
                  if (!options.userIdCacheFile) return
                  const file = options.userIdCacheFile
                  savingIds = savingIds.then(async () => {
                    await mkdir(path.dirname(file), { recursive: true })
                    const temporary = `${file}.${randomUUID()}.tmp`
                    await writeFile(
                      temporary,
                      JSON.stringify(Object.fromEntries(userIds)),
                      { mode: 0o600 }
                    )
                    await rename(temporary, file)
                  })
                  await savingIds
                },
              })
            } else {
              if (!options.tikHubToken)
                throw new Error('credential is not configured')
              adapter = createTikHubXProvider({
                token: options.tikHubToken,
                fetch: trackedFetch,
              })
            }
            batch = await adapter.discover({
              source: {
                id: source.id,
                slug: source.id,
                name: source.account_name,
                type: 'x',
                language: source.language,
                externalIdentity: source.external_identity,
                status: 'enabled',
              },
              limit,
              cursor: window?.cursor,
            })
            break
          } catch (error) {
            errors.push(
              `${id}: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        }
        if (!batch || !adapter) throw routeFailure('x_list', errors)
      } else if (source.platform === 'youtube') {
        const errors: string[] = []
        for (const id of options.providerRoutes?.youtube_list ??
          defaultProviderRoutes.youtube_list) {
          try {
            if (id === 'youtube-data-api') {
              if (!options.youtubeApiKey)
                throw new Error('credential is not configured')
              adapter = createYouTubeDataApiProvider({
                apiKey: options.youtubeApiKey,
                fetch: trackedFetch,
              })
            } else {
              if (!options.tikHubToken)
                throw new Error('credential is not configured')
              const channelUrl = new URL(source.external_identity)
              const response = await trackedFetch(channelUrl, {
                signal: AbortSignal.timeout(10_000),
              })
              if (!response.ok)
                throw new Error(
                  `YouTube channel lookup failed: ${response.status}`
                )
              const html = await response.text()
              const channelId =
                html.match(/"channelId":"(UC[A-Za-z0-9_-]+)"/u)?.[1] ??
                html.match(
                  /itemprop="channelId" content="(UC[A-Za-z0-9_-]+)"/u
                )?.[1]
              if (!channelId)
                throw new Error('YouTube channel ID was not found')
              adapter = createTikHubYouTubeProvider({
                token: options.tikHubToken,
                channelId,
                fetch: trackedFetch,
              })
            }
            batch = await adapter.discover({
              source: {
                id: source.id,
                slug: source.id,
                name: source.account_name,
                type: 'youtube',
                language: source.language,
                externalIdentity: source.external_identity,
                status: 'enabled',
              },
              limit,
              cursor: window?.cursor,
            })
            break
          } catch (error) {
            errors.push(
              `${id}: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        }
        if (!batch || !adapter) throw routeFailure('youtube_list', errors)
      } else throw new Error(`No single-table provider for ${source.platform}`)
      const items: DiscoveredContent[] = batch.items.map((item) => {
        discovered.set(`${source.id}:${item.externalId}`, item)
        return {
          externalId: item.externalId,
          url: item.content.canonicalUrl,
          title: item.content.title,
          publishedAt: item.publishedAt,
          body: item.description,
          interaction: item.interaction,
          kind: item.content.kind,
          format: item.content.kind === 'article' ? 'plain_text' : 'plain_text',
          videoDurationSeconds: item.video?.durationSeconds,
          videoScope: item.video?.scope,
          opaque: item,
        }
      })
      return {
        providerId: adapter.providerId,
        items,
        request: calls.map((call) => call.request),
        response: calls.map((call) => call.response),
        nextCursor: batch.nextCursor,
        rawCount: batch.rawCount,
        oldestPublishedAt:
          batch.oldestPublishedAt ??
          batch.items
            .map((item) => item.publishedAt)
            .filter((value): value is string => Boolean(value))
            .sort()[0],
      }
    },
    async resolve(source: ConfiguredSource, item: DiscoveredContent) {
      let language = source.language
      const calls: Array<{ request: unknown; response: unknown }> = []
      const trackedFetch = auditFetch(
        fetcher,
        calls,
        source.id,
        options.onRequest,
        options.maxRetries
      )
      const sourceItem =
        discovered.get(`${source.id}:${item.externalId}`) ??
        (item.opaque as DiscoveredItem | undefined)
      let body = item.body?.trim() ?? ''
      let title = item.title ?? ''
      let url = item.url
      let format: 'plain_text' | 'subtitle' = 'plain_text'
      if (item.kind === 'article') {
        if (!url) throw new Error('Article URL is missing')
        const capability =
          source.platform === 'x' && isXArticleUrl(url)
            ? 'x_article'
            : 'web_article'
        const routes =
          options.providerRoutes?.[capability] ??
          defaultProviderRoutes[capability]
        const errors: string[] = []
        let article:
          { title: string; body: string; canonicalUrl: string } | undefined
        for (const id of routes) {
          try {
            if (id === 'twitterapi.io') {
              if (!options.twitterApiKey)
                throw new Error('credential is not configured')
              article = await fetchTwitterApiIoArticle({
                apiKey: options.twitterApiKey,
                tweetId: item.externalId,
                canonicalUrl: url,
                fetch: trackedFetch,
              })
            } else {
              article = options.fetch
                ? await (options.articleEnricher ?? enrichArticle)(
                    url,
                    trackedFetch
                  )
                : await (options.articleEnricher ?? enrichArticle)(url)
              if (!options.fetch) {
                calls.push({
                  request: { method: 'GET', url, transport: 'native-http' },
                  response: {
                    title: article.title,
                    canonicalUrl: article.canonicalUrl,
                    bodyLength: article.body.length,
                  },
                })
              }
            }
            break
          } catch (error) {
            errors.push(
              `${id}: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        }
        if (!article) throw routeFailure(capability, errors)
        body = article.body
        title = article.title
        url = article.canonicalUrl
      } else if (item.kind === 'video') {
        let youtubeVideoId: string | undefined
        if (url) {
          try {
            youtubeVideoId = normalizeYouTubeIdentity(url).videoId
          } catch {
            // Native X videos do not have a YouTube identity.
          }
        }
        if (source.platform === 'x' && !youtubeVideoId) {
          if (!options.xVideoTranscriber || !url)
            throw new Error('Video captions provider is unavailable')
          body = await options.xVideoTranscriber(url)
          format = 'subtitle'
        } else if (source.platform !== 'youtube' && !youtubeVideoId) {
          throw new Error('Video captions provider is unavailable')
        } else {
          const errors: string[] = []
          for (const id of options.providerRoutes?.youtube_captions ??
            defaultProviderRoutes.youtube_captions) {
            try {
              if (id !== 'tikhub-youtube')
                throw new Error('provider is not supported')
              if (!options.tikHubToken)
                throw new Error('credential is not configured')
              const captions = await createTikHubYouTubeTranscriptProvider({
                token: options.tikHubToken,
                fetch: trackedFetch,
              }).fetchTranscript(youtubeVideoId ?? item.externalId)
              if (captions.status !== 'available' || !captions.text?.trim())
                throw new Error(
                  `captions are ${captions.status}; manual transcription required`
                )
              body = captions.text
              if (captions.languageCode)
                language = /^zh(?:-|$)/iu.test(captions.languageCode)
                  ? 'zh'
                  : 'en'
              break
            } catch (error) {
              errors.push(
                `${id}: ${error instanceof Error ? error.message : String(error)}`
              )
            }
          }
          if (!body) throw routeFailure('youtube_captions', errors)
          format = 'subtitle'
        }
      } else if (sourceItem?.thread) {
        if (!sourceItem.thread.complete)
          throw new Error('X thread is incomplete')
        body =
          sourceItem.thread.parts
            .map((part) => part.text.trim())
            .filter(Boolean)
            .join('\n\n') || body
      }
      const allowEmptyPost =
        source.platform === 'x' &&
        (item.kind === 'short_post' || item.kind === 'image_post') &&
        Boolean(sourceItem?.images?.length || url)
      if (!body && !allowEmptyPost)
        throw new Error('No complete original content')
      return {
        original: {
          platform: source.platform,
          sourceType: source.platform,
          sourceAccountId: source.id,
          sourceAccountName: accountName(source),
          externalContentId: item.externalId,
          canonicalUrl: url,
          title: title || body.slice(0, 80) || url || item.externalId,
          originalTitle:
            item.kind === 'short_post' ? undefined : title || undefined,
          body,
          images: sourceItem?.images,
          quotedPost: sourceItem?.quotedPost,
          explicitLong: Boolean(
            sourceItem?.thread && sourceItem.thread.parts.length > 1
          ),
          kind: item.kind,
          format,
          language,
          videoDurationSeconds: item.videoDurationSeconds,
          publishedAt: item.publishedAt,
        },
        calls: toLogEvents(calls, 'enrich'),
      }
    },
  }
}
