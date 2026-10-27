import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

import { Readability } from '@mozilla/readability'
import {
  createModels,
  Type,
  type Api,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
  type Models,
} from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { XMLParser } from 'fast-xml-parser'
import { parseHTML } from 'linkedom'
import { z } from 'zod'

export * from './single-table-flow.js'
export * from './single-table-collector.js'
export * from './document-translation.js'
export * from './model-credential-store.js'
export * from './provider-login.js'

import { canonicalizeContentUrl, type Source } from '@qiushui-airadar/domain'
import type {
  AnalysisRecord,
  RuntimeRepository,
} from '@qiushui-airadar/runtime'
import {
  classifyNonArticlePage,
  decideVideoEnrichment,
  type ImagePostDetailProvider,
  normalizeYouTubeIdentity,
  type DiscoveredItem,
  type DiscoveryBatch,
  type DiscoveryRequest,
  type VideoTranscriptProvider,
  type VideoTranscriber,
} from '@qiushui-airadar/source-adapters'

type Fetcher = typeof globalThis.fetch

export interface PlatformDiscoveryRunner {
  discover(request: DiscoveryRequest): Promise<DiscoveryBatch>
}

export async function runPlatformDiscovery(input: {
  repository: RuntimeRepository
  runner: PlatformDiscoveryRunner
  source: Source
  cursor?: string
  limit: number
  autoTranscribe?: boolean
  publishedAfter?: string
}): Promise<{
  items: DiscoveredItem[]
  analyzeReady: number
  blocked: number
}> {
  const batch = await input.runner.discover({
    source: input.source,
    cursor: input.cursor,
    limit: input.limit,
  })
  const items = input.publishedAfter
    ? batch.items.filter(
        (item) =>
          Boolean(item.publishedAt) &&
          !Number.isNaN(Date.parse(item.publishedAt!)) &&
          Date.parse(item.publishedAt!) >= Date.parse(input.publishedAfter!)
      )
    : batch.items
  const discoveredAt = new Date().toISOString()
  const prepared = items.map((item) => {
    if (!item.platformIdentity) {
      throw new Error(
        `Provider item ${item.externalId} has no platform identity`
      )
    }
    let body = ''
    let enrichmentStatus:
      'pending' | 'waiting-manual-transcription' | 'succeeded' | 'failed' =
      'pending'
    const nonArticleReason =
      input.source.type === 'x' && item.content.kind === 'article'
        ? classifyNonArticlePage(item.content.canonicalUrl)
        : undefined
    if (nonArticleReason) {
      item = { ...item, enrichmentError: nonArticleReason }
      enrichmentStatus = 'failed'
    } else if (item.enrichmentError) {
      enrichmentStatus = 'failed'
    } else if (
      item.content.kind === 'short_post' &&
      item.description?.trim() &&
      item.thread?.complete !== false
    ) {
      body = item.description.trim()
      enrichmentStatus = 'succeeded'
    } else if (item.content.kind === 'video') {
      // A YouTube description is not a transcript. Always queue caption lookup
      // before deciding whether speech-to-text or manual transcription is needed.
      if (
        item.platformIdentity?.startsWith('youtube:') &&
        item.evidence?.transcriptStatus !== 'available'
      ) {
        enrichmentStatus = 'pending'
      } else {
        const decision = decideVideoEnrichment({
          hasTranscript: Boolean(
            item.description && item.evidence?.transcriptStatus === 'available'
          ),
          durationSeconds: item.video?.durationSeconds,
          autoTranscribe: input.autoTranscribe ?? false,
        })
        if (decision.status === 'ready') {
          body = item.description?.trim() ?? ''
          enrichmentStatus = 'succeeded'
        } else if (decision.status === 'waiting-manual-transcription') {
          enrichmentStatus = 'waiting-manual-transcription'
        }
      }
    }
    return { item, body, enrichmentStatus }
  })

  await input.repository.commitDiscoveryBatch({
    sourceId: input.source.id,
    contents: prepared.map(({ item, body, enrichmentStatus }) => ({
      id: item.platformIdentity as string,
      title: item.content.title,
      body,
      canonicalUrl: item.content.canonicalUrl,
      sourceId: input.source.id,
      externalId: item.externalId,
      publishedAt: item.publishedAt,
      discoveredAt,
      enrichmentStatus,
      enrichmentError: item.enrichmentError,
      kind: item.content.kind,
      evidence: item.evidence,
      video: item.video,
      images: item.images,
      quotedPost: item.quotedPost,
      repostedBy: item.repostedBy,
      sourceText: item.description,
      threadParts: item.thread?.parts,
      threadComplete: item.thread?.complete,
      mergePlatformMetadata:
        item.content.kind === 'video' ||
        item.content.kind === 'image_post' ||
        (input.source.type === 'x' && item.content.kind === 'short_post'),
      mergeThreadParts:
        input.source.type === 'x' &&
        item.content.kind === 'short_post' &&
        Boolean(item.thread?.parts.length),
    })),
    discoveries: prepared.flatMap(({ item }) =>
      (item.discoveryParts?.length
        ? item.discoveryParts
        : [
            {
              externalId: item.externalId,
              discoveryUrl: item.evidence?.discoveryUrl,
              sourceText: item.description,
            },
          ]
      ).map((part) => ({
        id: `${input.source.id}:${part.externalId}`,
        sourceId: input.source.id,
        contentId: item.platformIdentity as string,
        externalId: part.externalId,
        discoveredAt,
        discoveryUrl: part.discoveryUrl,
        evidence: item.evidence
          ? {
              ...item.evidence,
              discoveryUrl: part.discoveryUrl ?? item.evidence.discoveryUrl,
              sourceText: part.sourceText ?? item.evidence.sourceText,
            }
          : undefined,
        sourceText: part.sourceText,
      }))
    ),
  })

  for (const { item, enrichmentStatus } of prepared) {
    const partInteractions =
      item.discoveryParts
        ?.filter(
          (
            part
          ): part is typeof part & {
            interaction: NonNullable<typeof part.interaction>
          } => Boolean(part.interaction)
        )
        .map((part) => ({
          externalId: part.externalId,
          interaction: part.interaction,
        })) ?? []
    const interactions = partInteractions.length
      ? partInteractions
      : item.interaction
        ? [{ externalId: item.externalId, interaction: item.interaction }]
        : []
    for (const entry of interactions) {
      await input.repository.saveInteractionSnapshot({
        id: randomUUID(),
        contentId: item.platformIdentity as string,
        sourceId: input.source.id,
        providerId: batch.providerId,
        externalId: entry.externalId,
        ...entry.interaction,
      })
    }
    if (enrichmentStatus === 'pending' && item.thread?.complete !== false) {
      await input.repository.enqueueTask({
        id: randomUUID(),
        type: 'enrich',
        sourceId: input.source.id,
        sourceType: input.source.type,
        idempotencyKey: `enrich:${item.platformIdentity}`,
        payload: {
          contentId: item.platformIdentity,
          mode:
            item.content.kind === 'video'
              ? 'auto-transcription'
              : item.content.kind === 'image_post'
                ? 'image-post-enrichment'
                : 'article-enrichment',
          durationSeconds: item.video?.durationSeconds,
        },
      })
    }
  }

  await relateSameWorkAcrossPlatforms({
    repository: input.repository,
    contentIds: prepared.map(({ item }) => item.platformIdentity as string),
  })

  await input.repository.advanceProgress(input.source.id, batch.nextCursor, {
    clearCursor: batch.nextCursor === undefined,
  })

  return {
    items,
    analyzeReady: prepared.filter(
      ({ enrichmentStatus }) => enrichmentStatus === 'succeeded'
    ).length,
    blocked: prepared.filter(
      ({ enrichmentStatus }) => enrichmentStatus !== 'succeeded'
    ).length,
  }
}

function normalizedWorkTitle(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\p{P}\p{S}\s]/gu, '')
}

export async function relateSameWorkAcrossPlatforms(input: {
  repository: RuntimeRepository
  contentIds?: string[]
}): Promise<string[]> {
  const contents = input.repository.listContents()
  const candidates = new Set(input.contentIds ?? contents.map(({ id }) => id))
  const existing = new Set(
    input.repository.listRelatedContents().map(({ id }) => id)
  )
  const created: string[] = []
  for (const candidate of contents.filter(({ id }) => candidates.has(id))) {
    const title = normalizedWorkTitle(candidate.title)
    if (title.length < 8) continue
    for (const other of contents) {
      if (
        candidate.id === other.id ||
        candidate.id.split(':', 1)[0] === other.id.split(':', 1)[0] ||
        normalizedWorkTitle(other.title) !== title
      ) {
        continue
      }
      const contentIds = [candidate.id, other.id].toSorted() as [string, string]
      const id = `related-${sha256(contentIds.join('\n')).slice(0, 32)}`
      if (existing.has(id)) continue
      await input.repository.linkRelatedContents({
        id,
        contentIds,
        reason: '跨平台标题完全一致，标记为相关作品但保留独立内容',
        createdAt: new Date().toISOString(),
      })
      existing.add(id)
      created.push(id)
    }
  }
  return created
}

export interface VideoKeyframeRecognizer {
  providerId: string
  recognizeKeyframes(input: {
    contentId: string
    videoId: string
    canonicalUrl: string
    mediaUrl?: string
    providerReference?: string
  }): Promise<Array<{ atSeconds: number; recognizedText: string }>>
}

const maximumImageBytes = 20 * 1024 * 1024

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase()
  if (isIP(normalized) === 4) {
    const [first = 0, second = 0] = normalized.split('.').map(Number)
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first >= 224
    )
  }
  if (isIP(normalized) === 6) {
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice('::ffff:'.length)
      if (isIP(mapped) === 4) return isPrivateAddress(mapped)
      const [high, low] = mapped.split(':')
      if (high && low) {
        const value =
          Number.parseInt(high, 16) * 65_536 + Number.parseInt(low, 16)
        if (Number.isFinite(value)) {
          return isPrivateAddress(
            [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.')
          )
        }
      }
    }
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/u.test(normalized) ||
      normalized.startsWith('ff')
    )
  }
  return true
}

async function assertPublicMediaUrl(value: string): Promise<URL> {
  const url = new URL(value)
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password
  ) {
    throw new Error('Image URL is not a safe HTTP URL')
  }
  const hostname = url.hostname.toLowerCase()
  if (
    isIP(hostname) !== 0 ||
    !['rednotecdn.com', 'xhscdn.com'].some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    )
  ) {
    throw new Error('Image URL is not on a trusted media CDN')
  }
  const addresses = await lookup(hostname, { all: true })
  if (
    !addresses.length ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new Error('Image URL resolves to a private or unsafe address')
  }
  return url
}

async function downloadImage(input: {
  sourceUrl: string
  fetcher: Fetcher
  enforceNetworkBoundary: boolean
}): Promise<{ bytes: Uint8Array; mimeType: string }> {
  let current = new URL(input.sourceUrl)
  if (current.protocol !== 'https:' && current.protocol !== 'http:') {
    throw new Error('Image URL is not a safe HTTP URL')
  }
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    if (input.enforceNetworkBoundary) {
      current = await assertPublicMediaUrl(current.toString())
    }
    const response = await input.fetcher(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || redirect === 3) {
        throw new Error('Image redirect is missing or exceeds the limit')
      }
      current = new URL(location, current)
      continue
    }
    if (!response.ok) {
      throw new Error(`Image request failed with HTTP ${response.status}`)
    }
    const mimeType = (response.headers.get('content-type') ?? '')
      .split(';', 1)[0]!
      .trim()
      .toLowerCase()
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
      throw new Error('Image response has an invalid content type')
    }
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > maximumImageBytes) {
      throw new Error('Image response exceeds the size limit')
    }
    if (!response.body) throw new Error('Image response has no body')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximumImageBytes) {
        await reader.cancel()
        throw new Error('Image response exceeds the size limit')
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, mimeType }
  }
  throw new Error('Image redirect loop exhausted')
}

function imageExtension(mimeType: string): string {
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  }
  const extension = extensions[mimeType]
  if (!extension) throw new Error(`Unsupported image type: ${mimeType}`)
  return extension
}

export async function enrichImagePostContent(input: {
  repository: RuntimeRepository
  contentId: string
  detailProvider?: ImagePostDetailProvider
  fetch?: Fetcher
}): Promise<{ status: 'succeeded'; providerId: string }> {
  const content = input.repository.getContent(input.contentId)
  if (!content) throw new Error(`Content does not exist: ${input.contentId}`)
  if (content.body.trim() && content.enrichmentStatus === 'succeeded') {
    return {
      status: 'succeeded',
      providerId:
        input.detailProvider?.providerId ?? 'stored-image-attachments',
    }
  }
  if (content.kind !== 'image_post') {
    throw new Error(`Content is not an image post: ${input.contentId}`)
  }
  const detail = input.detailProvider
    ? await input.detailProvider.fetchDetail({
        contentId: input.contentId,
        canonicalUrl: content.canonicalUrl ?? '',
      })
    : undefined
  const images = detail
    ? detail.images
    : Array.isArray(content.images)
      ? (content.images as Array<{ order?: unknown; url?: unknown }>)
      : []
  if (!images.length) throw new Error('Image post has no images')
  const ordered = images
    .map((image) => ({
      order: typeof image.order === 'number' ? image.order : -1,
      url: typeof image.url === 'string' ? image.url : '',
    }))
    .sort((left, right) => left.order - right.order)
  if (
    ordered.some(
      (image, index) => image.order !== index || !image.url.startsWith('http')
    )
  ) {
    throw new Error('Image post has incomplete or unordered image evidence')
  }
  const sourceText =
    detail?.sourceText.trim() ??
    (typeof content.sourceText === 'string' ? content.sourceText.trim() : '')
  if (!sourceText) {
    throw new Error('Image post has no text for analysis')
  }
  const fetcher = input.fetch ?? fetch
  const media: Array<{
    order: number
    fileName: string
  }> = []
  for (const image of ordered) {
    let downloaded: Awaited<ReturnType<typeof downloadImage>>
    try {
      downloaded = await downloadImage({
        sourceUrl: image.url,
        fetcher,
        enforceNetworkBoundary: input.fetch === undefined,
      })
    } catch (error) {
      throw new Error(`Failed to fetch image ${image.order + 1}`, {
        cause: error,
      })
    }
    const { bytes, mimeType } = downloaded
    const fileName = `image-${String(image.order + 1).padStart(3, '0')}.${imageExtension(mimeType)}`
    await input.repository.saveContentMedia(input.contentId, fileName, bytes)
    media.push({ order: image.order, fileName })
  }
  await input.repository.completeContentEnrichment(input.contentId, {
    body: sourceText,
    canonicalUrl: content.canonicalUrl,
    media: { images: media },
    images: ordered,
    sourceText,
  })
  return {
    status: 'succeeded',
    providerId: input.detailProvider?.providerId ?? 'stored-image-attachments',
  }
}

export async function enrichImagePostsIndependently(input: {
  repository: RuntimeRepository
  contentIds: string[]
  detailProvider?: ImagePostDetailProvider
  fetch?: Fetcher
}): Promise<
  Array<
    | { contentId: string; status: 'succeeded' }
    | { contentId: string; status: 'failed'; error: string }
  >
> {
  const results: Array<
    | { contentId: string; status: 'succeeded' }
    | { contentId: string; status: 'failed'; error: string }
  > = []
  for (const contentId of input.contentIds) {
    try {
      await enrichImagePostContent({
        repository: input.repository,
        contentId,
        detailProvider: input.detailProvider,
        fetch: input.fetch,
      })
      results.push({ contentId, status: 'succeeded' })
    } catch (error) {
      await input.repository.failContentEnrichment(
        contentId,
        error instanceof Error ? error.message : String(error)
      )
      results.push({
        contentId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

export async function enrichPlatformVideoContent(input: {
  repository: RuntimeRepository
  contentId: string
  transcriber: VideoTranscriber
  maxDurationSeconds?: number
  autoTranscribe?: boolean
  manual?: boolean
  requireKeyframes?: boolean
  keyframeRecognizer?: VideoKeyframeRecognizer
}): Promise<{
  status: 'succeeded' | 'waiting-manual-transcription'
  providerId: string
}> {
  const content = input.repository.getContent(input.contentId)
  if (!content) throw new Error(`Content does not exist: ${input.contentId}`)
  if (content.body.trim() && content.enrichmentStatus === 'succeeded') {
    return { status: 'succeeded', providerId: input.transcriber.providerId }
  }
  if (content.kind !== 'video' || !content.canonicalUrl) {
    throw new Error(`Content is not a platform video: ${input.contentId}`)
  }
  const video =
    content.video && typeof content.video === 'object'
      ? (content.video as {
          durationSeconds?: number
          mediaUrl?: string
          providerReference?: string
        })
      : {}
  const maximum = input.maxDurationSeconds ?? 7_200
  if (
    !input.manual &&
    (!input.autoTranscribe ||
      video.durationSeconds === undefined ||
      video.durationSeconds > maximum)
  ) {
    await input.repository.waitForManualTranscription(input.contentId)
    return {
      status: 'waiting-manual-transcription',
      providerId: input.transcriber.providerId,
    }
  }
  if (input.requireKeyframes && !input.keyframeRecognizer) {
    throw new Error('Video requires keyframe recognition before completion')
  }
  const separator = input.contentId.indexOf(':')
  const videoId =
    separator >= 0 ? input.contentId.slice(separator + 1) : input.contentId
  const body = await input.transcriber.transcribe({
    videoId,
    canonicalUrl: content.canonicalUrl,
    mediaUrl: video.mediaUrl,
    providerReference: video.providerReference,
  })
  if (!body.trim()) {
    throw new Error('Automatic transcription returned empty text')
  }
  const keyframes = input.requireKeyframes
    ? await input.keyframeRecognizer!.recognizeKeyframes({
        contentId: input.contentId,
        videoId,
        canonicalUrl: content.canonicalUrl,
        mediaUrl: video.mediaUrl,
        providerReference: video.providerReference,
      })
    : []
  if (
    input.requireKeyframes &&
    (!keyframes.length ||
      keyframes.some(
        (frame) =>
          !Number.isFinite(frame.atSeconds) ||
          frame.atSeconds < 0 ||
          !frame.recognizedText.trim()
      ))
  ) {
    throw new Error('Required keyframe recognition is incomplete')
  }
  const normalizedKeyframes = keyframes
    .map((frame) => ({
      atSeconds: frame.atSeconds,
      recognizedText: frame.recognizedText.trim(),
    }))
    .toSorted((left, right) => left.atSeconds - right.atSeconds)
  const completedBody = [
    body.trim(),
    ...normalizedKeyframes.map(
      (frame) =>
        `关键画面 ${frame.atSeconds.toFixed(1)} 秒：\n${frame.recognizedText}`
    ),
  ].join('\n\n')
  await input.repository.completeContentEnrichment(input.contentId, {
    body: completedBody,
    canonicalUrl: content.canonicalUrl,
    media: normalizedKeyframes.length
      ? {
          ...(content.media && typeof content.media === 'object'
            ? content.media
            : {}),
          keyframes: normalizedKeyframes,
          keyframeProviderId: input.keyframeRecognizer?.providerId,
        }
      : undefined,
  })
  return { status: 'succeeded', providerId: input.transcriber.providerId }
}

export async function enrichPlatformVideosIndependently(input: {
  repository: RuntimeRepository
  contentIds: string[]
  transcriber: VideoTranscriber
  autoTranscribe?: boolean
  manual?: boolean
  requireKeyframes?: boolean
  keyframeRecognizer?: VideoKeyframeRecognizer
}): Promise<
  Array<
    | { contentId: string; status: 'succeeded' }
    | { contentId: string; status: 'failed'; error: string }
  >
> {
  const results: Array<
    | { contentId: string; status: 'succeeded' }
    | { contentId: string; status: 'failed'; error: string }
  > = []
  for (const contentId of input.contentIds) {
    try {
      const result = await enrichPlatformVideoContent({
        repository: input.repository,
        contentId,
        transcriber: input.transcriber,
        autoTranscribe: input.autoTranscribe,
        manual: input.manual,
        requireKeyframes: input.requireKeyframes,
        keyframeRecognizer: input.keyframeRecognizer,
      })
      if (result.status !== 'succeeded') {
        throw new Error('Video is waiting for manual transcription')
      }
      results.push({ contentId, status: 'succeeded' })
    } catch (error) {
      results.push({
        contentId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

export async function enrichYouTubeContent(input: {
  repository: RuntimeRepository
  contentId: string
  transcriptProvider: VideoTranscriptProvider
  autoTranscribe?: boolean
  transcriber?: VideoTranscriber
}): Promise<{
  status: 'succeeded' | 'waiting-manual-transcription' | 'processing'
  providerId: string
}> {
  const content = input.repository.getContent(input.contentId)
  if (!content) throw new Error(`Content does not exist: ${input.contentId}`)
  if (content.enrichmentStatus === 'succeeded' && content.body.trim()) {
    return {
      status: 'succeeded',
      providerId: input.transcriptProvider.providerId,
    }
  }
  const video =
    content.video && typeof content.video === 'object'
      ? (content.video as { durationSeconds?: number })
      : {}
  const videoId = input.contentId.startsWith('youtube:')
    ? input.contentId.slice('youtube:'.length)
    : content.canonicalUrl
      ? normalizeYouTubeIdentity(content.canonicalUrl).videoId
      : undefined
  if (!videoId)
    throw new Error(`Content is not a YouTube video: ${input.contentId}`)
  const transcript = await input.transcriptProvider.fetchTranscript(videoId)
  if (transcript.status === 'available' && transcript.text?.trim()) {
    await input.repository.completeContentEnrichment(input.contentId, {
      body: transcript.text.trim(),
      canonicalUrl: content.canonicalUrl,
    })
    return {
      status: 'succeeded',
      providerId: input.transcriptProvider.providerId,
    }
  }
  if (transcript.status === 'processing') {
    return {
      status: 'processing',
      providerId: input.transcriptProvider.providerId,
    }
  }
  if (
    input.autoTranscribe &&
    input.transcriber &&
    video.durationSeconds !== undefined &&
    video.durationSeconds <= 7_200 &&
    content.canonicalUrl
  ) {
    const body = await input.transcriber.transcribe({
      videoId,
      canonicalUrl: content.canonicalUrl,
    })
    if (!body.trim())
      throw new Error('Automatic transcription returned empty text')
    await input.repository.completeContentEnrichment(input.contentId, {
      body: body.trim(),
      canonicalUrl: content.canonicalUrl,
    })
    return { status: 'succeeded', providerId: input.transcriber.providerId }
  }
  await input.repository.waitForManualTranscription(input.contentId)
  return {
    status: 'waiting-manual-transcription',
    providerId: input.transcriptProvider.providerId,
  }
}

const levelSchema = z.number().int().min(1).max(5)
const scoreSchema = z
  .object({ level: levelSchema, reason: z.string().min(1) })
  .strict()

export const analysisResultSchema = z
  .object({
    summary: z.string().min(20),
    chineseTitle: z.string().min(1).optional(),
    chineseTranslation: z.string().min(1).optional(),
    topics: z.array(z.string().min(1)).min(1),
    scores: z
      .object({
        topicMatch: scoreSchema,
        substance: scoreSchema,
        credibility: scoreSchema,
        novelty: scoreSchema,
        actionability: scoreSchema,
        workValue: scoreSchema,
        clarity: scoreSchema,
      })
      .strict(),
    spam: z
      .object({
        isSpam: z.boolean(),
        reason: z.preprocess(
          (value) => (value === null ? undefined : value),
          z.string().min(1).optional()
        ),
      })
      .strict()
      .superRefine((spam, context) => {
        if (spam.isSpam && !spam.reason) {
          context.addIssue({
            code: 'custom',
            message: 'Spam reason is required when content is spam',
            path: ['reason'],
          })
        }
      }),
  })
  .strict()

export type AnalysisResult = z.infer<typeof analysisResultSchema>
export type Recommendation = 'core' | 'explore' | 'none'

export interface RssItem {
  externalId: string
  title: string
  canonicalUrl: string
  publishedAt?: string
}

export interface RssDiscoveryBatch {
  items: RssItem[]
  nextCursor?: string
  observedExternalIds: string[]
  rawResponse: string
}

export interface ModelEvidence {
  provider: string
  model: string
  durationMs: number
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    costUsd: number
  }
}

export interface ModelGateway {
  readonly provider: string
  readonly model: string
  auditInput(input: {
    title: string
    body: string
    profile: string
    translateToChinese?: boolean
    forceTranslate?: boolean
  }): unknown
  analyze(input: {
    title: string
    body: string
    profile: string
    translateToChinese?: boolean
    forceTranslate?: boolean
  }): Promise<{
    result: AnalysisResult
    evidence: ModelEvidence
    rawResponse?: unknown
  }>
}

export class ModelGatewayError extends Error {
  constructor(
    message: string,
    readonly evidence: ModelEvidence,
    readonly rawResponse?: unknown
  ) {
    super(message)
    this.name = 'ModelGatewayError'
  }
}

const codexProviderId = 'openai-codex'
export const rssAcceptanceModel = 'gpt-5.3-codex-spark'
const analysisPromptVersion = 'rss-analysis-v1'
const englishTranslationPromptVersion = 'english-full-translation-v2'

export type OriginalLanguage = 'zh' | 'en' | 'unknown'

export function detectOriginalLanguage(text: string): OriginalLanguage {
  const prose = text.replace(/https?:\/\/\S+|@\w+/gu, ' ')
  const hanCount = (prose.match(/\p{Script=Han}/gu) ?? []).length
  const latinWords = (prose.match(/[A-Za-z]+(?:'[A-Za-z]+)?/gu) ?? []).length
  if (hanCount >= 2 && hanCount >= latinWords) return 'zh'
  if (latinWords >= 2 && latinWords > hanCount) return 'en'
  return 'unknown'
}

interface CodexAuthFile {
  auth_mode?: unknown
  tokens?: {
    access_token?: unknown
    refresh_token?: unknown
    account_id?: unknown
  }
}

function jwtExpiresAt(token: string): number {
  const payload = token.split('.')[1]
  if (!payload) throw new Error('Codex access token is not a JWT')
  const decoded = JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8')
  ) as { exp?: unknown }
  if (typeof decoded.exp !== 'number') {
    throw new Error('Codex access token has no expiry')
  }
  return decoded.exp * 1_000
}

export function createReadOnlyCodexCredentialStore(
  authPath: string
): CredentialStore {
  let memoryCredential: Credential | undefined
  let loaded = false
  const load = async (): Promise<Credential | undefined> => {
    if (loaded) return memoryCredential
    const parsed = JSON.parse(await readFile(authPath, 'utf8')) as CodexAuthFile
    const access = parsed.tokens?.access_token
    const refresh = parsed.tokens?.refresh_token
    const accountId = parsed.tokens?.account_id
    if (
      parsed.auth_mode !== 'chatgpt' ||
      typeof access !== 'string' ||
      typeof refresh !== 'string'
    ) {
      throw new Error('Codex ChatGPT OAuth credentials are unavailable')
    }
    memoryCredential = {
      type: 'oauth',
      access,
      refresh,
      expires: jwtExpiresAt(access),
      ...(typeof accountId === 'string' ? { accountId } : {}),
    }
    loaded = true
    return memoryCredential
  }
  return {
    read: async (providerId) =>
      providerId === codexProviderId ? load() : undefined,
    list: async (): Promise<readonly CredentialInfo[]> =>
      (await load()) ? [{ providerId: codexProviderId, type: 'oauth' }] : [],
    modify: async (providerId, update) => {
      if (providerId !== codexProviderId) return undefined
      memoryCredential = (await update(await load())) ?? memoryCredential
      return memoryCredential
    },
    delete: async (providerId) => {
      if (providerId === codexProviderId) {
        loaded = true
        memoryCredential = undefined
      }
    },
  }
}

export function createCodexPiGateway(
  authPath: string,
  modelId = rssAcceptanceModel
): ModelGateway {
  const models = createModels({
    credentials: createReadOnlyCodexCredentialStore(authPath),
  })
  models.setProvider(openaiCodexProvider())
  const model = models.getModel(codexProviderId, modelId)
  if (!model) throw new Error(`Pi model is unavailable: ${modelId}`)
  return createPiModelGateway(models, model)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalizeArticleUrl(value: string): string {
  return canonicalizeContentUrl(value)
}

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim() || undefined
  }
  if (value && typeof value === 'object' && '#text' in value) {
    return scalar((value as { '#text': unknown })['#text'])
  }
  return undefined
}

function toTimestamp(value: unknown): string | undefined {
  const text = scalar(value)
  if (!text) return undefined
  const timestamp = new Date(text)
  return Number.isNaN(timestamp.valueOf()) ? undefined : timestamp.toISOString()
}

export class RssAdapter {
  constructor(private readonly fetcher: Fetcher = globalThis.fetch) {}

  async discover(input: {
    feedUrl: string
    cursor?: string
    limit?: number
    now?: Date
    initialLookbackDays?: number
    incremental?: boolean
    isSeen?: (externalId: string, canonicalUrl: string) => boolean
    isHistoricalRetry?: (externalId: string) => boolean
  }): Promise<RssDiscoveryBatch> {
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    ) {
      throw new Error('RSS discovery limit must be between 1 and 100')
    }
    const response = await this.fetcher(input.feedUrl, {
      headers: { accept: 'application/rss+xml, application/xml, text/xml' },
      redirect: 'follow',
    })
    if (!response.ok) {
      throw new Error(`RSS request failed with HTTP ${response.status}`)
    }
    const rawResponse = await response.text()
    const parsed = new XMLParser({
      ignoreAttributes: false,
      removeNSPrefix: true,
      trimValues: true,
    }).parse(rawResponse) as {
      rss?: { channel?: { item?: unknown } }
      feed?: { entry?: unknown }
    }
    const rawItems = parsed.rss?.channel?.item ?? parsed.feed?.entry ?? []
    const entries = Array.isArray(rawItems) ? rawItems : [rawItems]
    const incremental = input.incremental ?? Boolean(input.cursor)
    const unseenItems: RssItem[] = []
    const observedExternalIds: string[] = []
    for (const rawEntry of entries) {
      if (!rawEntry || typeof rawEntry !== 'object') continue
      const entry = rawEntry as Record<string, unknown>
      const linkValues = Array.isArray(entry.link) ? entry.link : [entry.link]
      const linkValue =
        linkValues.find((candidate) => {
          if (!candidate || typeof candidate !== 'object') return true
          const relation = scalar(
            (candidate as Record<string, unknown>)['@_rel']
          )
          return !relation || relation === 'alternate'
        }) ?? linkValues[0]
      const link =
        scalar(linkValue) ??
        (linkValue && typeof linkValue === 'object'
          ? scalar((linkValue as Record<string, unknown>)['@_href'])
          : undefined)
      const title = scalar(entry.title)
      if (!link || !title) continue
      const canonicalUrl = canonicalizeArticleUrl(link)
      const externalId = scalar(entry.guid) ?? scalar(entry.id) ?? canonicalUrl
      observedExternalIds.push(externalId)
      if (
        input.isSeen?.(externalId, canonicalUrl) ||
        (!input.isSeen && externalId === input.cursor)
      ) {
        continue
      }
      const publishedAt = toTimestamp(
        entry.pubDate ?? entry.published ?? entry.updated
      )
      if (
        !incremental &&
        !input.isHistoricalRetry?.(externalId) &&
        (!publishedAt ||
          Date.parse(publishedAt) <
            (input.now ?? new Date()).valueOf() -
              (input.initialLookbackDays ?? 7) * 24 * 60 * 60 * 1_000)
      ) {
        continue
      }
      unseenItems.push({
        externalId,
        title,
        canonicalUrl,
        publishedAt,
      })
    }
    const orderedItems = unseenItems.toSorted((left, right) => {
      const leftTime = left.publishedAt ? Date.parse(left.publishedAt) : 0
      const rightTime = right.publishedAt ? Date.parse(right.publishedAt) : 0
      return (
        leftTime - rightTime || left.externalId.localeCompare(right.externalId)
      )
    })
    const effectiveLimit =
      input.limit === undefined
        ? undefined
        : incremental
          ? input.limit
          : Math.min(input.limit, 20)
    const items =
      effectiveLimit === undefined
        ? incremental
          ? orderedItems
          : orderedItems.toReversed()
        : incremental
          ? orderedItems.slice(0, effectiveLimit)
          : orderedItems.slice(-effectiveLimit).reverse()
    return {
      items,
      nextCursor:
        (incremental ? items.at(-1) : items[0])?.externalId ??
        observedExternalIds[0] ??
        input.cursor,
      observedExternalIds,
      rawResponse,
    }
  }
}

export async function enrichArticle(
  url: string,
  fetcher: Fetcher = globalThis.fetch
): Promise<{
  title: string
  body: string
  canonicalUrl: string
  images: Array<{ order: number; url: string }>
}> {
  const articleUserAgent =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
  const readResponse = async (response: Response): Promise<string> => {
    if (!response.body) throw new Error('Article response has no body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 5 * 1024 * 1024) {
        await reader.cancel()
        throw new Error('Article response exceeds the size limit')
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  }
  let current = new URL(url)
  let html = ''
  let contentType = ''
  let status = 0
  let finalUrl = current.toString()
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    let location: string | undefined
    if (fetcher !== globalThis.fetch) {
      const response = await fetcher(current, {
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': articleUserAgent,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      })
      status = response.status
      contentType = response.headers.get('content-type') ?? ''
      html = await readResponse(response)
      finalUrl = response.url || current.toString()
    } else {
      if (
        !['http:', 'https:'].includes(current.protocol) ||
        current.username ||
        current.password ||
        isIP(current.hostname) !== 0
      ) {
        throw new Error('Article URL is not a safe public HTTP URL')
      }
      const addresses = await lookup(current.hostname, { all: true })
      if (
        !addresses.length ||
        addresses.some(({ address }) => isPrivateAddress(address))
      ) {
        throw new Error('Article URL resolves to a private or unsafe address')
      }
      const selected = addresses[0]!
      const result = await new Promise<{
        status: number
        contentType: string
        location?: string
        body: string
      }>((resolve, reject) => {
        const request = (
          current.protocol === 'https:' ? httpsRequest : httpRequest
        )(
          {
            hostname: selected.address,
            family: selected.family,
            port: current.port || undefined,
            path: `${current.pathname}${current.search}`,
            method: 'GET',
            servername: current.hostname,
            headers: {
              host: current.host,
              accept: 'text/html,application/xhtml+xml',
              'user-agent': articleUserAgent,
            },
          },
          (response) => {
            const chunks: Buffer[] = []
            let size = 0
            response.on('data', (chunk: Buffer) => {
              size += chunk.length
              if (size > 5 * 1024 * 1024) {
                response.destroy(
                  new Error('Article response exceeds the size limit')
                )
                return
              }
              chunks.push(chunk)
            })
            response.once('error', reject)
            response.once('end', () =>
              resolve({
                status: response.statusCode ?? 0,
                contentType: String(response.headers['content-type'] ?? ''),
                location:
                  typeof response.headers.location === 'string'
                    ? response.headers.location
                    : undefined,
                body: Buffer.concat(chunks).toString('utf8'),
              })
            )
          }
        )
        request.setTimeout(30_000, () =>
          request.destroy(new Error('Article request timed out'))
        )
        request.once('error', reject)
        request.end()
      })
      status = result.status
      contentType = result.contentType
      location = result.location
      html = result.body
      finalUrl = current.toString()
    }
    if (status < 300 || status >= 400) break
    if (!location || redirect === 3) {
      throw new Error('Article redirect is missing or exceeds the limit')
    }
    current = new URL(location, current)
  }
  if (status < 200 || status >= 300) {
    throw new Error(`Article request failed with HTTP ${status}`)
  }
  if (contentType && !contentType.includes('html')) {
    throw new Error(`Article response is not HTML: ${contentType}`)
  }
  const { document } = parseHTML(html)
  const article = new Readability(document as unknown as Document, {
    charThreshold: 200,
  }).parse()
  const body = article?.textContent?.replace(/\s+/gu, ' ').trim() ?? ''
  if (body.length < 200) {
    throw new Error('Could not extract a complete article body')
  }
  const articleDocument = parseHTML(article?.content ?? '').document
  const images: Array<{ order: number; url: string }> = []
  const seenImages = new Set<string>()
  for (const image of articleDocument.querySelectorAll('img')) {
    const source = image.getAttribute('src') ?? image.getAttribute('data-src')
    if (!source) continue
    try {
      const resolved = new URL(source, finalUrl)
      if (
        !['http:', 'https:'].includes(resolved.protocol) ||
        seenImages.has(resolved.href)
      )
        continue
      seenImages.add(resolved.href)
      images.push({ order: images.length, url: resolved.href })
    } catch {
      /* Ignore malformed image URLs. */
    }
  }
  return {
    title:
      article?.title?.trim() || document.title.trim() || 'Untitled article',
    body,
    canonicalUrl: canonicalizeArticleUrl(finalUrl),
    images,
  }
}

const scoreWeights = {
  topicMatch: 20,
  substance: 15,
  credibility: 15,
  novelty: 10,
  actionability: 15,
  workValue: 15,
  clarity: 10,
} as const

export interface ScoringRule {
  weights: Record<keyof typeof scoreWeights, number>
  coreThreshold: number
  exploreThreshold: number
}

const defaultScoringRule: ScoringRule = {
  weights: scoreWeights,
  coreThreshold: 80,
  exploreThreshold: 60,
}

export function calculateRecommendation(
  input: unknown,
  rule: ScoringRule = defaultScoringRule
): {
  totalScore: number
  recommendation: Recommendation
} {
  const result = analysisResultSchema.parse(input)
  const totalScore = Math.round(
    (Object.keys(scoreWeights) as Array<keyof typeof scoreWeights>).reduce(
      (total, key) =>
        total + (result.scores[key].level - 1) * 25 * (rule.weights[key] / 100),
      0
    )
  )
  const scores = result.scores
  let recommendation: Recommendation = 'none'
  if (!result.spam.isSpam) {
    if (
      totalScore >= rule.coreThreshold &&
      scores.topicMatch.level === 5 &&
      scores.substance.level >= 3 &&
      scores.credibility.level >= 3
    ) {
      recommendation = 'core'
    } else if (
      totalScore >= rule.exploreThreshold &&
      scores.topicMatch.level >= 4 &&
      scores.substance.level >= 3 &&
      scores.credibility.level >= 3
    ) {
      recommendation = 'explore'
    }
  }
  return { totalScore, recommendation }
}

const analysisTool = {
  name: 'submit_analysis',
  description: '提交一条内容的完整中文分析结果',
  parameters: Type.Object(
    {
      summary: Type.String({ minLength: 20 }),
      chineseTitle: Type.Optional(Type.String({ minLength: 1 })),
      chineseTranslation: Type.Optional(Type.String({ minLength: 1 })),
      topics: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      scores: Type.Object({
        topicMatch: Type.Object({
          level: Type.Integer({ minimum: 1, maximum: 5 }),
          reason: Type.String(),
        }),
        substance: Type.Object({
          level: Type.Integer({ minimum: 1, maximum: 5 }),
          reason: Type.String(),
        }),
        credibility: Type.Object({
          level: Type.Integer({ minimum: 1, maximum: 5 }),
          reason: Type.String(),
        }),
        novelty: Type.Object({
          level: Type.Integer({ minimum: 1, maximum: 5 }),
          reason: Type.String(),
        }),
        actionability: Type.Object({
          level: Type.Integer({ minimum: 1, maximum: 5 }),
          reason: Type.String(),
        }),
        workValue: Type.Object({
          level: Type.Integer({ minimum: 1, maximum: 5 }),
          reason: Type.String(),
        }),
        clarity: Type.Object({
          level: Type.Integer({ minimum: 1, maximum: 5 }),
          reason: Type.String(),
        }),
      }),
      spam: Type.Object({
        isSpam: Type.Boolean(),
        reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
    },
    { additionalProperties: false }
  ),
  constrainedSampling: { type: 'json_schema', strict: 'prefer' } as const,
}

export function createPiModelGateway(
  models: Models,
  model: Model<Api>
): ModelGateway {
  const requestFor = (input: {
    title: string
    body: string
    profile: string
    translateToChinese?: boolean
    forceTranslate?: boolean
  }) => ({
    context: {
      systemPrompt: `你是个人内容分析器。必须只调用 submit_analysis 一次。根据完整正文和个人画像给出中文摘要、主题、七项1到5档评分与垃圾判断。不要把平台热度作为加分。${input.translateToChinese ? `正文语言为英文。先判断 spam；${input.forceTranslate ? '用户已明确将此内容判为非垃圾，因此无论 spam 判断为何都应' : '只有非垃圾内容才'}填写 chineseTitle 和 chineseTranslation。标题与完整正文都要自然、准确地意译成中文，逐段保留原文的全部事实、数字、专名、链接、顺序和语气；不得增删信息，不得以摘要代替正文。${input.forceTranslate ? '' : '垃圾内容不要翻译。'}` : '无需填写 chineseTitle 和 chineseTranslation 字段。'}`,
      messages: [
        {
          role: 'user' as const,
          content: `个人画像：\n${input.profile}\n\n标题：${input.title}\n\n完整正文：\n${input.body}`,
          timestamp: 0,
        },
      ],
      tools: [analysisTool],
    },
    options: {
      reasoning: 'off' as const,
      maxTokens: input.translateToChinese
        ? Math.min(
            32_000,
            Math.max(4_000, Math.ceil(input.body.length / 2) + 2_000)
          )
        : 2_500,
      maxRetries: 0,
    },
  })
  return {
    provider: model.provider,
    model: model.id,
    auditInput: requestFor,
    async analyze(input) {
      const started = Date.now()
      const request = requestFor(input)
      const executionOptions = {
        maxTokens: request.options.maxTokens,
        maxRetries: request.options.maxRetries,
      }
      const message =
        model.api === 'openai-codex-responses'
          ? await models.complete(
              model as Model<'openai-codex-responses'>,
              request.context,
              {
                ...executionOptions,
                reasoningEffort: 'none',
              }
            )
          : await models.completeSimple(
              model,
              request.context,
              executionOptions
            )
      const evidence: ModelEvidence = {
        provider: message.provider,
        model: message.model,
        durationMs: Date.now() - started,
        usage: {
          inputTokens: message.usage.input,
          outputTokens: message.usage.output,
          cacheReadTokens: message.usage.cacheRead,
          cacheWriteTokens: message.usage.cacheWrite,
          costUsd: message.usage.cost.total,
        },
      }
      const rawResponse = {
        provider: message.provider,
        model: message.model,
        stopReason: message.stopReason,
        errorMessage: message.errorMessage,
        content: message.content,
        usage: message.usage,
      }
      if (message.stopReason === 'error') {
        throw new ModelGatewayError(
          message.errorMessage || 'Pi model request failed',
          evidence,
          rawResponse
        )
      }
      const submission = message.content.find(
        (block) => block.type === 'toolCall' && block.name === analysisTool.name
      )
      if (!submission || submission.type !== 'toolCall') {
        throw new ModelGatewayError(
          'Pi model did not return submit_analysis',
          evidence,
          rawResponse
        )
      }
      let result: AnalysisResult
      try {
        result = analysisResultSchema.parse(submission.arguments)
        if (
          input.translateToChinese &&
          (!result.spam.isSpam || input.forceTranslate) &&
          (!result.chineseTitle?.trim() || !result.chineseTranslation?.trim())
        ) {
          throw new Error(
            'Non-junk English content is missing Chinese translation'
          )
        }
      } catch (error) {
        throw new ModelGatewayError(
          error instanceof Error ? error.message : String(error),
          evidence,
          rawResponse
        )
      }
      return {
        result,
        evidence,
        rawResponse,
      }
    },
  }
}

function contentId(url: string): string {
  return `rss-${sha256(`article:${url}`).slice(0, 32)}`
}

function discoveryId(sourceId: string, externalId: string): string {
  return `discovery-${sha256(`${sourceId}:${externalId}`).slice(0, 32)}`
}

function analysisFingerprint(input: {
  body: string
  profileVersionId: string
  ruleVersion: string
  scoringRule?: ScoringRule
  modelRouteVersion: string
  promptVersion: string
}): string {
  return sha256(JSON.stringify(input))
}

const analysisLocks = new Map<string, Promise<void>>()

async function withAnalysisLock<T>(
  key: string,
  work: () => Promise<T>
): Promise<T> {
  const previous = analysisLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  analysisLocks.set(key, current)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (analysisLocks.get(key) === current) analysisLocks.delete(key)
  }
}

export async function analyzeStoredContent(
  repository: RuntimeRepository,
  contentId: string,
  options: {
    modelGateway: ModelGateway
    profile: string
    profileVersionId: string
    ruleVersion: string
    scoringRule?: ScoringRule
    rawResponseRetentionDays?: number
    modelRouteVersion: string
    manual: boolean
    sourceLanguage?: 'en' | 'zh'
  }
): Promise<AnalysisRecord> {
  return withAnalysisLock(`${repository.root}:${contentId}`, () =>
    analyzeStoredContentUnlocked(repository, contentId, options)
  )
}

async function analyzeStoredContentUnlocked(
  repository: RuntimeRepository,
  contentId: string,
  options: {
    modelGateway: ModelGateway
    profile: string
    profileVersionId: string
    ruleVersion: string
    scoringRule?: ScoringRule
    rawResponseRetentionDays?: number
    modelRouteVersion: string
    manual: boolean
    sourceLanguage?: 'en' | 'zh'
  }
): Promise<AnalysisRecord> {
  const content = repository.getContent(contentId)
  if (!content) throw new Error(`Content does not exist: ${contentId}`)
  if (!content.body.trim() || content.enrichmentStatus !== 'succeeded') {
    throw new Error('Content is not completely enriched')
  }
  const source = content.sourceId
    ? repository.getSource(content.sourceId)
    : undefined
  const translateToChinese =
    (options.sourceLanguage ?? source?.language) === 'en' &&
    detectOriginalLanguage(content.body) !== 'zh' &&
    repository.getContentUserState(content.id)?.manualJunk?.isJunk !== true
  const forceTranslate =
    repository.getContentUserState(content.id)?.manualJunk?.isJunk === false
  const promptVersion = translateToChinese
    ? `${englishTranslationPromptVersion}${forceTranslate ? '-manual-not-junk' : ''}`
    : analysisPromptVersion
  const fingerprint = analysisFingerprint({
    body: content.body,
    profileVersionId: options.profileVersionId,
    ruleVersion: options.ruleVersion,
    modelRouteVersion: options.modelRouteVersion,
    promptVersion,
  })
  const existing = repository.getAnalysisByFingerprint(content.id, fingerprint)
  if (existing && !options.manual) return existing

  const startedAt = new Date().toISOString()
  const callId = `analysis-call-${randomUUID()}`
  const rawRecordId = `analysis-model-${callId}`
  const request = {
    title: content.title,
    body: content.body,
    profile: options.profile,
    translateToChinese,
    forceTranslate,
  }
  const auditedRequest = options.modelGateway.auditInput(request)
  await repository.saveRawResponse({
    id: rawRecordId,
    providerId: options.modelGateway.provider,
    receivedAt: startedAt,
    retentionDays: options.rawResponseRetentionDays,
    payload: { request: auditedRequest, status: 'started' },
  })
  try {
    const { result, evidence, rawResponse } =
      await options.modelGateway.analyze(request)
    if (
      translateToChinese &&
      (!result.spam.isSpam || forceTranslate) &&
      (!result.chineseTitle?.trim() || !result.chineseTranslation?.trim())
    ) {
      throw new ModelGatewayError(
        'Non-junk English content is missing Chinese translation',
        evidence,
        rawResponse
      )
    }
    await repository.saveRawResponse({
      id: rawRecordId,
      providerId: evidence.provider,
      receivedAt: new Date().toISOString(),
      retentionDays: options.rawResponseRetentionDays,
      payload: { request: auditedRequest, response: rawResponse ?? result },
    })
    const scoringRule = options.scoringRule ?? defaultScoringRule
    const scored = calculateRecommendation(result, scoringRule)
    const analysisId = `analysis-${randomUUID()}`
    const analysis = await repository.saveAnalysis({
      id: analysisId,
      contentId: content.id,
      fingerprint,
      version: repository.nextAnalysisVersion(content.id),
      manual: options.manual,
      provider: evidence.provider,
      model: evidence.model,
      promptVersion,
      profileVersionId: options.profileVersionId,
      ruleVersion: options.ruleVersion,
      createdAt: new Date().toISOString(),
      durationMs: evidence.durationMs,
      usage: evidence.usage,
      result: { ...result, ...scored, scoringRule },
    })
    await repository.saveAnalysisCall({
      id: callId,
      contentId: content.id,
      analysisId,
      provider: evidence.provider,
      model: evidence.model,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: evidence.durationMs,
      status: 'succeeded',
      usage: evidence.usage,
    })
    return analysis
  } catch (error) {
    const finishedAt = new Date().toISOString()
    const evidence =
      error instanceof ModelGatewayError ? error.evidence : undefined
    await repository.saveRawResponse({
      id: rawRecordId,
      providerId: evidence?.provider ?? options.modelGateway.provider,
      receivedAt: finishedAt,
      retentionDays: options.rawResponseRetentionDays,
      payload: {
        request: auditedRequest,
        ...(error instanceof ModelGatewayError &&
        error.rawResponse !== undefined
          ? { response: error.rawResponse }
          : {}),
        error: error instanceof Error ? error.message : String(error),
      },
    })
    await repository.saveAnalysisCall({
      id: callId,
      contentId: content.id,
      provider: evidence?.provider ?? options.modelGateway.provider,
      model: evidence?.model ?? options.modelGateway.model,
      startedAt,
      finishedAt,
      durationMs:
        evidence?.durationMs ??
        Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      status: 'failed',
      usage: evidence?.usage,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

export interface RssPipelineOptions {
  repository: RuntimeRepository
  source: { id: string; feedUrl: string }
  fetcher?: Fetcher
  modelGateway: ModelGateway
  profile: string
  profileVersionId: string
  ruleVersion: string
  scoringRule?: ScoringRule
  rawResponseRetentionDays?: number
  modelRouteVersion: string
  limit: number
  cursor?: string
  manualReanalysisContentId?: string
  now?: Date
  initialLookbackDays?: number
}

export async function runRssDiscovery(options: {
  repository: RuntimeRepository
  source: { id: string; feedUrl: string }
  fetcher?: Fetcher
  limit: number
  cursor?: string
  now?: Date
  initialLookbackDays?: number
  rawResponseRetentionDays?: number
}): Promise<{ contentIds: string[]; discovered: number }> {
  const storedProgress = options.repository.getProgress(options.source.id)
  const cursor = options.cursor ?? storedProgress?.cursor
  const startedAt = new Date().toISOString()
  const batch = await new RssAdapter(options.fetcher).discover({
    feedUrl: options.source.feedUrl,
    cursor,
    limit: options.limit,
    now: options.now,
    initialLookbackDays: options.initialLookbackDays,
    incremental: Boolean(storedProgress || cursor),
    isSeen: (externalId) =>
      Boolean(
        options.repository.getDiscovery(
          discoveryId(options.source.id, externalId)
        )
      ),
  })
  await options.repository.saveRawResponse({
    id: `rss-${options.source.id}-${randomUUID()}`,
    providerId: 'native-rss',
    receivedAt: new Date().toISOString(),
    retentionDays: options.rawResponseRetentionDays,
    payload: { xml: batch.rawResponse },
  })
  const discoveredAt = new Date().toISOString()
  const contentIds = batch.items.map((item) => contentId(item.canonicalUrl))
  await options.repository.commitDiscoveryBatch({
    sourceId: options.source.id,
    baselineExternalIds: storedProgress ? undefined : batch.observedExternalIds,
    contents: batch.items.map((item, index) => ({
      id: contentIds[index]!,
      title: item.title,
      body: '',
      canonicalUrl: item.canonicalUrl,
      sourceId: options.source.id,
      externalId: item.externalId,
      publishedAt: item.publishedAt,
      discoveredAt,
      enrichmentStatus: 'pending',
      kind: 'article',
    })),
    discoveries: batch.items.map((item, index) => ({
      id: discoveryId(options.source.id, item.externalId),
      sourceId: options.source.id,
      contentId: contentIds[index]!,
      discoveredAt,
    })),
  })
  for (const id of contentIds) {
    await options.repository.enqueueTask({
      id: randomUUID(),
      type: 'enrich',
      sourceId: options.source.id,
      sourceType: 'rss',
      idempotencyKey: `enrich:${id}`,
      payload: { contentId: id, mode: 'article-enrichment' },
    })
  }
  await options.repository.advanceProgress(
    options.source.id,
    batch.nextCursor,
    {
      clearCursor: batch.nextCursor === undefined,
    }
  )
  const finishedAt = new Date().toISOString()
  await options.repository.saveAudit({
    id: `rss-discovery-audit-${randomUUID()}`,
    sourceId: options.source.id,
    providerId: 'native-rss',
    startedAt,
    finishedAt,
    succeeded: contentIds.length,
    failed: 0,
    retries: 0,
    cursorBefore: cursor,
    cursorAfter: batch.nextCursor,
  })
  return { contentIds, discovered: contentIds.length }
}

async function canonicalContentAfterEnrichment(
  repository: RuntimeRepository,
  originalContentId: string,
  enriched: { body: string; canonicalUrl: string }
) {
  const canonicalId = contentId(enriched.canonicalUrl)
  return repository.mergeContentIdentity(
    originalContentId,
    canonicalId,
    enriched
  )
}

export async function runRssPipeline(options: RssPipelineOptions): Promise<{
  discovered: number
  succeeded: number
  failed: number
  analyses: AnalysisRecord[]
}> {
  if (options.manualReanalysisContentId) {
    const analysis = await analyzeStoredContent(
      options.repository,
      options.manualReanalysisContentId,
      {
        ...options,
        manual: true,
      }
    )
    return { discovered: 0, succeeded: 1, failed: 0, analyses: [analysis] }
  }

  const storedProgress = options.repository.getProgress(options.source.id)
  const cursor = options.cursor ?? storedProgress?.cursor
  const baselineExternalIds = new Set(storedProgress?.baselineExternalIds ?? [])
  const startedAt = new Date().toISOString()
  const adapter = new RssAdapter(options.fetcher)
  const batch = await adapter.discover({
    feedUrl: options.source.feedUrl,
    cursor,
    limit: options.limit,
    now: options.now,
    initialLookbackDays: options.initialLookbackDays,
    incremental: Boolean(storedProgress || options.cursor),
    isSeen: (externalId) => {
      const discovery = options.repository.getDiscovery(
        discoveryId(options.source.id, externalId)
      )
      if (discovery) {
        const content = options.repository.getContent(discovery.contentId)
        return Boolean(
          content?.body.trim() &&
          content.enrichmentStatus === 'succeeded' &&
          options.repository.listAnalyses(content.id).length > 0
        )
      }
      return baselineExternalIds.has(externalId)
    },
    isHistoricalRetry: (externalId) => {
      const discovery = options.repository.getDiscovery(
        discoveryId(options.source.id, externalId)
      )
      if (!discovery) return false
      const content = options.repository.getContent(discovery.contentId)
      return (
        !content?.body.trim() ||
        content.enrichmentStatus !== 'succeeded' ||
        options.repository.listAnalyses(content.id).length === 0
      )
    },
  })
  await options.repository.saveRawResponse({
    id: `rss-${options.source.id}-${randomUUID()}`,
    providerId: 'native-rss',
    receivedAt: new Date().toISOString(),
    retentionDays: options.rawResponseRetentionDays,
    payload: { xml: batch.rawResponse },
  })
  await options.repository.commitDiscoveryBatch({
    sourceId: options.source.id,
    baselineExternalIds: storedProgress ? undefined : batch.observedExternalIds,
    contents: batch.items.map((item) => ({
      id: contentId(item.canonicalUrl),
      title: item.title,
      body: '',
      canonicalUrl: item.canonicalUrl,
      sourceId: options.source.id,
      externalId: item.externalId,
      publishedAt: item.publishedAt,
      discoveredAt: new Date().toISOString(),
      enrichmentStatus: 'pending',
    })),
    discoveries: batch.items.map((item) => ({
      id: discoveryId(options.source.id, item.externalId),
      sourceId: options.source.id,
      contentId: contentId(item.canonicalUrl),
      discoveredAt: new Date().toISOString(),
    })),
  })

  const analyses: AnalysisRecord[] = []
  let failed = 0
  for (const item of batch.items) {
    const id = contentId(item.canonicalUrl)
    try {
      let content = options.repository.getContent(id)
      if (!content) throw new Error(`Discovered content is missing: ${id}`)
      if (!content.body.trim() || content.enrichmentStatus !== 'succeeded') {
        const enriched = await enrichArticle(item.canonicalUrl, options.fetcher)
        content = await canonicalContentAfterEnrichment(
          options.repository,
          id,
          enriched
        )
      } else if (content.canonicalUrl) {
        content =
          options.repository.getContent(contentId(content.canonicalUrl)) ??
          content
      }
      analyses.push(
        await analyzeStoredContent(options.repository, content.id, {
          ...options,
          manual: false,
        })
      )
    } catch (error) {
      failed += 1
      const content = options.repository.getContent(id)
      if (content && content.enrichmentStatus !== 'succeeded') {
        await options.repository.failContentEnrichment(
          id,
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  }
  const advancedCursor = failed === 0 ? batch.nextCursor : cursor
  if (failed === 0 && batch.nextCursor) {
    await options.repository.advanceProgress(
      options.source.id,
      batch.nextCursor
    )
  }
  const finishedAt = new Date().toISOString()
  await options.repository.saveAudit({
    id: `rss-audit-${randomUUID()}`,
    sourceId: options.source.id,
    providerId: 'native-rss',
    startedAt,
    finishedAt,
    succeeded: analyses.length,
    failed,
    cursorBefore: cursor,
    cursorAfter: advancedCursor,
    retries: 0,
  })
  return {
    discovered: batch.items.length,
    succeeded: analyses.length,
    failed,
    analyses,
  }
}
