import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'vitest'

import { RuntimeRepository } from '@qiushuiai-airadar/runtime'

import {
  calculateRecommendation,
  canonicalizeArticleUrl,
  createPiModelGateway,
  detectOriginalLanguage,
  createReadOnlyCodexCredentialStore,
  enrichArticle,
  enrichImagePostContent,
  enrichImagePostsIndependently,
  enrichPlatformVideoContent,
  enrichPlatformVideosIndependently,
  enrichYouTubeContent,
  RssAdapter,
  runPlatformDiscovery,
  runRssDiscovery,
  runRssPipeline,
  analyzeStoredContent,
} from './index.js'

const roots: string[] = []

async function repository(): Promise<RuntimeRepository> {
  const root = await mkdtemp(path.join(tmpdir(), 'qiushuiai-airadar-pipeline-'))
  roots.push(root)
  return RuntimeRepository.open(root)
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  )
})

describe('X and YouTube discovery gate', () => {
  it('does not enqueue article enrichment for a confirmed non-article page', async () => {
    const runtime = await repository()
    await runPlatformDiscovery({
      repository: runtime,
      source: {
        id: 'x-non-article',
        slug: 'x-non-article',
        name: 'X non-article',
        type: 'x',
        externalIdentity: 'example',
        status: 'enabled',
      },
      limit: 1,
      runner: {
        async discover() {
          return {
            providerId: 'provider-1',
            items: [
              {
                externalId: 'post-1',
                platformIdentity:
                  'url:https://events.ycombinator.com/MakeSomethingAgentsWant',
                content: {
                  kind: 'article',
                  canonicalUrl:
                    'https://events.ycombinator.com/MakeSomethingAgentsWant',
                  title: 'Event',
                },
              },
            ],
          }
        },
      },
    })
    expect(
      runtime.getContent(
        'url:https://events.ycombinator.com/MakeSomethingAgentsWant'
      )
    ).toMatchObject({
      enrichmentStatus: 'failed',
      enrichmentError: '活动页：活动报名与介绍，不是文章正文',
    })
    expect(runtime.indexedTaskCount()).toBe(0)
    await runtime.close()
  })

  it('clears a persisted provider cursor after reaching the last page', async () => {
    const runtime = await repository()
    await runtime.advanceProgress('x-last-page', 'old-page')
    await runPlatformDiscovery({
      repository: runtime,
      source: {
        id: 'x-last-page',
        slug: 'x-last-page',
        name: 'X last page',
        type: 'x',
        externalIdentity: 'example',
        status: 'enabled',
      },
      cursor: 'old-page',
      limit: 1,
      runner: {
        async discover() {
          return { providerId: 'provider-1', items: [] }
        },
      },
    })
    expect(runtime.getProgress('x-last-page')).toMatchObject({
      sourceId: 'x-last-page',
    })
    expect(runtime.getProgress('x-last-page')?.cursor).toBeUndefined()
    await runtime.close()
  })

  it('merges self-reply thread parts that arrive on later pages', async () => {
    const runtime = await repository()
    const source = {
      id: 'x-thread',
      slug: 'x-thread',
      name: 'X thread',
      type: 'x' as const,
      externalIdentity: 'example',
      status: 'enabled' as const,
    }
    let page = 0
    const runner = {
      async discover() {
        page += 1
        const isRoot = page === 2
        return {
          providerId: 'provider-1',
          nextCursor: isRoot ? undefined : 'page-2',
          items: [
            {
              externalId: isRoot ? 'root-1' : 'reply-1',
              platformIdentity: 'x:root-1',
              description: isRoot ? 'part one' : 'part two',
              content: {
                kind: 'short_post' as const,
                canonicalUrl: 'https://x.com/i/status/root-1',
                title: isRoot ? 'part one' : 'part two',
              },
              thread: {
                conversationId: 'root-1',
                complete: isRoot,
                parts: [
                  {
                    id: isRoot ? 'root-1' : 'reply-1',
                    text: isRoot ? 'part one' : 'part two',
                    publishedAt: isRoot
                      ? '2026-09-14T08:00:00.000Z'
                      : '2026-09-14T08:01:00.000Z',
                  },
                ],
              },
            },
          ],
        }
      },
    }
    await runPlatformDiscovery({
      repository: runtime,
      source,
      limit: 1,
      runner,
    })
    expect(runtime.getContent('x:root-1')).toMatchObject({
      body: '',
      enrichmentStatus: 'pending',
    })
    expect(runtime.indexedTaskCount()).toBe(0)
    await runPlatformDiscovery({
      repository: runtime,
      source,
      cursor: 'page-2',
      limit: 1,
      runner,
    })
    await runPlatformDiscovery({
      repository: runtime,
      source,
      limit: 1,
      runner: {
        async discover() {
          return {
            providerId: 'provider-1',
            items: [
              {
                externalId: 'retweet-1',
                platformIdentity: 'x:root-1',
                description: 'retweet carrier evidence',
                content: {
                  kind: 'short_post',
                  canonicalUrl: 'https://x.com/i/status/root-1',
                  title: 'Retweet evidence',
                },
              },
            ],
          }
        },
      },
    })
    expect(runtime.getContent('x:root-1')).toMatchObject({
      body: 'part one\n\npart two',
      threadParts: [
        { id: 'root-1', text: 'part one' },
        { id: 'reply-1', text: 'part two' },
      ],
    })
    expect(runtime.indexedContentCount()).toBe(1)
    expect(runtime.indexedDiscoveryCount()).toBe(3)
    await runtime.close()
  })

  it('persists every same-batch X discovery with matching evidence', async () => {
    const runtime = await repository()
    await runPlatformDiscovery({
      repository: runtime,
      source: {
        id: 'x-shared-video',
        slug: 'x-shared-video',
        name: 'X shared video',
        type: 'x',
        externalIdentity: 'example',
        status: 'enabled',
      },
      limit: 2,
      runner: {
        async discover() {
          return {
            providerId: 'provider-1',
            items: [
              {
                externalId: 'post-1',
                platformIdentity: 'youtube:dQw4w9WgXcQ',
                content: {
                  kind: 'video',
                  canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                  title: 'Shared video',
                },
                evidence: {
                  carrier: 'youtube',
                  discoveryUrl: 'https://x.com/i/status/post-1',
                },
                discoveryParts: ['post-1', 'post-2'].map((externalId) => ({
                  externalId,
                  discoveryUrl: `https://x.com/i/status/${externalId}`,
                  sourceText: `evidence ${externalId}`,
                  interaction: {
                    capturedAt: '2026-09-14T08:00:00.000Z',
                    views: externalId === 'post-1' ? 10 : 20,
                    likes: null,
                    comments: null,
                    shares: null,
                    saves: null,
                  },
                })),
              },
            ],
          }
        },
      },
    })
    const discoveries = runtime.listDiscoveries('x-shared-video')
    expect(discoveries).toHaveLength(2)
    for (const discovery of discoveries) {
      expect(discovery.evidence).toMatchObject({
        discoveryUrl: discovery.discoveryUrl,
        sourceText: discovery.sourceText,
      })
    }
    expect(
      runtime
        .listInteractionSnapshots('youtube:dQw4w9WgXcQ')
        .map((snapshot) => [snapshot.externalId, snapshot.views])
        .sort()
    ).toEqual([
      ['post-1', 10],
      ['post-2', 20],
    ])
    await runtime.close()
  })

  it('does not advance the cursor when a snapshot side effect fails', async () => {
    const runtime = await repository()
    runtime.saveInteractionSnapshot = async () => {
      throw new Error('forced snapshot failure')
    }
    await expect(
      runPlatformDiscovery({
        repository: runtime,
        source: {
          id: 'x-cursor',
          slug: 'x-cursor',
          name: 'X cursor',
          type: 'x',
          externalIdentity: 'example',
          status: 'enabled',
        },
        limit: 1,
        runner: {
          async discover() {
            return {
              providerId: 'provider-1',
              nextCursor: 'next-page',
              items: [
                {
                  externalId: 'short-1',
                  platformIdentity: 'x:short-1',
                  description: 'complete short',
                  content: {
                    kind: 'short_post',
                    canonicalUrl: 'https://x.com/i/status/short-1',
                    title: 'Short',
                  },
                  interaction: {
                    capturedAt: '2026-09-14T08:00:00.000Z',
                    views: 1,
                    likes: null,
                    comments: null,
                    shares: null,
                    saves: null,
                  },
                },
              ],
            }
          },
        },
      })
    ).rejects.toThrow('forced snapshot failure')
    expect(runtime.getProgress('x-cursor')).toBeUndefined()
    await runtime.close()
  })

  it('persists short/article/video evidence and blocks incomplete video analysis', async () => {
    const runtime = await repository()
    const source = {
      id: 'x-source',
      slug: 'x-source',
      name: 'X source',
      type: 'x' as const,
      externalIdentity: 'example',
      status: 'enabled' as const,
    }
    const interaction = {
      capturedAt: '2026-09-14T08:00:00.000Z',
      views: 10,
      likes: 2,
      comments: null,
      shares: null,
      saves: null,
    }
    const result = await runPlatformDiscovery({
      repository: runtime,
      source,
      limit: 10,
      runner: {
        async discover() {
          return {
            providerId: 'test-provider',
            items: [
              {
                externalId: 'short-1',
                platformIdentity: 'x:short-1',
                description: 'complete short text',
                content: {
                  kind: 'short_post',
                  canonicalUrl: 'https://x.com/i/status/short-1',
                  title: 'Short',
                },
                evidence: {
                  discoveryUrl: 'https://x.com/i/status/short-1',
                  carrier: 'x-short',
                  sourceText: 'complete short text',
                },
                interaction,
              },
              {
                externalId: 'article-1',
                platformIdentity: 'url:https://example.com/article',
                description: 'link context only',
                content: {
                  kind: 'article',
                  canonicalUrl: 'https://example.com/article',
                  title: 'Article',
                },
                evidence: {
                  discoveryUrl: 'https://x.com/i/status/article-1',
                  carrier: 'external-article',
                  sourceText: 'link context only',
                },
                interaction,
              },
              {
                externalId: 'video-1',
                platformIdentity: 'youtube:dQw4w9WgXcQ',
                content: {
                  kind: 'video',
                  canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                  title: 'Video',
                },
                evidence: {
                  discoveryUrl: 'https://x.com/i/status/video-1',
                  carrier: 'youtube',
                  transcriptStatus: 'missing',
                },
                video: { scope: 'normal', durationSeconds: 600 },
                interaction,
              },
            ],
          }
        },
      },
    })
    expect(result).toMatchObject({ analyzeReady: 1, blocked: 2 })
    expect(runtime.getContent('x:short-1')).toMatchObject({
      enrichmentStatus: 'succeeded',
      body: 'complete short text',
    })
    expect(runtime.getContent('url:https://example.com/article')).toMatchObject(
      { enrichmentStatus: 'pending', body: '' }
    )
    expect(runtime.getContent('youtube:dQw4w9WgXcQ')).toMatchObject({
      enrichmentStatus: 'pending',
      body: '',
    })
    expect(
      runtime
        .listTasks()
        .some(
          (task) =>
            task.type === 'enrich' &&
            task.payload.contentId === 'youtube:dQw4w9WgXcQ'
        )
    ).toBe(true)

    await runPlatformDiscovery({
      repository: runtime,
      source: {
        id: 'youtube-source',
        slug: 'youtube-source',
        name: 'YouTube source',
        type: 'youtube',
        externalIdentity: '@example',
        status: 'enabled',
      },
      limit: 10,
      runner: {
        async discover() {
          return {
            providerId: 'youtube-data-api',
            items: [
              {
                externalId: 'dQw4w9WgXcQ',
                platformIdentity: 'youtube:dQw4w9WgXcQ',
                content: {
                  kind: 'video',
                  canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                  title: 'Authoritative YouTube title',
                },
                evidence: {
                  discoveryUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                  carrier: 'youtube',
                },
                video: { scope: 'normal', durationSeconds: 601 },
              },
            ],
          }
        },
      },
    })
    expect(runtime.getContent('youtube:dQw4w9WgXcQ')).toMatchObject({
      externalId: 'dQw4w9WgXcQ',
      title: 'Authoritative YouTube title',
      video: { scope: 'normal', durationSeconds: 601 },
    })
    await expect(
      runtime.saveAnalysis({
        id: 'forbidden-analysis',
        contentId: 'youtube:dQw4w9WgXcQ',
        fingerprint: 'f',
        version: 1,
        manual: false,
        provider: 'test',
        model: 'gpt-5.3-codex-spark',
        promptVersion: 'p1',
        profileVersionId: 'profile-1',
        ruleVersion: 'r1',
        createdAt: '2026-09-14T08:01:00.000Z',
        durationMs: 1,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        },
        result: {},
      })
    ).rejects.toThrow('Only completely enriched content can be analyzed')
    let transcribedVideoId = ''
    await expect(
      enrichYouTubeContent({
        repository: runtime,
        contentId: 'youtube:dQw4w9WgXcQ',
        transcriptProvider: {
          providerId: 'caption-provider',
          async fetchTranscript() {
            return { status: 'missing' }
          },
        },
        autoTranscribe: true,
        transcriber: {
          providerId: 'speech-to-text',
          async transcribe(request) {
            transcribedVideoId = request.videoId
            return 'complete automatic transcription'
          },
        },
      })
    ).resolves.toEqual({ status: 'succeeded', providerId: 'speech-to-text' })
    expect(transcribedVideoId).toBe('dQw4w9WgXcQ')
    expect(runtime.getContent('youtube:dQw4w9WgXcQ')).toMatchObject({
      enrichmentStatus: 'succeeded',
      body: 'complete automatic transcription',
    })
    await runtime.close()
  })
})

describe('strict multimedia enrichment', () => {
  it('merges complementary metadata from providers for one platform video', async () => {
    const runtime = await repository()
    const source = {
      id: 'douyin-source',
      slug: 'douyin-source',
      name: 'Douyin source',
      type: 'douyin' as const,
      externalIdentity: 'creator-1',
      status: 'enabled' as const,
    }
    for (const video of [
      { durationSeconds: 30, mediaUrl: 'https://media.example/video.mp4' },
      { providerReference: 'transcript-reference' },
    ]) {
      await runPlatformDiscovery({
        repository: runtime,
        source,
        limit: 1,
        runner: {
          async discover() {
            return {
              providerId: 'provider',
              items: [
                {
                  externalId: 'video-1',
                  platformIdentity: 'douyin:video-1',
                  content: {
                    kind: 'video' as const,
                    canonicalUrl: 'https://www.douyin.com/video/video-1',
                    title: 'Video',
                  },
                  video: { scope: 'normal' as const, ...video },
                },
              ],
            }
          },
        },
      })
    }
    expect(runtime.getContent('douyin:video-1')?.video).toMatchObject({
      durationSeconds: 30,
      mediaUrl: 'https://media.example/video.mp4',
      providerReference: 'transcript-reference',
    })
    await runtime.close()
  })

  it('keeps image posts pending until every ordered image attachment is saved', async () => {
    const runtime = await repository()
    await runPlatformDiscovery({
      repository: runtime,
      source: {
        id: 'xhs-images',
        slug: 'xhs-images',
        name: 'XHS images',
        type: 'xiaohongshu',
        externalIdentity: 'user-1',
        status: 'enabled',
      },
      limit: 1,
      runner: {
        async discover() {
          return {
            providerId: 'tikhub-xiaohongshu',
            items: [
              {
                externalId: 'note-1',
                platformIdentity: 'xiaohongshu:note-1',
                description: '图文正文',
                content: {
                  kind: 'image_post',
                  canonicalUrl: 'https://www.xiaohongshu.com/explore/note-1',
                  title: '图文样本',
                },
                images: [
                  { order: 0, url: 'https://media.example/one.webp' },
                  { order: 1, url: 'https://media.example/two.webp' },
                ],
              },
            ],
          }
        },
      },
    })
    expect(runtime.getContent('xiaohongshu:note-1')).toMatchObject({
      body: '',
      enrichmentStatus: 'pending',
      images: [
        { order: 0, url: 'https://media.example/one.webp' },
        { order: 1, url: 'https://media.example/two.webp' },
      ],
    })
    const task = await runtime.claimNextTask('image-worker')
    expect(task?.payload).toMatchObject({ mode: 'image-post-enrichment' })
    await runtime.completeTask(task!.id)

    await enrichImagePostContent({
      repository: runtime,
      contentId: 'xiaohongshu:note-1',
      fetch: async (url) =>
        new Response(new Uint8Array([String(url).includes('one') ? 1 : 2]), {
          headers: { 'content-type': 'image/webp' },
        }),
    })
    expect(
      await readFile(
        path.join(
          path.dirname(runtime.contentMarkdownPath('xiaohongshu:note-1')),
          'image-001.webp'
        )
      )
    ).toEqual(Buffer.from([1]))
    expect(
      await readFile(
        path.join(
          path.dirname(runtime.contentMarkdownPath('xiaohongshu:note-1')),
          'image-002.webp'
        )
      )
    ).toEqual(Buffer.from([2]))
    expect(runtime.getContent('xiaohongshu:note-1')).toMatchObject({
      enrichmentStatus: 'succeeded',
      body: '图文正文',
      media: {
        images: [
          { order: 0, fileName: 'image-001.webp' },
          { order: 1, fileName: 'image-002.webp' },
        ],
      },
    })
    await runtime.close()
  })

  it('does not complete an image post when any image is missing', async () => {
    const runtime = await repository()
    await runtime.commitDiscoveryBatch({
      sourceId: 'xhs',
      contents: [
        {
          id: 'xiaohongshu:broken',
          title: 'Broken image post',
          body: '',
          canonicalUrl: 'https://www.xiaohongshu.com/explore/broken',
          kind: 'image_post',
          enrichmentStatus: 'pending',
          sourceText: '图文正文',
          images: [
            { order: 0, url: 'https://media.example/one.webp' },
            { order: 1, url: 'https://media.example/missing.webp' },
          ],
        },
      ],
      discoveries: [
        {
          id: 'xhs:broken',
          sourceId: 'xhs',
          contentId: 'xiaohongshu:broken',
          discoveredAt: '2026-09-14T08:00:00.000Z',
        },
      ],
    })
    await expect(
      enrichImagePostContent({
        repository: runtime,
        contentId: 'xiaohongshu:broken',
        fetch: async (url) =>
          String(url).includes('missing')
            ? new Response('missing', { status: 404 })
            : new Response(new Uint8Array([1]), {
                headers: { 'content-type': 'image/webp' },
              }),
      })
    ).rejects.toThrow('image 2')
    expect(runtime.getContent('xiaohongshu:broken')).toMatchObject({
      body: '',
      enrichmentStatus: 'pending',
    })
    await runtime.close()
  })

  it('does not analyze image pixels when an image post has no platform text', async () => {
    const runtime = await repository()
    await runtime.commitDiscoveryBatch({
      sourceId: 'xhs-no-text',
      contents: [
        {
          id: 'xiaohongshu:no-text',
          title: 'Image-only post',
          body: '',
          canonicalUrl: 'https://www.xiaohongshu.com/explore/no-text',
          kind: 'image_post',
          enrichmentStatus: 'pending',
          images: [{ order: 0, url: 'https://media.example/image-only.webp' }],
        },
      ],
      discoveries: [
        {
          id: 'xhs-no-text:note',
          sourceId: 'xhs-no-text',
          contentId: 'xiaohongshu:no-text',
          discoveredAt: '2026-09-14T08:00:00.000Z',
        },
      ],
    })
    let fetched = false
    await expect(
      enrichImagePostContent({
        repository: runtime,
        contentId: 'xiaohongshu:no-text',
        fetch: async () => {
          fetched = true
          return new Response(new Uint8Array([1]), {
            headers: { 'content-type': 'image/webp' },
          })
        },
      })
    ).rejects.toThrow('no text for analysis')
    expect(fetched).toBe(false)
    await runtime.close()
  })

  it.each([
    [
      'private network URL',
      'http://127.0.0.1/private.png',
      undefined,
      'trusted media CDN',
    ],
    [
      'non-image response',
      'https://media.example/not-image',
      async () =>
        new Response('html', { headers: { 'content-type': 'text/html' } }),
      'invalid content type',
    ],
    [
      'unsupported image MIME',
      'https://media.example/vector.svg',
      async () =>
        new Response('<svg/>', {
          headers: { 'content-type': 'image/svg+xml' },
        }),
      'invalid content type',
    ],
    [
      'oversized image',
      'https://media.example/large.png',
      async () =>
        new Response(new Uint8Array([1]), {
          headers: {
            'content-type': 'image/png',
            'content-length': String(21 * 1024 * 1024),
          },
        }),
      'size limit',
    ],
  ] as const)(
    'rejects unsafe image download: %s',
    async (_name, imageUrl, fetcher, expectedCause) => {
      const runtime = await repository()
      await runtime.commitDiscoveryBatch({
        sourceId: 'xhs-security',
        contents: [
          {
            id: 'xiaohongshu:unsafe',
            title: 'Unsafe image post',
            body: '',
            canonicalUrl: 'https://www.xiaohongshu.com/explore/unsafe',
            kind: 'image_post',
            enrichmentStatus: 'pending',
            sourceText: '图文正文',
            images: [{ order: 0, url: imageUrl }],
          },
        ],
        discoveries: [
          {
            id: 'xhs-security:unsafe',
            sourceId: 'xhs-security',
            contentId: 'xiaohongshu:unsafe',
            discoveredAt: '2026-09-14T08:00:00.000Z',
          },
        ],
      })
      let caught: unknown
      try {
        await enrichImagePostContent({
          repository: runtime,
          contentId: 'xiaohongshu:unsafe',
          ...(fetcher ? { fetch: fetcher } : {}),
        })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).cause).toBeInstanceOf(Error)
      expect(((caught as Error).cause as Error).message).toContain(
        expectedCause
      )
      await runtime.close()
    }
  )

  it('isolates an image detail failure from a succeeding sibling', async () => {
    const runtime = await repository()
    await runtime.commitDiscoveryBatch({
      sourceId: 'xhs-isolation',
      contents: ['broken', 'good'].map((id) => ({
        id: `xiaohongshu:${id}`,
        title: `${id} image post`,
        body: '',
        canonicalUrl: `https://www.xiaohongshu.com/explore/${id}`,
        kind: 'image_post' as const,
        enrichmentStatus: 'pending' as const,
      })),
      discoveries: ['broken', 'good'].map((id) => ({
        id: `xhs-isolation:${id}`,
        sourceId: 'xhs-isolation',
        contentId: `xiaohongshu:${id}`,
        discoveredAt: '2026-09-14T08:00:00.000Z',
      })),
    })
    const result = await enrichImagePostsIndependently({
      repository: runtime,
      contentIds: ['xiaohongshu:broken', 'xiaohongshu:good'],
      detailProvider: {
        providerId: 'xhs-detail',
        async fetchDetail({ contentId }) {
          if (contentId.endsWith('broken')) throw new Error('missing image 2')
          return {
            sourceText: '完整正文',
            images: [{ order: 0, url: 'https://media.example/good.webp' }],
          }
        },
      },
      fetch: async () =>
        new Response(new Uint8Array([1]), {
          headers: { 'content-type': 'image/webp' },
        }),
    })
    expect(result).toEqual([
      {
        contentId: 'xiaohongshu:broken',
        status: 'failed',
        error: 'missing image 2',
      },
      { contentId: 'xiaohongshu:good', status: 'succeeded' },
    ])
    expect(runtime.getContent('xiaohongshu:broken')?.enrichmentStatus).toBe(
      'failed'
    )
    expect(runtime.getContent('xiaohongshu:good')?.enrichmentStatus).toBe(
      'succeeded'
    )
    await runtime.close()
  })

  it('relates equal work titles across platforms without merging records', async () => {
    const runtime = await repository()
    const title = '同一作品跨平台发布完整测试标题'
    for (const [type, id] of [
      ['douyin', 'video-1'],
      ['xiaohongshu', 'note-1'],
    ] as const) {
      await runPlatformDiscovery({
        repository: runtime,
        source: {
          id: `source-${type}`,
          slug: `source-${type}`,
          name: type,
          type,
          externalIdentity: `creator-${type}`,
          status: 'enabled',
        },
        limit: 1,
        runner: {
          async discover() {
            return {
              providerId: `provider-${type}`,
              items: [
                {
                  externalId: id,
                  platformIdentity: `${type}:${id}`,
                  description: '独立正文',
                  content: {
                    kind: type === 'douyin' ? 'video' : 'image_post',
                    canonicalUrl: `https://example.com/${type}/${id}`,
                    title,
                  },
                },
              ],
            }
          },
        },
      })
    }
    expect(runtime.listContents().map(({ id }) => id)).toEqual([
      'douyin:video-1',
      'xiaohongshu:note-1',
    ])
    expect(runtime.listRelatedContents()).toHaveLength(1)
    await runtime.close()
  })

  it('does not advance discovery progress when automatic relation persistence fails', async () => {
    const runtime = await repository()
    const title = '关联写入失败时必须重试当前发现页面'
    const discover = async (type: 'douyin' | 'xiaohongshu', id: string) =>
      runPlatformDiscovery({
        repository: runtime,
        source: {
          id: `relation-failure-${type}`,
          slug: `relation-failure-${type}`,
          name: type,
          type,
          externalIdentity: `creator-${type}`,
          status: 'enabled',
        },
        limit: 1,
        runner: {
          async discover() {
            return {
              providerId: `provider-${type}`,
              nextCursor: 'next-page',
              items: [
                {
                  externalId: id,
                  platformIdentity: `${type}:${id}`,
                  description: '独立正文',
                  content: {
                    kind: type === 'douyin' ? 'video' : 'image_post',
                    canonicalUrl: `https://example.com/${type}/${id}`,
                    title,
                  },
                },
              ],
            }
          },
        },
      })
    await discover('douyin', 'video-1')
    runtime.linkRelatedContents = async () => {
      throw new Error('simulated relation write failure')
    }
    await expect(discover('xiaohongshu', 'note-1')).rejects.toThrow(
      'simulated relation write failure'
    )
    expect(runtime.getProgress('relation-failure-xiaohongshu')).toBeUndefined()
    await runtime.close()
  })

  it('transcribes platform videos independently and preserves failed siblings', async () => {
    const runtime = await repository()
    await runtime.commitDiscoveryBatch({
      sourceId: 'media-source',
      contents: ['good', 'bad'].map((id) => ({
        id: `douyin:${id}`,
        title: id,
        body: '',
        canonicalUrl: `https://www.douyin.com/video/${id}`,
        kind: 'video',
        enrichmentStatus: 'waiting-manual-transcription' as const,
        video: {
          durationSeconds: 60,
          mediaUrl: `https://media.example/${id}.mp4`,
        },
      })),
      discoveries: ['good', 'bad'].map((id) => ({
        id: `media-source:${id}`,
        sourceId: 'media-source',
        contentId: `douyin:${id}`,
        discoveredAt: '2026-09-14T08:00:00.000Z',
      })),
    })
    const seenUrls: string[] = []
    const result = await enrichPlatformVideosIndependently({
      repository: runtime,
      contentIds: ['douyin:good', 'douyin:bad'],
      autoTranscribe: true,
      transcriber: {
        providerId: 'real-transcriber',
        async transcribe(input) {
          seenUrls.push(input.mediaUrl ?? '')
          return input.videoId === 'good' ? '真实完整转写' : ''
        },
      },
    })
    expect(result).toEqual([
      { contentId: 'douyin:good', status: 'succeeded' },
      {
        contentId: 'douyin:bad',
        status: 'failed',
        error: 'Automatic transcription returned empty text',
      },
    ])
    expect(seenUrls).toEqual([
      'https://media.example/good.mp4',
      'https://media.example/bad.mp4',
    ])
    expect(runtime.getContent('douyin:good')?.enrichmentStatus).toBe(
      'succeeded'
    )
    expect(runtime.getContent('douyin:bad')).toMatchObject({
      body: '',
      enrichmentStatus: 'waiting-manual-transcription',
    })

    await expect(
      enrichPlatformVideoContent({
        repository: runtime,
        contentId: 'douyin:bad',
        transcriber: {
          providerId: 'real-transcriber',
          async transcribe() {
            return 'should not run'
          },
        },
        maxDurationSeconds: 30,
      })
    ).resolves.toMatchObject({ status: 'waiting-manual-transcription' })
    await runtime.close()
  })

  it('requires complete keyframe recognition when the video policy requests it', async () => {
    const runtime = await repository()
    await runtime.commitDiscoveryBatch({
      sourceId: 'visual-video-source',
      contents: [
        {
          id: 'wechat_channels:visual-video',
          title: '画面承载关键信息的视频',
          body: '',
          canonicalUrl: 'https://weixin.qq.com/sph/visual-video',
          kind: 'video',
          enrichmentStatus: 'waiting-manual-transcription',
          video: {
            durationSeconds: 60,
            mediaUrl: 'https://media.example/visual.mp4',
          },
        },
      ],
      discoveries: [
        {
          id: 'visual-video-source:visual-video',
          sourceId: 'visual-video-source',
          contentId: 'wechat_channels:visual-video',
          discoveredAt: '2026-09-14T08:00:00.000Z',
        },
      ],
    })
    const transcriber = {
      providerId: 'transcriber',
      async transcribe() {
        return '完整语音转写'
      },
    }
    await expect(
      enrichPlatformVideoContent({
        repository: runtime,
        contentId: 'wechat_channels:visual-video',
        transcriber,
        manual: true,
        requireKeyframes: true,
      })
    ).rejects.toThrow('requires keyframe recognition')

    await enrichPlatformVideoContent({
      repository: runtime,
      contentId: 'wechat_channels:visual-video',
      transcriber,
      manual: true,
      requireKeyframes: true,
      keyframeRecognizer: {
        providerId: 'vision',
        async recognizeKeyframes() {
          return [
            { atSeconds: 10, recognizedText: '第二张关键画面' },
            { atSeconds: 2, recognizedText: '第一张关键画面' },
          ]
        },
      },
    })
    expect(runtime.getContent('wechat_channels:visual-video')).toMatchObject({
      enrichmentStatus: 'succeeded',
      body: expect.stringContaining('关键画面 2.0 秒'),
      media: {
        keyframeProviderId: 'vision',
        keyframes: [
          { atSeconds: 2, recognizedText: '第一张关键画面' },
          { atSeconds: 10, recognizedText: '第二张关键画面' },
        ],
      },
    })
    await runtime.close()
  })
})

const analysisArguments = {
  summary: '这是一篇完整且可执行的人工智能产品更新摘要。',
  topics: ['人工智能', '产品'],
  scores: {
    topicMatch: { level: 5, reason: '直接匹配关注方向' },
    substance: { level: 4, reason: '有具体事实' },
    credibility: { level: 4, reason: '来自官方来源' },
    novelty: { level: 4, reason: '包含新信息' },
    actionability: { level: 4, reason: '可以实际应用' },
    workValue: { level: 4, reason: '对工作有帮助' },
    clarity: { level: 4, reason: '表达清楚完整' },
  },
  spam: { isSpam: false },
}

describe('X short-post translation', () => {
  it('recognizes the original language without treating links as English prose', () => {
    expect(detectOriginalLanguage('今天发布了新功能 https://example.com')).toBe(
      'zh'
    )
    expect(detectOriginalLanguage('We shipped a useful new feature.')).toBe(
      'en'
    )
    expect(detectOriginalLanguage('https://example.com')).toBe('unknown')
  })

  it('stores a full Chinese paraphrase in the existing analysis call', async () => {
    const runtime = await repository()
    await runtime.importSources([
      {
        id: 'x-openai',
        slug: 'x-openai',
        name: 'X OpenAI',
        type: 'x',
        externalIdentity: 'OpenAI',
        status: 'enabled',
        language: 'en',
      },
    ])
    await runtime.commitDiscoveryBatch({
      sourceId: 'x-openai',
      contents: [
        {
          id: 'x:translation-test',
          sourceId: 'x-openai',
          title: 'A product update',
          body: 'We shipped a useful new feature for everyone today.',
          canonicalUrl: 'https://x.com/example/status/translation-test',
          enrichmentStatus: 'succeeded',
          kind: 'short_post',
        },
      ],
      discoveries: [],
    })
    const models = createModels()
    const faux = fauxProvider()
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('submit_analysis', {
          ...analysisArguments,
          chineseTitle: '产品更新',
          chineseTranslation: '我们今天向所有用户推出了一项实用的新功能。',
        })
      ),
    ])
    const analysis = await analyzeStoredContent(runtime, 'x:translation-test', {
      modelGateway: createPiModelGateway(models, faux.getModel()),
      profile: '关注产品更新',
      profileVersionId: 'profile-1',
      ruleVersion: 'rules-1',
      modelRouteVersion: 'route-1',
      manual: false,
    })
    expect(analysis.result).toMatchObject({
      chineseTitle: '产品更新',
      chineseTranslation: '我们今天向所有用户推出了一项实用的新功能。',
    })
    expect(analysis.promptVersion).toBe('english-full-translation-v2')
    expect(faux.state.callCount).toBe(1)
    await runtime.close()
  })

  it.each([
    ['article', 'rss'],
    ['video', 'youtube'],
  ] as const)(
    'requires a full translation for a non-junk English %s',
    async (kind, type) => {
      const runtime = await repository()
      await runtime.importSources([
        {
          id: `${type}-english`,
          slug: `${type}-english`,
          name: 'English source',
          type,
          externalIdentity: 'example',
          status: 'enabled',
          language: 'en',
        },
      ])
      await runtime.commitDiscoveryBatch({
        sourceId: `${type}-english`,
        contents: [
          {
            id: `${type}:translation-test`,
            sourceId: `${type}-english`,
            title: 'Product update',
            body: 'We shipped a useful feature for everyone today.',
            canonicalUrl: 'https://example.com/update',
            enrichmentStatus: 'succeeded',
            kind,
          },
        ],
        discoveries: [],
      })
      const models = createModels()
      const faux = fauxProvider()
      models.setProvider(faux.provider)
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall('submit_analysis', {
            ...analysisArguments,
            chineseTitle: '产品更新',
            chineseTranslation: '我们今天向所有人推出了一项实用功能。',
          })
        ),
      ])
      const analysis = await analyzeStoredContent(
        runtime,
        `${type}:translation-test`,
        {
          modelGateway: createPiModelGateway(models, faux.getModel()),
          profile: '关注产品更新',
          profileVersionId: 'profile-1',
          ruleVersion: 'rules-1',
          modelRouteVersion: 'route-1',
          manual: false,
        }
      )
      expect(analysis.result.chineseTitle).toBe('产品更新')
      expect(analysis.result.chineseTranslation).toBe(
        '我们今天向所有人推出了一项实用功能。'
      )
      expect(faux.state.callCount).toBe(1)
      await runtime.close()
    }
  )

  it('does not require a translation when analysis marks content as junk', async () => {
    const runtime = await repository()
    await runtime.importSources([
      {
        id: 'rss-english',
        slug: 'rss-english',
        name: 'English source',
        type: 'rss',
        externalIdentity: 'https://example.com/rss',
        status: 'enabled',
        language: 'en',
      },
    ])
    await runtime.commitDiscoveryBatch({
      sourceId: 'rss-english',
      contents: [
        {
          id: 'rss:junk-test',
          sourceId: 'rss-english',
          title: 'Sign up',
          body: 'Sign up now for this event.',
          canonicalUrl: 'https://example.com/signup',
          enrichmentStatus: 'succeeded',
          kind: 'article',
        },
      ],
      discoveries: [],
    })
    const models = createModels()
    const faux = fauxProvider()
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('submit_analysis', {
          ...analysisArguments,
          spam: { isSpam: true, reason: '活动广告' },
        })
      ),
    ])
    const analysis = await analyzeStoredContent(runtime, 'rss:junk-test', {
      modelGateway: createPiModelGateway(models, faux.getModel()),
      profile: '关注产品更新',
      profileVersionId: 'profile-1',
      ruleVersion: 'rules-1',
      modelRouteVersion: 'route-1',
      manual: false,
    })
    expect(analysis.result.chineseTranslation).toBeUndefined()
    expect(faux.state.callCount).toBe(1)
    await runtime.close()
  })

  it('still translates content manually cleared as non-junk', async () => {
    const runtime = await repository()
    await runtime.importSources([
      {
        id: 'rss-english',
        slug: 'rss-english',
        name: 'English source',
        type: 'rss',
        externalIdentity: 'https://example.com/rss',
        status: 'enabled',
        language: 'en',
      },
    ])
    await runtime.commitDiscoveryBatch({
      sourceId: 'rss-english',
      contents: [
        {
          id: 'rss:manual-not-junk',
          sourceId: 'rss-english',
          title: 'Product update',
          body: 'We released an important update for all users.',
          canonicalUrl: 'https://example.com/update',
          enrichmentStatus: 'succeeded',
          kind: 'article',
        },
      ],
      discoveries: [],
    })
    await runtime.setManualJunk('rss:manual-not-junk', { isJunk: false })
    const models = createModels()
    const faux = fauxProvider()
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('submit_analysis', {
          ...analysisArguments,
          spam: { isSpam: true, reason: '模型误判' },
          chineseTitle: '产品更新',
          chineseTranslation: '我们向所有用户发布了一项重要更新。',
        })
      ),
    ])
    const analysis = await analyzeStoredContent(
      runtime,
      'rss:manual-not-junk',
      {
        modelGateway: createPiModelGateway(models, faux.getModel()),
        profile: '关注产品更新',
        profileVersionId: 'profile-1',
        ruleVersion: 'rules-1',
        modelRouteVersion: 'route-1',
        manual: false,
      }
    )
    expect(analysis.result.chineseTranslation).toBe(
      '我们向所有用户发布了一项重要更新。'
    )
    expect(analysis.promptVersion).toBe(
      'english-full-translation-v2-manual-not-junk'
    )
    await runtime.close()
  })
})

function fauxGateway() {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('submit_analysis', analysisArguments)),
    fauxAssistantMessage(fauxToolCall('submit_analysis', analysisArguments)),
  ])
  return { gateway: createPiModelGateway(models, faux.getModel()), faux }
}

describe('RSS discovery and enrichment', () => {
  it('normalizes tracking variants to one article identity', () => {
    expect(
      canonicalizeArticleUrl(
        'HTTPS://OpenAI.com/news/example/?utm_source=rss&gclid=x#section'
      )
    ).toBe('https://openai.com/news/example')
  })

  it('discovers only unseen RSS entries and keeps stable identities', async () => {
    const feed = `<?xml version="1.0"?><rss><channel>
      <item><guid>item-2</guid><title>Second</title><link>https://example.com/second?utm_source=rss</link><pubDate>Mon, 14 Sep 2026 06:00:00 GMT</pubDate></item>
      <item><guid>item-1</guid><title>First</title><link>https://example.com/first</link><pubDate>Sun, 13 Sep 2026 06:00:00 GMT</pubDate></item>
    </channel></rss>`
    const adapter = new RssAdapter(async () => new Response(feed))
    const batch = await adapter.discover({
      feedUrl: 'https://example.com/rss.xml',
      cursor: 'item-1',
      limit: 20,
    })
    expect(batch.items).toEqual([
      expect.objectContaining({
        externalId: 'item-2',
        canonicalUrl: 'https://example.com/second',
      }),
    ])
    expect(batch.nextCursor).toBe('item-2')
  })

  it('continues an oversized backlog across runs without skipping entries', async () => {
    const feed = `<?xml version="1.0"?><rss><channel>
      ${[4, 3, 2, 1]
        .map(
          (number) =>
            `<item><guid>item-${number}</guid><title>Item ${number}</title><link>https://example.com/${number}</link></item>`
        )
        .join('')}
    </channel></rss>`
    const adapter = new RssAdapter(async () => new Response(feed))
    const seen = new Set<string>()
    const first = await adapter.discover({
      feedUrl: 'https://example.com/rss.xml',
      cursor: 'has-progress',
      limit: 2,
      isSeen: (id) => seen.has(id),
    })
    first.items.forEach((item) => seen.add(item.externalId))
    const second = await adapter.discover({
      feedUrl: 'https://example.com/rss.xml',
      cursor: first.nextCursor,
      limit: 2,
      isSeen: (id) => seen.has(id),
    })
    expect(first.items.map((item) => item.externalId)).toEqual([
      'item-1',
      'item-2',
    ])
    expect(second.items.map((item) => item.externalId)).toEqual([
      'item-3',
      'item-4',
    ])
    expect(second.nextCursor).toBe('item-4')
  })

  it('finds unseen entries after a cursor in an oldest-to-newest feed', async () => {
    const feed = `<rss><channel>
      <item><guid>old</guid><title>Old</title><link>https://example.com/old</link></item>
      <item><guid>new</guid><title>New</title><link>https://example.com/new</link></item>
    </channel></rss>`
    const adapter = new RssAdapter(async () => new Response(feed))
    const batch = await adapter.discover({
      feedUrl: 'https://example.com/rss.xml',
      cursor: 'old',
      limit: 20,
      isSeen: (id) => id === 'old',
    })
    expect(batch.items.map((item) => item.externalId)).toEqual(['new'])
  })

  it('prefers an Atom alternate article link over a self link', async () => {
    const feed = `<feed><entry><id>atom-1</id><title>Atom</title>
      <link rel="self" href="https://example.com/feed-entry" />
      <link rel="alternate" href="https://example.com/article" />
    </entry></feed>`
    const adapter = new RssAdapter(async () => new Response(feed))
    const batch = await adapter.discover({
      feedUrl: 'https://example.com/feed',
      limit: 1,
      incremental: true,
    })
    expect(batch.items[0]?.canonicalUrl).toBe('https://example.com/article')
  })

  it('limits first discovery to the newest 20 items from the last 7 days', async () => {
    const entries = Array.from({ length: 25 }, (_, index) => {
      const publishedAt =
        index === 24
          ? '2026-09-01T00:00:00.000Z'
          : new Date(
              Date.parse('2026-09-14T12:00:00.000Z') - index * 60_000
            ).toISOString()
      return `<item><guid>item-${index}</guid><title>Item ${index}</title><link>https://example.com/${index}</link><pubDate>${publishedAt}</pubDate></item>`
    }).join('')
    const adapter = new RssAdapter(
      async () => new Response(`<rss><channel>${entries}</channel></rss>`)
    )
    const batch = await adapter.discover({
      feedUrl: 'https://example.com/rss.xml',
      limit: 100,
      now: new Date('2026-09-14T12:00:00Z'),
    })
    expect(batch.items).toHaveLength(20)
    expect(batch.items[0]?.externalId).toBe('item-0')
    expect(batch.items.at(-1)?.externalId).toBe('item-19')
  })

  it('keeps RSS discovery separate from per-item enrichment and analysis', async () => {
    const runtime = await repository()
    const feed = `<rss><channel><item><guid>one</guid><title>One</title><link>https://example.com/one</link><pubDate>Mon, 14 Sep 2026 06:00:00 GMT</pubDate></item></channel></rss>`
    await runRssDiscovery({
      repository: runtime,
      source: { id: 'rss-one', feedUrl: 'https://example.com/rss.xml' },
      limit: 20,
      now: new Date('2026-09-14T12:00:00Z'),
      fetcher: async () =>
        new Response(feed, { headers: { 'content-type': 'application/xml' } }),
    })
    expect(runtime.listContents()).toMatchObject([
      { enrichmentStatus: 'pending', body: '' },
    ])
    expect(runtime.listTasks()).toMatchObject([
      { type: 'enrich', status: 'pending' },
    ])
    expect(runtime.listAnalyses()).toHaveLength(0)
    await runtime.close()
  })

  it('rejects an article whose extracted body is incomplete', async () => {
    await expect(
      enrichArticle(
        'https://example.com/thin',
        async () =>
          new Response('<html><body><p>too short</p></body></html>', {
            headers: { 'content-type': 'text/html' },
          })
      )
    ).rejects.toThrow(/complete article body/i)
  })

  it('fetches a browser-readable article before passing it to Readability', async () => {
    const paragraph =
      'A complete article paragraph with enough useful words to pass readability extraction. '.repeat(
        5
      )
    const fetcher = async (_url: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const userAgent = headers.get('user-agent') ?? ''
      if (
        !userAgent.includes('Mozilla/5.0') ||
        !userAgent.includes('Chrome/')
      ) {
        return new Response('Forbidden', { status: 403 })
      }
      return new Response(
        `<html><head><title>Readable article</title></head><body><article><p>${paragraph}</p></article></body></html>`,
        {
          headers: { 'content-type': 'text/html' },
        }
      )
    }

    await expect(
      enrichArticle('https://example.com/story', fetcher)
    ).resolves.toMatchObject({
      title: 'Readable article',
      body: expect.stringContaining('complete article paragraph'),
    })
  })

  it('keeps every inline article image in reading order', async () => {
    const paragraph =
      'A complete article paragraph with enough useful words to pass readability extraction. '.repeat(
        5
      )
    const result = await enrichArticle(
      'https://example.com/story',
      async () =>
        new Response(
          `<html><head><title>Story</title></head><body><article><h1>Story</h1><p>${paragraph}</p><img src="/first.jpg"><p>${paragraph}</p><img src="https://cdn.example.com/second.png"></article></body></html>`,
          {
            headers: { 'content-type': 'text/html' },
          }
        )
    )
    expect(result.images).toEqual([
      { order: 0, url: 'https://example.com/first.jpg' },
      { order: 1, url: 'https://cdn.example.com/second.png' },
    ])
  })

  it('rejects private article targets before making a request', async () => {
    await expect(enrichArticle('http://127.0.0.1/private')).rejects.toThrow(
      /safe public HTTP URL/i
    )
  })
})

describe('analysis and end-to-end orchestration', () => {
  it('adapts Codex OAuth in memory without rewriting its auth file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'qiushuiai-airadar-auth-'))
    roots.push(root)
    const authPath = path.join(root, 'auth.json')
    const payload = Buffer.from(
      JSON.stringify({ exp: 2_000_000_000 })
    ).toString('base64url')
    const original = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: `header.${payload}.signature`,
        refresh_token: 'refresh-test-only',
        account_id: 'account-test',
      },
    })
    await writeFile(authPath, original)
    const store = createReadOnlyCodexCredentialStore(authPath)
    expect(await store.list()).toEqual([
      { providerId: 'openai-codex', type: 'oauth' },
    ])
    expect((await store.read('openai-codex'))?.type).toBe('oauth')
    await store.modify('openai-codex', async (credential) => credential)
    expect(await readFile(authPath, 'utf8')).toBe(original)
  })

  it('calculates the score and two-level feed in TypeScript', () => {
    expect(calculateRecommendation(analysisArguments)).toEqual({
      totalScore: 80,
      recommendation: 'core',
    })
    expect(
      calculateRecommendation({
        ...analysisArguments,
        spam: { isSpam: true, reason: '广告营销' },
      }).recommendation
    ).toBe('none')
    expect(
      calculateRecommendation({
        ...analysisArguments,
        spam: { isSpam: false, reason: null },
      }).recommendation
    ).toBe('core')
    expect(
      calculateRecommendation(analysisArguments, {
        weights: {
          topicMatch: 10,
          substance: 10,
          credibility: 10,
          novelty: 10,
          actionability: 10,
          workValue: 10,
          clarity: 40,
        },
        coreThreshold: 90,
        exploreThreshold: 85,
      }).recommendation
    ).toBe('none')
  })

  it('uses Pi structured output, reuses a fingerprint, and versions manual reanalysis', async () => {
    const runtime = await repository()
    const { gateway, faux } = fauxGateway()
    const feed = `<?xml version="1.0"?><rss><channel><item>
      <guid>real-1</guid><title>Real article</title><link>https://example.com/article</link><pubDate>Mon, 14 Sep 2026 06:00:00 GMT</pubDate>
    </item></channel></rss>`
    const body = `<html><head><title>Real article</title></head><body><article><h1>Real article</h1><p>${'Substantial source material. '.repeat(30)}</p></article></body></html>`
    const fetcher = async (input: string | URL | Request) =>
      new Response(String(input).includes('rss.xml') ? feed : body, {
        headers: { 'content-type': 'text/html' },
      })
    const options = {
      repository: runtime,
      source: {
        id: 'rss-source',
        feedUrl: 'https://example.com/rss.xml',
      },
      fetcher,
      modelGateway: gateway,
      profile: '长期从事技术、产品和销售，关注人工智能实际应用。',
      profileVersionId: 'profile-1',
      ruleVersion: 'rules-1',
      modelRouteVersion: 'route-1',
      limit: 20,
      now: new Date('2026-09-14T12:00:00Z'),
    }
    const first = await runRssPipeline(options)
    expect(first.succeeded).toBe(1)
    expect(first.failed).toBe(0)
    expect(faux.state.callCount).toBe(1)
    expect(runtime.listAnalyses()).toHaveLength(1)
    expect(runtime.indexedContentCount()).toBe(1)

    const content = runtime.listContents()[0]!
    const repeatOptions = {
      modelGateway: gateway,
      profile: options.profile,
      profileVersionId: options.profileVersionId,
      ruleVersion: options.ruleVersion,
      modelRouteVersion: options.modelRouteVersion,
      manual: false,
    }
    const repeated = await Promise.all([
      analyzeStoredContent(runtime, content.id, repeatOptions),
      analyzeStoredContent(runtime, content.id, repeatOptions),
    ])
    expect(repeated[0].id).toBe(repeated[1].id)
    expect(faux.state.callCount).toBe(1)
    const manual = await runRssPipeline({
      ...options,
      cursor: undefined,
      manualReanalysisContentId: content.id,
    })
    expect(manual.succeeded).toBe(1)
    expect(faux.state.callCount).toBe(2)
    expect(
      runtime.listAnalyses(content.id).map((result) => result.version)
    ).toEqual([2, 1])
    await runtime.close()
  })

  it('does not analyze or publish an incompletely enriched article', async () => {
    const runtime = await repository()
    const { gateway, faux } = fauxGateway()
    const feed = `<?xml version="1.0"?><rss><channel><item><guid>thin-1</guid><title>Thin</title><link>https://example.com/thin</link><pubDate>2026-09-14T00:00:00Z</pubDate></item></channel></rss>`
    const fetcher = async (input: string | URL | Request) =>
      new Response(
        String(input).includes('rss.xml')
          ? feed
          : '<html><body><p>thin</p></body></html>',
        { headers: { 'content-type': 'text/html' } }
      )
    const result = await runRssPipeline({
      repository: runtime,
      source: { id: 'rss-source', feedUrl: 'https://example.com/rss.xml' },
      fetcher,
      modelGateway: gateway,
      profile: '关注人工智能',
      profileVersionId: 'profile-1',
      ruleVersion: 'rules-1',
      modelRouteVersion: 'route-1',
      limit: 20,
      now: new Date('2026-09-14T12:00:00Z'),
    })
    expect(result.failed).toBe(1)
    expect(faux.state.callCount).toBe(0)
    expect(runtime.listAnalyses()).toEqual([])
    await runtime.close()
  })

  it('does not advance progress past a transient failure and retries next run', async () => {
    const runtime = await repository()
    const { gateway, faux } = fauxGateway()
    const feed = `<?xml version="1.0"?><rss><channel><item><guid>retry-1</guid><title>Retry</title><link>https://example.com/retry</link><pubDate>2026-09-10T00:00:00Z</pubDate></item></channel></rss>`
    let articleAttempts = 0
    const options = {
      repository: runtime,
      source: { id: 'rss-retry', feedUrl: 'https://example.com/rss.xml' },
      fetcher: async (input: string | URL | Request) => {
        if (String(input).includes('rss.xml')) return new Response(feed)
        articleAttempts += 1
        return new Response(
          articleAttempts === 1
            ? '<html><body>thin</body></html>'
            : `<html><body><article><p>${'Complete retry body. '.repeat(30)}</p></article></body></html>`,
          { headers: { 'content-type': 'text/html' } }
        )
      },
      modelGateway: gateway,
      profile: '关注人工智能',
      profileVersionId: 'profile-1',
      ruleVersion: 'rules-1',
      modelRouteVersion: 'route-1',
      limit: 1,
    }
    expect(
      (
        await runRssPipeline({
          ...options,
          now: new Date('2026-09-14T00:00:00Z'),
        })
      ).failed
    ).toBe(1)
    expect(runtime.getProgress('rss-retry')).toMatchObject({
      baselineExternalIds: ['retry-1'],
    })
    expect(runtime.getProgress('rss-retry')?.cursor).toBeUndefined()
    expect(
      (
        await runRssPipeline({
          ...options,
          now: new Date('2026-09-30T00:00:00Z'),
        })
      ).succeeded
    ).toBe(1)
    expect(runtime.getProgress('rss-retry')?.cursor).toBe('retry-1')
    expect(faux.state.callCount).toBe(1)
    await runtime.close()
  })

  it('persists the first-feed baseline and never backfills omitted history', async () => {
    const runtime = await repository()
    const { gateway, faux } = fauxGateway()
    const feed = `<rss><channel>
      <item><guid>newest</guid><title>Newest</title><link>https://example.com/newest</link><pubDate>2026-09-14T10:00:00Z</pubDate></item>
      <item><guid>recent-omitted</guid><title>Recent omitted</title><link>https://example.com/recent-omitted</link><pubDate>2026-09-13T10:00:00Z</pubDate></item>
      <item><guid>old</guid><title>Old</title><link>https://example.com/old</link><pubDate>2026-08-01T10:00:00Z</pubDate></item>
    </channel></rss>`
    const body = `<html><body><article><p>${'Complete current body. '.repeat(30)}</p></article></body></html>`
    const options = {
      repository: runtime,
      source: { id: 'rss-baseline', feedUrl: 'https://example.com/rss.xml' },
      fetcher: async (input: string | URL | Request) =>
        new Response(String(input).includes('rss.xml') ? feed : body, {
          headers: { 'content-type': 'text/html' },
        }),
      modelGateway: gateway,
      profile: '关注人工智能',
      profileVersionId: 'profile-1',
      ruleVersion: 'rules-1',
      modelRouteVersion: 'route-1',
      limit: 1,
      now: new Date('2026-09-14T12:00:00Z'),
      initialLookbackDays: 60,
    }
    expect((await runRssPipeline(options)).discovered).toBe(1)
    expect((await runRssPipeline(options)).discovered).toBe(0)
    expect(runtime.indexedContentCount()).toBe(1)
    expect(runtime.getProgress('rss-baseline')?.baselineExternalIds).toEqual([
      'newest',
      'recent-omitted',
      'old',
    ])
    expect(faux.state.callCount).toBe(1)
    await runtime.close()
  })

  it('freezes the first baseline before processing and retries only failed selections', async () => {
    const runtime = await repository()
    const { gateway, faux } = fauxGateway()
    const feed = `<rss><channel>
      <item><guid>selected-a</guid><title>A</title><link>https://example.com/a</link><pubDate>2026-09-14T10:00:00Z</pubDate></item>
      <item><guid>selected-b</guid><title>B</title><link>https://example.com/b</link><pubDate>2026-09-14T09:00:00Z</pubDate></item>
      <item><guid>historical-c</guid><title>C</title><link>https://example.com/c</link><pubDate>2026-08-01T00:00:00Z</pubDate></item>
    </channel></rss>`
    let aAttempts = 0
    const options = {
      repository: runtime,
      source: { id: 'rss-partial', feedUrl: 'https://example.com/rss.xml' },
      fetcher: async (input: string | URL | Request) => {
        const value = String(input)
        if (value.includes('rss.xml')) return new Response(feed)
        if (value.endsWith('/a')) aAttempts += 1
        const thin = value.endsWith('/a') && aAttempts === 1
        return new Response(
          thin
            ? '<html><body>thin</body></html>'
            : `<html><body><article><p>${'Complete selected body. '.repeat(30)}</p></article></body></html>`,
          { headers: { 'content-type': 'text/html' } }
        )
      },
      modelGateway: gateway,
      profile: '关注人工智能',
      profileVersionId: 'profile-1',
      ruleVersion: 'rules-1',
      modelRouteVersion: 'route-1',
      limit: 2,
      now: new Date('2026-09-14T12:00:00Z'),
    }
    const first = await runRssPipeline(options)
    expect(first).toMatchObject({ discovered: 2, succeeded: 1, failed: 1 })
    expect(runtime.getProgress('rss-partial')?.baselineExternalIds).toEqual([
      'selected-a',
      'selected-b',
      'historical-c',
    ])
    const second = await runRssPipeline({
      ...options,
      now: new Date('2026-09-30T12:00:00Z'),
    })
    expect(second).toMatchObject({ discovered: 1, succeeded: 1, failed: 0 })
    expect(runtime.indexedContentCount()).toBe(2)
    expect(faux.state.callCount).toBe(2)
    await runtime.close()
  })

  it('merges feed links that redirect to the same final article identity', async () => {
    const runtime = await repository()
    const { gateway, faux } = fauxGateway()
    const feed = `<?xml version="1.0"?><rss><channel>
      <item><guid>redirect-2</guid><title>Second alias</title><link>https://example.com/go-2</link><pubDate>2026-09-14T01:00:00Z</pubDate></item>
      <item><guid>redirect-1</guid><title>First alias</title><link>https://example.com/go-1</link><pubDate>2026-09-14T00:00:00Z</pubDate></item>
    </channel></rss>`
    const body = `<html><body><article><p>${'Canonical article body. '.repeat(30)}</p></article></body></html>`
    await runRssPipeline({
      repository: runtime,
      source: { id: 'rss-redirect', feedUrl: 'https://example.com/rss.xml' },
      fetcher: async (input) => {
        if (String(input).includes('rss.xml')) return new Response(feed)
        const response = new Response(body, {
          headers: { 'content-type': 'text/html' },
        })
        Object.defineProperty(response, 'url', {
          value: 'https://example.com/final',
        })
        return response
      },
      modelGateway: gateway,
      profile: '关注人工智能',
      profileVersionId: 'profile-1',
      ruleVersion: 'rules-1',
      modelRouteVersion: 'route-1',
      limit: 2,
      now: new Date('2026-09-14T12:00:00Z'),
    })
    expect(faux.state.callCount).toBe(1)
    expect(runtime.listAnalyses()).toHaveLength(1)
    expect(runtime.indexedContentCount()).toBe(1)
    const discoveries = runtime.listDiscoveries('rss-redirect')
    expect(discoveries).toHaveLength(2)
    expect(new Set(discoveries.map((entry) => entry.contentId)).size).toBe(1)
    expect(discoveries[0]?.contentId).toBe(runtime.listContents()[0]?.id)
    expect(
      runtime
        .listContents()
        .filter((content) => runtime.listAnalyses(content.id).length)
    ).toEqual([
      expect.objectContaining({ canonicalUrl: 'https://example.com/final' }),
    ])
    await runtime.close()
  })

  it('keeps model usage and error evidence when structured output is invalid', async () => {
    const runtime = await repository()
    const models = createModels()
    const faux = fauxProvider()
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('submit_analysis', {
          ...analysisArguments,
          summary: 'too short',
        })
      ),
    ])
    const feed = `<?xml version="1.0"?><rss><channel><item><guid>invalid-1</guid><title>Invalid analysis</title><link>https://example.com/invalid</link><pubDate>2026-09-14T00:00:00Z</pubDate></item></channel></rss>`
    const body = `<html><body><article><h1>Invalid</h1><p>${'Complete body. '.repeat(30)}</p></article></body></html>`
    const result = await runRssPipeline({
      repository: runtime,
      source: { id: 'rss-source', feedUrl: 'https://example.com/rss.xml' },
      fetcher: async (input) =>
        new Response(String(input).includes('rss.xml') ? feed : body, {
          headers: { 'content-type': 'text/html' },
        }),
      modelGateway: createPiModelGateway(models, faux.getModel()),
      profile: '关注人工智能',
      profileVersionId: 'profile-1',
      ruleVersion: 'rules-1',
      modelRouteVersion: 'route-1',
      limit: 1,
      now: new Date('2026-09-14T12:00:00Z'),
    })
    expect(result.failed).toBe(1)
    expect(runtime.listAnalyses()).toEqual([])
    expect(runtime.listAnalysisCalls()).toEqual([
      expect.objectContaining({
        provider: faux.getModel().provider,
        model: faux.getModel().id,
        status: 'failed',
        usage: expect.objectContaining({ inputTokens: expect.any(Number) }),
        error: expect.stringMatching(/too small|too short|20/i),
      }),
    ])
    const rawFiles = await readdir(path.join(runtime.root, '.raw-responses'))
    const rawRecords = await Promise.all(
      rawFiles.map(async (file) =>
        JSON.parse(
          await readFile(
            path.join(runtime.root, '.raw-responses', file),
            'utf8'
          )
        )
      )
    )
    expect(rawRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: faux.getModel().provider,
          payload: expect.objectContaining({
            request: expect.objectContaining({
              context: expect.objectContaining({
                systemPrompt: expect.any(String),
                messages: expect.any(Array),
                tools: expect.any(Array),
              }),
              options: expect.objectContaining({ maxTokens: 2_500 }),
            }),
            response: expect.any(Object),
          }),
        }),
      ])
    )
    await runtime.close()
  })
})
