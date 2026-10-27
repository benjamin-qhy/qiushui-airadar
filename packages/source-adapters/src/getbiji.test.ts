import { describe, expect, it } from 'vitest'

import type { Source } from '@qiushui-airadar/domain'

import {
  createGetBijiDouyinProvider,
  createGetBijiDouyinTranscriber,
} from './getbiji.js'
import { providerCursor } from './index.js'

const douyinSource: Source = {
  id: 'douyin-getbiji',
  slug: 'douyin-getbiji',
  name: 'Douyin GetBiji',
  type: 'douyin',
  externalIdentity: 'sec-user',
  status: 'enabled',
}

describe('GetBiji Douyin provider', () => {
  it('maps blogger content without inventing missing interaction metrics', async () => {
    const provider = createGetBijiDouyinProvider({
      apiKey: 'runtime-only',
      clientId: 'client-only',
      topicId: 'topic-1',
      followId: 'follow-1',
      fetch: async () =>
        Response.json({
          success: true,
          data: {
            has_more: true,
            contents: [
              {
                post_id_alias: 'post-alias-1',
                post_title: '真实视频标题',
                post_summary: '真实视频说明',
                post_publish_time: '2026-09-14 08:00:00',
                post_url:
                  'https://www.iesdouyin.com/share/video/7685040729786679717/',
              },
            ],
          },
        }),
    })
    const batch = await provider.discover({ source: douyinSource, limit: 20 })
    expect(batch.items[0]).toMatchObject({
      externalId: '7685040729786679717',
      platformIdentity: 'douyin:7685040729786679717',
      video: { providerReference: 'post-alias-1' },
      interaction: {
        views: null,
        likes: null,
        comments: null,
        shares: null,
        saves: null,
      },
    })
    expect(
      JSON.parse(providerCursor(batch.nextCursor, 'getbiji-douyin') ?? '{}')
    ).toEqual({ page: 2, seenIds: [] })
  })

  it('keeps the unconsumed part of a provider page in the next cursor', async () => {
    let requestCount = 0
    const provider = createGetBijiDouyinProvider({
      apiKey: 'runtime-only',
      clientId: 'client-only',
      topicId: 'topic-1',
      followId: 'follow-1',
      fetch: async () => {
        requestCount += 1
        const ids = requestCount === 1 ? ['1', '2', '3'] : ['0', '1', '2', '3']
        return Response.json({
          success: true,
          data: {
            has_more: true,
            contents: ids.map((id) => ({
              post_id_alias: `alias-${id}`,
              post_title: `标题 ${id}`,
              post_url: `https://www.douyin.com/video/${id}`,
            })),
          },
        })
      },
    })
    const first = await provider.discover({ source: douyinSource, limit: 2 })
    const second = await provider.discover({
      source: douyinSource,
      cursor: first.nextCursor,
      limit: 2,
    })
    expect(first.items.map(({ externalId }) => externalId)).toEqual(['1', '2'])
    expect(second.items.map(({ externalId }) => externalId)).toEqual(['0', '3'])
    expect(
      JSON.parse(providerCursor(second.nextCursor, 'getbiji-douyin') ?? '{}')
    ).toEqual({ page: 2, seenIds: [] })
  })

  it.each([
    [{ success: false, code: 401, message: 'unauthorized' }, 'credential'],
    [{ success: false, code: 402, message: '余额不足' }, 'balance'],
    [{ success: false, code: 429, message: '请求频繁' }, 'rate-limit'],
  ] as const)(
    'classifies provider failure %j as %s',
    async (payload, expected) => {
      const provider = createGetBijiDouyinProvider({
        apiKey: 'runtime-only',
        clientId: 'client-only',
        topicId: 'topic-1',
        followId: 'follow-1',
        fetch: async () => Response.json(payload),
      })
      await expect(
        provider.discover({ source: douyinSource, limit: 1 })
      ).rejects.toMatchObject({ errorClass: expected })
    }
  )

  it('uses the detail media text as transcript and rejects summary-only details', async () => {
    const responses = [
      Response.json({
        success: true,
        data: { post_media_text: '真实逐字转写', post_summary: '摘要' },
      }),
      Response.json({ success: true, data: { post_summary: '只有摘要' } }),
    ]
    const transcriber = createGetBijiDouyinTranscriber({
      apiKey: 'runtime-only',
      clientId: 'client-only',
      topicId: 'topic-1',
      fetch: async () => responses.shift()!,
    })
    await expect(
      transcriber.transcribe({
        videoId: 'video-1',
        canonicalUrl: 'https://www.douyin.com/video/video-1',
        providerReference: 'post-alias-1',
      })
    ).resolves.toBe('真实逐字转写')
    await expect(
      transcriber.transcribe({
        videoId: 'video-2',
        canonicalUrl: 'https://www.douyin.com/video/video-2',
        providerReference: 'post-alias-2',
      })
    ).rejects.toThrow('no complete media transcript')
  })
})
