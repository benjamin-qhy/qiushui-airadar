import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { createServiceApp } from '../apps/service/src/index.js'
import type { Source } from '../packages/domain/src/index.js'
import {
  analyzeStoredContent,
  createCodexPiGateway,
  enrichImagePostContent,
  enrichPlatformVideoContent,
  rssAcceptanceModel,
  runPlatformDiscovery,
  type VideoKeyframeRecognizer,
} from '../packages/pipeline/src/index.js'
import { RuntimeRepository } from '../packages/runtime/src/index.js'
import {
  createGetBijiDouyinProvider,
  createGetBijiDouyinTranscriber,
  createTikHubDouyinProvider,
  createTikHubWechatChannelsProvider,
  createTikHubXiaohongshuDetailProvider,
  createTikHubXiaohongshuProvider,
  fetchTikHubWechatChannelsMedia,
  ProviderDiscoveryError,
  type CaptureProviderResponse,
  type SourceAdapter,
  type VideoTranscriber,
} from '../packages/source-adapters/src/index.js'

const execFileAsync = promisify(execFile)

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function source(
  type: Source['type'],
  identity: string,
  id: string,
  name: string
): Source {
  return {
    id,
    slug: id,
    name,
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
      await new Promise((resolve) => setTimeout(resolve, attempt * 750))
    }
  }
  throw new Error('Transient retry loop exhausted')
}

async function main(): Promise<void> {
  assert(
    process.versions.node.startsWith('24.'),
    'Acceptance requires Node.js 24'
  )
  assert(
    rssAcceptanceModel === 'gpt-5.3-codex-spark',
    'Acceptance analysis must use gpt-5.3-codex-spark'
  )
  const repository = await RuntimeRepository.open(
    required('QIUSHUI_AIRADAR_ACCEPT_ROOT')
  )
  let repositoryOpen = true
  const scratch = await mkdtemp(
    path.join(tmpdir(), 'qiushui-airadar-cn-accept-')
  )
  try {
    const tikHubToken = required('TIKHUB_API_KEY')
    const getBijiApiKey = required('GETBIJI_API_KEY')
    const getBijiClientId = required('GETBIJI_CLIENT_ID')
    const captureResponse: CaptureProviderResponse = async (response) => {
      await repository.saveRawResponse({
        id: randomUUID(),
        providerId: response.providerId,
        receivedAt: response.receivedAt,
        payload: { request: response.request, response: response.payload },
      })
    }
    const sources = {
      douyin: source(
        'douyin',
        'MS4wLjABAAAAfte3rFiVQ8VUE3Nfxph1NhCnq1ZAttn43OIr5UsXD5c',
        'accept-douyin-jiang',
        '清华姜学长'
      ),
      wechat: source(
        'wechat_channels',
        'v2_060000231003b20faec8c5e58f11c0d1c907ea3cb0773aa66217afdebf30bc4900972eea529c@finder',
        'accept-wechat-zhangzhang',
        '张张AI视界'
      ),
      xiaohongshu: source(
        'xiaohongshu',
        '69e6d2740000000002001404',
        'accept-xiaohongshu-wendy',
        '稳卖选手Wendy'
      ),
    }
    const providers = {
      douyin: createTikHubDouyinProvider({
        token: tikHubToken,
        captureResponse,
      }),
      getBiji: createGetBijiDouyinProvider({
        apiKey: getBijiApiKey,
        clientId: getBijiClientId,
        topicId: '1n3ODBLn',
        followId: '1286623',
        captureResponse,
      }),
      wechat: createTikHubWechatChannelsProvider({
        token: tikHubToken,
        captureResponse,
      }),
      xiaohongshu: createTikHubXiaohongshuProvider({
        token: tikHubToken,
        captureResponse,
      }),
      xiaohongshuDetail: createTikHubXiaohongshuDetailProvider({
        token: tikHubToken,
        captureResponse,
      }),
    }

    const [douyinBatch, getBijiBatch, wechatBatch, xiaohongshuBatch] =
      await Promise.all([
        discoverWithTransientRetry(providers.douyin, {
          source: sources.douyin,
          limit: 5,
        }),
        discoverWithTransientRetry(providers.getBiji, {
          source: sources.douyin,
          limit: 5,
        }),
        discoverWithTransientRetry(providers.wechat, {
          source: sources.wechat,
          limit: 5,
        }),
        discoverWithTransientRetry(providers.xiaohongshu, {
          source: sources.xiaohongshu,
          limit: 1,
        }),
      ])
    assert(douyinBatch.items.length > 0, 'Douyin returned no real items')
    assert(getBijiBatch.items.length > 0, 'GetBiji returned no real items')
    assert(wechatBatch.items.length > 0, 'WeChat Channels returned no items')
    const imageItem = xiaohongshuBatch.items.find(
      (item) => item.content.kind === 'image_post'
    )
    assert(imageItem?.platformIdentity, 'Xiaohongshu returned no image post')

    for (const [batch, providerSource] of [
      [douyinBatch, sources.douyin],
      [getBijiBatch, sources.douyin],
      [wechatBatch, sources.wechat],
      [xiaohongshuBatch, sources.xiaohongshu],
    ] as const) {
      await runPlatformDiscovery({
        repository,
        runner: {
          async discover() {
            return batch
          },
        },
        source: providerSource,
        limit: batch.items.length,
      })
    }

    const incrementalResults: Record<string, string[]> = {}
    for (const [name, provider, providerSource, batch] of [
      ['douyin', providers.douyin, sources.douyin, douyinBatch],
      ['getBijiDouyin', providers.getBiji, sources.douyin, getBijiBatch],
      ['wechatChannels', providers.wechat, sources.wechat, wechatBatch],
      [
        'xiaohongshu',
        providers.xiaohongshu,
        sources.xiaohongshu,
        xiaohongshuBatch,
      ],
    ] as const) {
      assert(batch.nextCursor, `${name} did not return an incremental cursor`)
      const firstIds = new Set(batch.items.map(({ externalId }) => externalId))
      const next = await runPlatformDiscovery({
        repository,
        runner: {
          discover(request) {
            return discoverWithTransientRetry(provider, request)
          },
        },
        source: providerSource,
        cursor: batch.nextCursor,
        limit: 1,
      })
      const nextIds = next.items.map(({ externalId }) => externalId)
      assert(nextIds.length > 0, `${name} second page returned no items`)
      assert(
        nextIds.every((id) => !firstIds.has(id)),
        `${name} second page repeated the first page instead of advancing`
      )
      incrementalResults[name] = nextIds
    }

    const getBijiItem = getBijiBatch.items.find(
      (item) => item.platformIdentity && item.video?.providerReference
    )
    assert(getBijiItem?.platformIdentity, 'No GetBiji transcript candidate')
    const douyinTranscript = await enrichPlatformVideoContent({
      repository,
      contentId: getBijiItem.platformIdentity,
      transcriber: createGetBijiDouyinTranscriber({
        apiKey: getBijiApiKey,
        clientId: getBijiClientId,
        topicId: '1n3ODBLn',
        captureResponse,
      }),
      manual: true,
    })

    const wechatItem = wechatBatch.items
      .filter(
        (item) =>
          item.platformIdentity &&
          item.video?.mediaUrl &&
          item.video.durationSeconds !== undefined
      )
      .toSorted(
        (left, right) =>
          (left.video?.durationSeconds ?? Infinity) -
          (right.video?.durationSeconds ?? Infinity)
      )[0]
    assert(wechatItem?.platformIdentity, 'No WeChat transcription candidate')
    const videoPath = path.join(scratch, 'wechat-video.mp4')
    const ocrBinary = path.join(scratch, 'macos-vision-ocr')
    await execFileAsync('swiftc', [
      path.join(process.cwd(), 'scripts/macos-vision-ocr.swift'),
      '-o',
      ocrBinary,
    ])
    const localWhisper: VideoTranscriber = {
      providerId: 'mlx-whisper-tiny',
      async transcribe(input) {
        assert(
          input.providerReference,
          'WeChat video has no provider reference'
        )
        let asset:
          Awaited<ReturnType<typeof fetchTikHubWechatChannelsMedia>> | undefined
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            asset = await fetchTikHubWechatChannelsMedia({
              token: tikHubToken,
              username: input.providerReference,
              videoId: input.videoId,
              captureResponse,
            })
            break
          } catch (error) {
            if (
              !(error instanceof ProviderDiscoveryError) ||
              error.errorClass !== 'temporary' ||
              attempt === 3
            ) {
              throw error
            }
            await new Promise((resolve) => setTimeout(resolve, attempt * 750))
          }
        }
        assert(asset, 'WeChat media resolution exhausted its retries')
        const audioPath = path.join(scratch, 'wechat-audio.m4a')
        const directEnvironment = { ...process.env }
        delete directEnvironment.ALL_PROXY
        delete directEnvironment.HTTPS_PROXY
        delete directEnvironment.HTTP_PROXY
        await execFileAsync(
          'uvx',
          [
            '--from',
            'wxipad-video',
            'wxipad-decrypt',
            asset.mediaUrl,
            asset.decodeKey,
            '--output',
            videoPath,
          ],
          { maxBuffer: 10 * 1024 * 1024 }
        )
        await execFileAsync('ffmpeg', [
          '-loglevel',
          'error',
          '-y',
          '-i',
          videoPath,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          audioPath,
        ])
        await execFileAsync(
          'uvx',
          [
            '--from',
            'mlx-whisper',
            'mlx_whisper',
            audioPath,
            '--model',
            'mlx-community/whisper-tiny',
            '--output-name',
            'wechat-transcript',
            '--output-dir',
            scratch,
            '--output-format',
            'txt',
            '--language',
            'zh',
            '--verbose',
            'False',
          ],
          { env: directEnvironment, maxBuffer: 10 * 1024 * 1024 }
        )
        return readFile(path.join(scratch, 'wechat-transcript.txt'), 'utf8')
      },
    }
    const keyframeRecognizer: VideoKeyframeRecognizer = {
      providerId: 'ffmpeg-macos-vision',
      async recognizeKeyframes() {
        const duration = wechatItem.video?.durationSeconds ?? 30
        const timestamps = [1, 5, 10, Math.floor(duration / 2)]
          .filter(
            (value, index, values) =>
              value < duration && values.indexOf(value) === index
          )
          .slice(0, 4)
        const frames: Array<{ atSeconds: number; recognizedText: string }> = []
        for (const [index, atSeconds] of timestamps.entries()) {
          const framePath = path.join(scratch, `wechat-frame-${index}.png`)
          await execFileAsync('ffmpeg', [
            '-loglevel',
            'error',
            '-y',
            '-ss',
            String(atSeconds),
            '-i',
            videoPath,
            '-frames:v',
            '1',
            framePath,
          ])
          const { stdout } = await execFileAsync(ocrBinary, [framePath], {
            maxBuffer: 10 * 1024 * 1024,
          })
          if (stdout.trim()) {
            frames.push({ atSeconds, recognizedText: stdout.trim() })
          }
        }
        return frames
      },
    }
    const wechatTranscript = await enrichPlatformVideoContent({
      repository,
      contentId: wechatItem.platformIdentity,
      transcriber: localWhisper,
      manual: true,
      requireKeyframes: true,
      keyframeRecognizer,
    })

    const imageEnrichment = await enrichImagePostContent({
      repository,
      contentId: imageItem.platformIdentity,
      detailProvider: providers.xiaohongshuDetail,
    })
    const completedImage = repository.getContent(imageItem.platformIdentity)
    const completedWechat = repository.getContent(wechatItem.platformIdentity)
    assert(
      (completedImage?.sourceText?.length ?? 0) >= 50 &&
        (completedImage?.images?.length ?? 0) >= 2,
      'Xiaohongshu detail lacks full body or ordered images'
    )
    assert(
      Array.isArray(
        (completedWechat?.media as { keyframes?: unknown } | undefined)
          ?.keyframes
      ),
      'WeChat video lacks required keyframe recognition'
    )

    const gateway = createCodexPiGateway(
      path.join(
        process.env.CODEX_HOME ?? path.join(homedir(), '.codex'),
        'auth.json'
      ),
      rssAcceptanceModel
    )
    const analyzedIds: string[] = [
      getBijiItem.platformIdentity,
      wechatItem.platformIdentity,
      imageItem.platformIdentity,
    ]
    const shortPost = repository
      .listContents()
      .find(
        (content) =>
          content.kind === 'short_post' &&
          content.enrichmentStatus === 'succeeded' &&
          content.body.trim()
      )
    assert(shortPost, 'Shared acceptance root has no enriched real short post')
    analyzedIds.push(shortPost.id)
    const analyses = []
    for (const contentId of analyzedIds) {
      analyses.push(
        await analyzeStoredContent(repository, contentId, {
          modelGateway: gateway,
          profile:
            '关注人工智能产品、智能体、开发工具、内容生产与企业落地，偏好可信、具体、可行动的信息。',
          profileVersionId: 'acceptance-profile-cn-v1',
          ruleVersion: 'chinese-platform-rules-v1',
          modelRouteVersion: `pi-${rssAcceptanceModel}-v1`,
          manual: false,
        })
      )
    }

    let providerFailureClass: string | undefined
    try {
      await createTikHubDouyinProvider({
        token: 'invalid-acceptance-key',
      }).discover({
        source: sources.douyin,
        limit: 1,
      })
    } catch (error) {
      if (error instanceof ProviderDiscoveryError) {
        providerFailureClass = error.errorClass
      }
    }
    assert(providerFailureClass, 'Provider failure was not classified')
    const getBijiSnapshot = repository
      .listInteractionSnapshots(getBijiItem.platformIdentity)
      .find((entry) => entry.providerId === 'getbiji-douyin')
    assert(getBijiSnapshot, 'GetBiji null-metric snapshot is missing')
    assert(
      [
        getBijiSnapshot.views,
        getBijiSnapshot.likes,
        getBijiSnapshot.comments,
        getBijiSnapshot.shares,
        getBijiSnapshot.saves,
      ].every((value) => value === null),
      'Missing interaction metrics were converted to zero'
    )
    const kinds = new Set(repository.listContents().map((entry) => entry.kind))
    assert(
      ['short_post', 'video', 'image_post', 'article'].every((kind) =>
        kinds.has(kind as 'short_post' | 'video' | 'image_post' | 'article')
      ),
      'Shared acceptance root lacks a real sample for all four content kinds'
    )

    const completed = analyzedIds.map((id) => repository.getContent(id))
    assert(
      completed.every(
        (content) =>
          content?.enrichmentStatus === 'succeeded' && content.body.trim()
      ),
      'A Chinese-platform sample is not completely enriched'
    )

    await repository.close()
    repositoryOpen = false
    const service = createServiceApp({
      dataRoot: required('QIUSHUI_AIRADAR_ACCEPT_ROOT'),
    })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    let webIds: string[] = []
    try {
      const response = await fetch(
        `http://${address.host}:${address.port}/api/contents`
      )
      assert(response.ok, 'Web API did not return a successful feed')
      const payload = (await response.json()) as {
        items?: Array<{ id?: unknown }>
      }
      webIds = (payload.items ?? []).flatMap((item) =>
        typeof item.id === 'string' ? [item.id] : []
      )
      assert(
        analyzedIds.every((id) => webIds.includes(id)),
        'Web feed is missing an analyzed acceptance item'
      )
    } finally {
      await service.stop()
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          node: process.version,
          model: rssAcceptanceModel,
          providers: {
            douyin: douyinBatch.items.length,
            getBijiDouyin: getBijiBatch.items.length,
            wechatChannels: wechatBatch.items.length,
            xiaohongshu: xiaohongshuBatch.items.length,
          },
          incrementalCursors: {
            douyin: incrementalResults.douyin?.length ?? 0,
            getBijiDouyin: incrementalResults.getBijiDouyin?.length ?? 0,
            wechatChannels: incrementalResults.wechatChannels?.length ?? 0,
            xiaohongshu: incrementalResults.xiaohongshu?.length ?? 0,
          },
          enrichment: {
            douyin: douyinTranscript.status,
            wechatChannels: wechatTranscript.status,
            wechatKeyframes: (
              completedWechat?.media as
                { keyframes?: Array<unknown> } | undefined
            )?.keyframes?.length,
            xiaohongshu: imageEnrichment.status,
            xiaohongshuImages: completedImage?.images?.length ?? 0,
          },
          analyzed: analyses.map((analysis) => ({
            contentId: analysis.contentId,
            provider: analysis.provider,
            model: analysis.model,
            recommendation: analysis.result.recommendation,
          })),
          contentKinds: [...kinds].sort(),
          webFeedItems: webIds.length,
          missingMetricsRemainNull: true,
          providerFailureClass,
          strictUnitGates: [
            'missing-image',
            'missing-transcript',
            'single-item-isolation',
          ],
        },
        null,
        2
      )}\n`
    )
  } finally {
    if (repositoryOpen) await repository.close()
    await rm(scratch, { recursive: true, force: true })
  }
}

await main()
