import { describe, expect, it } from 'vitest'

import type { Source } from '@qiushui-airadar/domain'

import {
  createTikHubDouyinProvider,
  fetchTikHubWechatChannelsMedia,
  createTikHubWechatChannelsProvider,
  createTikHubXiaohongshuDetailProvider,
  createTikHubXiaohongshuProvider,
} from './chinese-platforms.js'
import { providerCursor, type ProviderDiscoveryError } from './index.js'

function source(type: Source['type'], identity: string): Source {
  return {
    id: `source-${type}`,
    slug: `source-${type}`,
    name: type,
    type,
    externalIdentity: identity,
    status: 'enabled',
  }
}

describe('Chinese platform source adapters', () => {
  it('maps a redacted Douyin list response with cursor and nullable metrics', async () => {
    const provider = createTikHubDouyinProvider({
      token: 'runtime-only',
      fetch: async () =>
        Response.json({
          code: 200,
          data: {
            has_more: 1,
            max_cursor: 'next-douyin',
            aweme_list: [
              {
                aweme_id: '7539910466732576057',
                desc: '真实视频说明',
                create_time: 1755522210,
                duration: 565013,
                share_url:
                  'https://www.iesdouyin.com/share/video/7539910466732576057/',
                statistics: {
                  play_count: 0,
                  digg_count: 48785,
                  comment_count: 539,
                  share_count: 9999,
                  collect_count: 51094,
                },
                video: {
                  duration: 565013,
                  play_addr: { url_list: ['https://media.example/douyin.mp4'] },
                },
              },
            ],
          },
        }),
    })
    const batch = await provider.discover({
      source: source('douyin', 'sec-user'),
      limit: 10,
    })
    expect(batch.items[0]).toMatchObject({
      externalId: '7539910466732576057',
      platformIdentity: 'douyin:7539910466732576057',
      description: '真实视频说明',
      content: { kind: 'video' },
      video: {
        durationSeconds: 565.013,
        mediaUrl: 'https://media.example/douyin.mp4',
      },
      interaction: {
        views: 0,
        likes: 48785,
        comments: 539,
        shares: 9999,
        saves: 51094,
      },
    })
    expect(providerCursor(batch.nextCursor, 'tikhub-douyin')).toBe(
      'next-douyin'
    )
  })

  it('keeps WeChat 64-bit ids as strings and rejects debug-only success', async () => {
    const good = createTikHubWechatChannelsProvider({
      token: 'runtime-only',
      fetch: async () =>
        Response.json({
          code: 200,
          data: {
            up_continue: 1,
            last_buffer: 'next-wechat',
            videos: [
              {
                id: '15007502632278694530',
                title: '视频号真实样本',
                description: '视频说明，不等于字幕',
                create_time: 1789033726,
                read_count: 100,
                like_count: 26,
                comment_count: 2,
                forward_count: 411,
                media: {
                  duration: 123,
                  full_url: 'https://media.example/wechat.mp4',
                },
              },
            ],
          },
        }),
    })
    const batch = await good.discover({
      source: source('wechat_channels', 'finder-user'),
      limit: 10,
    })
    expect(batch.items[0]).toMatchObject({
      externalId: '15007502632278694530',
      platformIdentity: 'wechat_channels:15007502632278694530',
      evidence: { transcriptStatus: 'missing' },
      video: {
        durationSeconds: 123,
        mediaUrl: 'https://media.example/wechat.mp4',
        providerReference: 'finder-user',
      },
      interaction: { views: 100, likes: 26, comments: 2, shares: 411 },
    })

    const broken = createTikHubWechatChannelsProvider({
      token: 'runtime-only',
      fetch: async () =>
        Response.json({ code: 200, data: { debug_info: 'temporary' } }),
    })
    await expect(
      broken.discover({
        source: source('wechat_channels', 'finder-user'),
        limit: 10,
      })
    ).rejects.toMatchObject<Partial<ProviderDiscoveryError>>({
      errorClass: 'temporary',
    })

    await expect(
      fetchTikHubWechatChannelsMedia({
        token: 'runtime-only',
        username: 'finder-user',
        videoId: '15007502632278694530',
        fetch: async () =>
          Response.json({
            code: 200,
            data: {
              videos: [
                {
                  id: '15007502632278694530',
                  media: {
                    full_url: 'https://media.example/encrypted.bin',
                    decode_key: 123456789,
                  },
                },
              ],
            },
          }),
      })
    ).resolves.toEqual({
      mediaUrl: 'https://media.example/encrypted.bin',
      decodeKey: '123456789',
    })
  })

  it('maps Xiaohongshu image and video notes without merging platform ids', async () => {
    const provider = createTikHubXiaohongshuProvider({
      token: 'runtime-only',
      fetch: async () =>
        Response.json({
          code: 200,
          data: {
            code: 0,
            success: true,
            data: {
              has_more: true,
              notes: [
                {
                  id: 'image-note-1',
                  cursor: 'cursor-1',
                  type: 'normal',
                  title: '图文真实样本',
                  desc: '完整正文',
                  create_time: 1779677336,
                  liked_count: 20,
                  collected_count: 9,
                  comments_count: 2,
                  shared_count: 3,
                  images_list: [
                    { original: 'https://media.example/1.webp' },
                    { original: 'https://media.example/2.webp' },
                  ],
                },
                {
                  id: 'video-note-1',
                  cursor: 'cursor-2',
                  type: 'video',
                  title: '视频真实样本',
                  desc: '视频说明',
                  images_list: [{ url: 'https://media.example/cover.webp' }],
                  video_info_v2: {
                    duration: 60,
                    media: { stream: 'https://media.example/xhs.mp4' },
                  },
                },
              ],
            },
          },
        }),
    })
    const batch = await provider.discover({
      source: source('xiaohongshu', 'user-1'),
      limit: 10,
    })
    expect(batch.items).toHaveLength(2)
    expect(batch.items[0]).toMatchObject({
      platformIdentity: 'xiaohongshu:image-note-1',
      content: { kind: 'image_post' },
      images: [
        { order: 0, url: 'https://media.example/1.webp' },
        { order: 1, url: 'https://media.example/2.webp' },
      ],
      interaction: { views: null, likes: 20, saves: 9 },
    })
    expect(batch.items[1]).toMatchObject({
      platformIdentity: 'xiaohongshu:video-note-1',
      content: { kind: 'video' },
    })
    expect(batch.items[0]?.platformIdentity).not.toBe(
      batch.items[1]?.platformIdentity
    )
    expect(
      JSON.parse(providerCursor(batch.nextCursor, 'tikhub-xiaohongshu') ?? '{}')
    ).toEqual({ anchor: 'cursor-2', seenIds: [] })
  })

  it('rejects a detail response when any ordered image is missing', async () => {
    const provider = createTikHubXiaohongshuDetailProvider({
      token: 'runtime-only',
      fetch: async () =>
        Response.json({
          code: 200,
          data: {
            code: 0,
            success: true,
            data: [
              {
                note_list: [
                  {
                    id: 'broken-image',
                    desc: '完整正文',
                    images_list: [
                      { original: 'https://media.example/first.webp' },
                      {},
                    ],
                  },
                ],
              },
            ],
          },
        }),
    })
    await expect(
      provider.fetchDetail({
        contentId: 'xiaohongshu:broken-image',
        canonicalUrl: 'https://www.xiaohongshu.com/explore/broken-image',
      })
    ).rejects.toMatchObject<Partial<ProviderDiscoveryError>>({
      errorClass: 'invalid-response',
    })
  })

  it('keeps discovery shallow and fetches full image detail independently', async () => {
    const requestedUrls: string[] = []
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input)
      requestedUrls.push(url)
      if (url.includes('get_image_note_detail')) {
        return Response.json({
          code: 200,
          data: {
            code: 0,
            success: true,
            data: [
              {
                note_list: [
                  {
                    id: 'image-note-1',
                    type: 'normal',
                    title: '详情标题',
                    desc: '详情接口返回的完整正文',
                    images_list: [
                      { original: 'https://media.example/detail-1.webp' },
                      { original: 'https://media.example/detail-2.webp' },
                    ],
                  },
                ],
              },
            ],
          },
        })
      }
      return Response.json({
        code: 200,
        data: {
          code: 0,
          success: true,
          data: {
            notes: [
              {
                id: 'image-note-1',
                type: 'normal',
                title: '列表标题',
                desc: '列表摘要',
                images_list: [
                  { original: 'https://media.example/summary.webp' },
                ],
              },
            ],
          },
        },
      })
    }
    const provider = createTikHubXiaohongshuProvider({
      token: 'runtime-only',
      fetch: fetcher,
    })
    const batch = await provider.discover({
      source: source('xiaohongshu', 'user-1'),
      limit: 1,
    })
    expect(batch.items[0]).toMatchObject({
      description: '列表摘要',
      content: { title: '列表标题' },
      images: [{ order: 0, url: 'https://media.example/summary.webp' }],
    })
    expect(requestedUrls).toHaveLength(1)

    const detail = await createTikHubXiaohongshuDetailProvider({
      token: 'runtime-only',
      fetch: fetcher,
    }).fetchDetail({
      contentId: 'xiaohongshu:image-note-1',
      canonicalUrl: 'https://www.xiaohongshu.com/explore/image-note-1',
    })
    expect(detail).toEqual({
      sourceText: '详情接口返回的完整正文',
      images: [
        { order: 0, url: 'https://media.example/detail-1.webp' },
        { order: 1, url: 'https://media.example/detail-2.webp' },
      ],
    })
    expect(requestedUrls).toHaveLength(2)
  })

  it('does not skip WeChat items when the caller limit splits a provider page', async () => {
    let requestCount = 0
    const provider = createTikHubWechatChannelsProvider({
      token: 'runtime-only',
      fetch: async () => {
        requestCount += 1
        const ids =
          requestCount === 1
            ? ['one', 'two', 'three']
            : ['new', 'one', 'two', 'three']
        return Response.json({
          code: 200,
          data: {
            up_continue: 1,
            last_buffer: 'next-provider-page',
            videos: ids.map((id) => ({
              id,
              title: id,
              media: { duration: 60 },
            })),
          },
        })
      },
    })
    const first = await provider.discover({
      source: source('wechat_channels', 'finder-user'),
      limit: 2,
    })
    const second = await provider.discover({
      source: source('wechat_channels', 'finder-user'),
      cursor: first.nextCursor,
      limit: 2,
    })
    expect(first.items.map(({ externalId }) => externalId)).toEqual([
      'one',
      'two',
    ])
    expect(second.items.map(({ externalId }) => externalId)).toEqual([
      'new',
      'three',
    ])
    expect(
      JSON.parse(
        providerCursor(second.nextCursor, 'tikhub-wechat-channels') ?? '{}'
      )
    ).toEqual({ anchor: 'next-provider-page', seenIds: [] })
  })

  it('keeps long WeChat duration in explicit seconds', async () => {
    const provider = createTikHubWechatChannelsProvider({
      token: 'runtime-only',
      fetch: async () =>
        Response.json({
          code: 200,
          data: {
            videos: [
              { id: 'long-video', title: '长视频', media: { duration: 10800 } },
            ],
          },
        }),
    })
    const batch = await provider.discover({
      source: source('wechat_channels', 'finder-user'),
      limit: 1,
    })
    expect(batch.items[0]?.video?.durationSeconds).toBe(10800)
  })
})
