import { randomUUID } from 'node:crypto'

import type { Source } from '../packages/domain/src/index.js'
import {
  enrichYouTubeContent,
  runPlatformDiscovery,
} from '../packages/pipeline/src/index.js'
import { RuntimeRepository } from '../packages/runtime/src/index.js'
import {
  createProviderRouter,
  createTikHubXProvider,
  createTikHubYouTubeProvider,
  createTikHubYouTubeTranscriptProvider,
  createTwitterApiIoProvider,
  createYouTubeDataApiProvider,
  type CaptureProviderResponse,
  ProviderDiscoveryError,
  type ProviderAttemptAudit,
  type ProviderHealthStore,
  type SourceAdapter,
} from '../packages/source-adapters/src/index.js'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function source(type: 'x' | 'youtube', identity: string, id: string): Source {
  return {
    id,
    slug: id,
    name: id,
    type,
    externalIdentity: identity,
    status: 'enabled',
  }
}

async function discoverWithTransientRetry(
  provider: SourceAdapter,
  request: Parameters<SourceAdapter['discover']>[0]
): ReturnType<SourceAdapter['discover']> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await provider.discover(request)
    } catch (error) {
      if (
        !(error instanceof ProviderDiscoveryError) ||
        error.errorClass !== 'temporary' ||
        attempt === 3
      ) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 500))
    }
  }
  throw new Error('Transient retry loop exhausted')
}

async function main(): Promise<void> {
  assert(
    process.versions.node.startsWith('24.'),
    'Acceptance requires Node.js 24'
  )
  const repository = await RuntimeRepository.open(
    required('QIUSHUI_AIRADAR_ACCEPT_ROOT')
  )
  const twitterApiKey = required('TWITTERAPI_IO_KEY')
  const tikHubToken = required('TIKHUB_API_KEY')
  const youtubeApiKey = required('YOUTUBE_API_KEY')
  const openAiX = source('x', 'OpenAI', 'accept-x-openai')
  const openAiYouTube = source(
    'youtube',
    'https://www.youtube.com/@OpenAI',
    'accept-youtube-openai'
  )
  const ycX = source('x', 'ycombinator', 'accept-x-ycombinator')
  const ycYouTube = source(
    'youtube',
    'https://www.youtube.com/@ycombinator',
    'accept-youtube-ycombinator'
  )

  const captureResponse: CaptureProviderResponse = async (response) => {
    await repository.saveRawResponse({
      id: randomUUID(),
      providerId: response.providerId,
      receivedAt: response.receivedAt,
      payload: { request: response.request, response: response.payload },
    })
  }
  const audit = async (attempt: ProviderAttemptAudit) => {
    await repository.saveProviderAttempt({ id: randomUUID(), ...attempt })
  }
  const healthStore: ProviderHealthStore = {
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
  }

  const openAiChannelId = 'UCXZCJLdBC09xxGZ6gcdrc6A'
  const providers: SourceAdapter[] = [
    createTwitterApiIoProvider({ apiKey: twitterApiKey, captureResponse }),
    createTikHubXProvider({ token: tikHubToken, captureResponse }),
    createYouTubeDataApiProvider({ apiKey: youtubeApiKey, captureResponse }),
    createTikHubYouTubeProvider({
      token: tikHubToken,
      channelId: openAiChannelId,
      captureResponse,
    }),
  ]
  const providerSources = [openAiX, openAiX, openAiYouTube, openAiYouTube]
  const realBatches = []
  for (const [index, provider] of providers.entries()) {
    const providerSource = providerSources[index]
    assert(providerSource, 'Missing provider acceptance source')
    const batch = await discoverWithTransientRetry(provider, {
      source: providerSource,
      limit: 10,
    })
    assert(
      batch.items.length > 0,
      `${provider.providerId} returned no real items`
    )
    realBatches.push(batch)
  }
  const twitterBatch = realBatches[0]
  assert(twitterBatch, 'Missing TwitterAPI.io acceptance batch')
  const kinds = new Set(twitterBatch.items.map((item) => item.content.kind))
  assert(
    kinds.has('short_post') && kinds.has('article') && kinds.has('video'),
    'Real X batch lacks short/article/video evidence'
  )
  const firstGoogleBatch = realBatches[2]
  assert(
    firstGoogleBatch?.nextCursor,
    'Google normal-video route has no second-page cursor'
  )
  const secondGoogleBatch = await discoverWithTransientRetry(
    providers[2] as SourceAdapter,
    {
      source: openAiYouTube,
      cursor: firstGoogleBatch.nextCursor,
      limit: 3,
    }
  )
  assert(
    secondGoogleBatch.items.length > 0,
    'Google normal-video second page returned no items'
  )

  const xRouter = createProviderRouter({
    providers: [
      createTwitterApiIoProvider({
        apiKey: 'invalid-acceptance-key',
        captureResponse,
      }),
      createTikHubXProvider({ token: tikHubToken, captureResponse }),
    ],
    audit,
    healthStore,
  })
  const youtubeRouter = createProviderRouter({
    providers: [
      createYouTubeDataApiProvider({
        apiKey: 'invalid-acceptance-key',
        captureResponse,
      }),
      createTikHubYouTubeProvider({
        token: tikHubToken,
        channelId: openAiChannelId,
        captureResponse,
      }),
    ],
    audit,
    healthStore,
  })
  const xFallback = await xRouter.discover({ source: openAiX, limit: 5 })
  const youtubeFallback = await youtubeRouter.discover({
    source: openAiYouTube,
    limit: 5,
  })
  assert(
    xFallback.items.length > 0 && youtubeFallback.items.length > 0,
    'Real provider fallback returned no items'
  )

  const ycTwitter = createTwitterApiIoProvider({
    apiKey: twitterApiKey,
    captureResponse,
  })
  const ycGoogle = createYouTubeDataApiProvider({
    apiKey: youtubeApiKey,
    captureResponse,
  })
  const [xBatch, youtubeBatch] = await Promise.all([
    ycTwitter.discover({ source: ycX, limit: 20 }),
    ycGoogle.discover({ source: ycYouTube, limit: 20 }),
  ])
  const youtubeIds = new Set(
    youtubeBatch.items.map((item) => item.platformIdentity).filter(Boolean)
  )
  const xVideo = xBatch.items.find((item) =>
    youtubeIds.has(item.platformIdentity)
  )
  assert(
    xVideo?.platformIdentity,
    'No real X-to-YouTube cross-source identity found'
  )
  assert(
    youtubeBatch.items.some(
      (item) => item.platformIdentity === xVideo.platformIdentity
    ),
    'Matching YouTube discovery is missing'
  )

  await runPlatformDiscovery({
    repository,
    runner: {
      async discover() {
        return twitterBatch
      },
    },
    source: openAiX,
    limit: 10,
  })
  const googleBatch = realBatches[2]
  assert(googleBatch?.items[0], 'Missing real Google YouTube video')
  await runPlatformDiscovery({
    repository,
    runner: {
      async discover() {
        return googleBatch
      },
    },
    source: openAiYouTube,
    limit: 10,
  })
  const captionProvider = createTikHubYouTubeTranscriptProvider({
    token: tikHubToken,
    captureResponse,
  })
  let captionResult:
    Awaited<ReturnType<typeof enrichYouTubeContent>> | undefined
  for (const item of googleBatch.items) {
    try {
      const result = await enrichYouTubeContent({
        repository,
        contentId: item.platformIdentity as string,
        transcriptProvider: captionProvider,
      })
      if (result.status === 'succeeded') {
        captionResult = result
        break
      }
    } catch (error) {
      if (
        !(error instanceof ProviderDiscoveryError) ||
        error.errorClass !== 'temporary'
      ) {
        throw error
      }
    }
  }
  assert(captionResult, 'No real Google video produced a platform caption')
  await runPlatformDiscovery({
    repository,
    runner: {
      async discover() {
        return xBatch
      },
    },
    source: ycX,
    limit: 20,
  })
  await runPlatformDiscovery({
    repository,
    runner: {
      async discover() {
        return youtubeBatch
      },
    },
    source: ycYouTube,
    limit: 20,
  })

  const discoveries = repository
    .listDiscoveries()
    .filter((entry) => entry.contentId === xVideo.platformIdentity)
  const persistedKinds = new Set(
    repository.listContents().map((entry) => entry.kind)
  )
  const blockedVideo = repository.getContent(xVideo.platformIdentity)
  assert(discoveries.length >= 2, 'Cross-source discovery evidence is missing')
  assert(
    new Set(discoveries.map((entry) => entry.sourceId)).size === 2,
    'Cross-source discoveries did not preserve both sources'
  )
  assert(
    repository
      .listContents()
      .filter((entry) => entry.id === xVideo.platformIdentity).length === 1,
    'Cross-source identity created duplicate content'
  )
  assert(
    persistedKinds.has('short_post') &&
      persistedKinds.has('article') &&
      persistedKinds.has('video'),
    'Short/article/video evidence was not persisted'
  )
  assert(
    blockedVideo?.enrichmentStatus === 'waiting-manual-transcription',
    'Incomplete video did not enter manual-transcription wait'
  )
  await repository
    .saveAnalysis({
      id: 'must-not-save',
      contentId: xVideo.platformIdentity,
      fingerprint: 'blocked',
      version: 1,
      manual: false,
      provider: 'acceptance',
      model: 'gpt-5.3-codex-spark',
      promptVersion: 'v1',
      profileVersionId: 'v1',
      ruleVersion: 'v1',
      createdAt: new Date().toISOString(),
      durationMs: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
      result: {},
    })
    .then(
      () => {
        throw new Error('Incomplete video analysis was incorrectly saved')
      },
      (error: unknown) => {
        assert(
          error instanceof Error && /completely enriched/u.test(error.message),
          'Unexpected incomplete-analysis error'
        )
      }
    )

  const attempts = repository.listProviderAttempts()
  const summary = {
    node: process.version,
    providers: providers.map((provider, index) => ({
      providerId: provider.providerId,
      realItems: realBatches[index]?.items.length ?? 0,
    })),
    realFailover: {
      x: attempts
        .filter((entry) => entry.sourceId === openAiX.id)
        .map(({ providerId, status, errorClass }) => ({
          providerId,
          status,
          errorClass,
        })),
      youtube: attempts
        .filter((entry) => entry.sourceId === openAiYouTube.id)
        .map(({ providerId, status, errorClass }) => ({
          providerId,
          status,
          errorClass,
        })),
    },
    crossSource: {
      platformIdentity: xVideo.platformIdentity,
      discoveries: discoveries.length,
      contentRecords: 1,
      interactionSnapshots: repository.listInteractionSnapshots(
        xVideo.platformIdentity
      ).length,
    },
    persistedEvidenceKinds: [...persistedKinds].sort(),
    incompleteVideoGate: blockedVideo.enrichmentStatus,
    rawResponseRetentionDays: 30,
    platformCaption: captionResult.status,
    googleNormalVideoSecondPageItems: secondGoogleBatch.items.length,
  }
  await repository.close()
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}

await main()
