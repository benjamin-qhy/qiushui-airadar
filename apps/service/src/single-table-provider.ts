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
}

function routeFailure(capability: string, errors: string[]): Error {
  return new Error(
    `All providers failed for ${capability}: ${errors.join(' | ')}`
  )
}

function auditFetch(
  fetcher: typeof fetch,
  calls: Array<{ request: unknown; response: unknown }>
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined
    const method = init?.method ?? request?.method ?? 'GET'
    const url = String(request?.url ?? input)
    const body = init?.body
      ? String(init.body)
      : request?.body
        ? await request.clone().text()
        : undefined
    const headers = Object.fromEntries(
      new Headers(init?.headers ?? request?.headers).entries()
    )
    try {
      const response = await fetcher(input, init)
      const responseBody = await response.clone().text()
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
  const fetcher = options.fetch ?? fetch
  const discovered = new Map<string, DiscoveredItem>()
  return {
    async discover(source, limit) {
      const calls: Array<{ request: unknown; response: unknown }> = []
      const trackedFetch = auditFetch(fetcher, calls)
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
        }
      })
      return {
        providerId: adapter.providerId,
        items,
        request: calls.map((call) => call.request),
        response: calls.map((call) => call.response),
      }
    },
    async resolve(source: ConfiguredSource, item: DiscoveredContent) {
      const calls: Array<{ request: unknown; response: unknown }> = []
      const trackedFetch = auditFetch(fetcher, calls)
      const sourceItem = discovered.get(`${source.id}:${item.externalId}`)
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
              break
            } catch (error) {
              errors.push(
                `${id}: ${error instanceof Error ? error.message : String(error)}`
              )
            }
          }
          if (!body && options.xVideoTranscriber && url) {
            try {
              body = await options.xVideoTranscriber(url)
            } catch (error) {
              errors.push(
                `local-transcription: ${error instanceof Error ? error.message : String(error)}`
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
      if (!body) throw new Error('No complete original content')
      return {
        original: {
          platform: source.platform,
          sourceType: source.platform,
          sourceAccountId: source.id,
          sourceAccountName: accountName(source),
          externalContentId: item.externalId,
          canonicalUrl: url,
          title: title || body.slice(0, 80),
          originalTitle:
            item.kind === 'short_post' ? undefined : title || undefined,
          body,
          explicitLong: Boolean(
            sourceItem?.thread && sourceItem.thread.parts.length > 1
          ),
          kind: item.kind,
          format,
          language: source.language,
          videoDurationSeconds: item.videoDurationSeconds,
          publishedAt: item.publishedAt,
        },
        calls: toLogEvents(calls, 'enrich'),
      }
    },
  }
}
