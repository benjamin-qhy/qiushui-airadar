import {
  contentIdentity,
  type ContentInteraction,
  type LogEvent,
  type OriginalContent,
  type SingleTableRepository,
  type ScoringRules,
} from '@qiushui-airadar/runtime'

import {
  processSingleTableContent,
  type SingleTableModelGateway,
} from './single-table-flow.js'
import { classifyNonArticlePage } from '@qiushui-airadar/source-adapters'

export interface ConfiguredSource {
  id: string
  platform: string
  account_name: string
  external_identity: string
  language: 'zh' | 'en'
  enabled: boolean
}

export interface DiscoveredContent {
  externalId: string
  url?: string
  title?: string
  publishedAt?: string
  body?: string
  kind: OriginalContent['kind']
  format?: OriginalContent['format']
  videoDurationSeconds?: number
  interaction?: ContentInteraction
  opaque?: unknown
}

export interface SinglePageDiscovery {
  items: DiscoveredContent[]
  providerId?: string
  request: unknown
  response: unknown
}

export interface ResolvedContent {
  original: OriginalContent
  calls?: LogEvent[]
}

export interface SingleTableSourceProvider {
  // One call per source. There is deliberately no cursor or next-page API.
  discover(
    source: ConfiguredSource,
    limit?: number
  ): Promise<SinglePageDiscovery>
  resolve(
    source: ConfiguredSource,
    item: DiscoveredContent
  ): Promise<ResolvedContent>
}

export interface CollectSourcesOptions {
  resumeIncomplete?: boolean
  resumeStartedAt?: string
  runStartedAt?: string
  sources: ConfiguredSource[]
  provider: SingleTableSourceProvider
  repository: SingleTableRepository
  gateway: SingleTableModelGateway
  promptsRoot: string
  profile: { interests: string[]; goals: string[]; exclusions: string[] }
  profileVersion?: string
  scoring: ScoringRules
  longContentMinChars: number
  translationMinimumTotalScore: number
  automaticTranslationLimits?: {
    maximumVideoDurationSeconds: number
    maximumSourceCharacters: number
  }
  onProgress?: (
    source: ConfiguredSource,
    result: SourceRunResult,
    finished: boolean,
    breakdown: { newlyCompleted: number; existingCompleted: number }
  ) => Promise<void>
  onError?: (
    source: ConfiguredSource,
    item: DiscoveredContent | undefined,
    error: unknown
  ) => void
  afterSource?: (
    source: ConfiguredSource,
    result: SourceRunResult,
    page: SinglePageDiscovery
  ) => Promise<void>
  waitUntilRunnable?: () => Promise<void>
}

export interface SourceRunResult {
  sourceId: string
  discovered: number
  completed: number
  failed: number
  skipped: number
}

function discoveredIdentity(
  source: ConfiguredSource,
  item: DiscoveredContent
): ReturnType<typeof contentIdentity> | undefined {
  if (item.kind === 'article' && !item.url) return undefined
  return contentIdentity({
    platform: source.platform,
    sourceType: source.platform,
    sourceAccountId: source.id,
    sourceAccountName: source.account_name,
    externalContentId: item.externalId,
    canonicalUrl: item.url,
    title: item.title ?? item.externalId,
    body: item.body ?? '',
    kind: item.kind,
    format: item.format ?? 'plain_text',
    language: source.language,
    publishedAt: item.publishedAt,
  })
}

function isProviderBalanceFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\bHTTP 402\b|insufficient balance|余额不足/iu.test(message)
}

export async function collectSourcesSerially(
  options: CollectSourcesOptions
): Promise<SourceRunResult[]> {
  const results: SourceRunResult[] = []
  for (const source of options.sources) {
    if (!source.enabled) continue
    await options.waitUntilRunnable?.()
    const result = {
      sourceId: source.id,
      discovered: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    }
    const breakdown = { newlyCompleted: 0, existingCompleted: 0 }
    results.push(result)
    await options.onProgress?.(source, result, false, breakdown)
    let page: SinglePageDiscovery
    try {
      page = await options.provider.discover(source)
    } catch (error) {
      result.failed++
      options.onError?.(source, undefined, error)
      await options.onProgress?.(source, result, true, breakdown)
      continue
    }
    await options.waitUntilRunnable?.()
    result.discovered = page.items.length
    await options.onProgress?.(source, result, false, breakdown)
    for (const item of page.items) {
      await options.waitUntilRunnable?.()
      let original: OriginalContent | undefined
      try {
        const earlyIdentity = discoveredIdentity(source, item)
        const earlyExisting = earlyIdentity
          ? options.repository.get(earlyIdentity.key)
          : undefined
        if (
          earlyExisting &&
          (!options.resumeIncomplete ||
            earlyExisting.process_status === 'completed' ||
            String(earlyExisting.created_at ?? '') <
              (options.resumeStartedAt ?? ''))
        ) {
          if (item.interaction)
            options.repository.updateInteractionBySourceId(
              source.id,
              item.externalId,
              item.interaction
            )
          if (earlyExisting.process_status === 'completed') {
            result.completed++
            if (
              options.runStartedAt &&
              String(earlyExisting.created_at ?? '') >= options.runStartedAt
            )
              breakdown.newlyCompleted++
            else breakdown.existingCompleted++
          } else result.skipped++
          continue
        }
        const nonArticleReason =
          source.platform === 'x' && item.kind === 'article' && item.url
            ? classifyNonArticlePage(item.url)
            : undefined
        if (nonArticleReason) {
          const unavailable = {
            platform: source.platform,
            sourceType: source.platform,
            sourceAccountId: source.id,
            sourceAccountName: source.account_name
              .replace(/^(?:X|YouTube)\s*\/\s*/iu, '')
              .trim(),
            externalContentId: item.externalId,
            canonicalUrl: item.url,
            title: item.title ?? item.externalId,
            originalTitle: item.title,
            kind: item.kind,
            format: item.format ?? 'plain_text',
            language: source.language,
            publishedAt: item.publishedAt,
          }
          const existing = options.repository.get(
            contentIdentity({ ...unavailable, body: '' }).key
          )
          if (existing) {
            await options.repository.setRuleJunk(existing.id, nonArticleReason)
          } else {
            const excluded = await options.repository.recordUnavailable(
              unavailable,
              nonArticleReason,
              false,
              { request: page.request, response: page.response }
            )
            await options.repository.setRuleJunk(excluded.id, nonArticleReason)
          }
          result.skipped++
          continue
        }
        const resolved = await options.provider.resolve(source, item)
        original = resolved.original
        if (!resolved.original.body.trim())
          throw new Error('Resolved content has no body')
        const existing = options.repository.get(
          contentIdentity(resolved.original).key
        )
        if (
          existing &&
          (!options.resumeIncomplete ||
            existing.process_status === 'completed' ||
            String(existing.created_at ?? '') < (options.resumeStartedAt ?? ''))
        ) {
          // Existing failures require an explicit manual retry; a new list
          // fetch must never silently repair or reprocess them.
          if (existing.process_status === 'completed') {
            result.completed++
            if (
              options.runStartedAt &&
              String(existing.created_at ?? '') >= options.runStartedAt
            )
              breakdown.newlyCompleted++
            else breakdown.existingCompleted++
          } else result.skipped++
          continue
        }
        await processSingleTableContent({
          repository: options.repository,
          gateway: options.gateway,
          promptsRoot: options.promptsRoot,
          original: resolved.original,
          profile: options.profile,
          profileVersion: options.profileVersion,
          scoring: options.scoring,
          longContentMinChars: options.longContentMinChars,
          translationMinimumTotalScore: options.translationMinimumTotalScore,
          automaticTranslationLimits: options.automaticTranslationLimits,
          capturedCalls: [
            {
              action: 'discover',
              stage: 'discovered',
              status: 'succeeded',
              request: page.request,
              response: page.response,
            },
            ...(resolved.calls ?? []),
          ],
        })
        result.completed++
        breakdown.newlyCompleted++
      } catch (error) {
        result.failed++
        try {
          if (
            original &&
            options.repository.get(contentIdentity(original).key)
          ) {
            options.onError?.(source, item, error)
            continue
          }
          await options.repository.recordUnavailable(
            {
              platform: source.platform,
              sourceType: source.platform,
              sourceAccountId: source.id,
              sourceAccountName: source.account_name
                .replace(/^(?:X|YouTube)\s*\/\s*/iu, '')
                .trim(),
              externalContentId: item.externalId,
              canonicalUrl: item.url,
              title: item.title ?? item.externalId,
              originalTitle:
                item.kind === 'short_post' ? undefined : item.title,
              kind: item.kind,
              format: item.format ?? 'plain_text',
              language: source.language,
              publishedAt: item.publishedAt,
            },
            error instanceof Error ? error.message : String(error),
            item.kind === 'video' &&
              /captions|transcription/iu.test(String(error)),
            { request: page.request, response: page.response }
          )
        } catch (recordError) {
          options.onError?.(source, item, recordError)
        }
        options.onError?.(source, item, error)
        if (isProviderBalanceFailure(error)) break
      } finally {
        await options.onProgress?.(source, result, false, breakdown)
        if (item.interaction)
          options.repository.updateInteractionBySourceId(
            source.id,
            item.externalId,
            item.interaction
          )
      }
    }
    await options.waitUntilRunnable?.()
    if (options.afterSource) await options.afterSource(source, result, page)
    await options.onProgress?.(source, result, true, breakdown)
  }
  return results
}
