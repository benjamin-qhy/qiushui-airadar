import { describe, expect, it, vi } from 'vitest'

import {
  ProviderDiscoveryError,
  classifyNonArticlePage,
  createProviderRouter,
  createTwitterApiIoProvider,
  fetchTwitterApiIoArticle,
  createTikHubXProvider,
  createTikHubYouTubeProvider,
  createTikHubYouTubeTranscriptProvider,
  createYouTubeDataApiProvider,
  decideVideoEnrichment,
  normalizeYouTubeIdentity,
  providerCursor,
  redactProviderError,
  selectXCarrier,
  type ProviderAttemptAudit,
} from './index.js'

const xSource = {
  id: 'x-openai',
  slug: 'openai-x',
  name: 'OpenAI on X',
  type: 'x' as const,
  externalIdentity: 'OpenAI',
  status: 'enabled' as const,
}

const youtubeSource = {
  id: 'youtube-openai',
  slug: 'openai-youtube',
  name: 'OpenAI on YouTube',
  type: 'youtube' as const,
  externalIdentity: 'https://www.youtube.com/@OpenAI',
  status: 'enabled' as const,
}

describe('provider routing', () => {
  it('recursively removes credentials echoed in structured provider errors', () => {
    expect(
      redactProviderError(
        new Error(
          '{"detail":{"headers":{"Authorization":"Bearer private","api_key":"private"}}}'
        )
      )
    ).not.toContain('private')
    expect(
      redactProviderError(
        new Error(
          '{"message":"Authorization: Bearer private-nested","url":"https://x.test/?key=private-query"}'
        )
      )
    ).not.toContain('private-')
    expect(
      redactProviderError(
        new Error(
          'Authorization: Bearer private-value url=https://x.test/?api_key=private-query Cookie: session=private-cookie'
        )
      )
    ).not.toContain('private-')
  })

  it('tries enabled providers in order, audits every call, and fails over', async () => {
    const audits: ProviderAttemptAudit[] = []
    const first = {
      providerId: 'primary',
      sourceType: 'x' as const,
      discover: vi.fn(async () => {
        throw new ProviderDiscoveryError('temporary', 'upstream timeout')
      }),
    }
    const second = {
      providerId: 'fallback',
      sourceType: 'x' as const,
      discover: vi.fn(async () => ({ items: [], providerId: 'fallback' })),
    }
    const router = createProviderRouter({
      providers: [first, second],
      audit: async (attempt) => {
        audits.push(attempt)
      },
      now: () => new Date('2026-09-14T08:00:00.000Z'),
    })

    await expect(
      router.discover({ source: xSource, limit: 20 })
    ).resolves.toEqual({
      items: [],
      providerId: 'fallback',
    })
    expect(first.discover).toHaveBeenCalledOnce()
    expect(second.discover).toHaveBeenCalledOnce()
    expect(
      audits.map(({ providerId, status, errorClass }) => ({
        providerId,
        status,
        errorClass,
      }))
    ).toEqual([
      { providerId: 'primary', status: 'failed', errorClass: 'temporary' },
      { providerId: 'fallback', status: 'succeeded', errorClass: undefined },
    ])
    expect(router.health('primary')).toMatchObject({ state: 'cooldown' })
  })

  it('keeps credential failures disabled until a manual recovery', async () => {
    let current = new Date('2026-09-14T08:00:00.000Z')
    const primary = {
      providerId: 'primary',
      sourceType: 'x' as const,
      discover: vi.fn(async () => {
        throw new ProviderDiscoveryError('credential', 'token=private')
      }),
    }
    const fallback = {
      providerId: 'fallback',
      sourceType: 'x' as const,
      discover: vi.fn(async () => ({ items: [], providerId: 'fallback' })),
    }
    const router = createProviderRouter({
      providers: [primary, fallback],
      audit: async () => undefined,
      now: () => current,
    })

    await router.discover({ source: xSource, limit: 20 })
    current = new Date('2026-09-15T08:00:00.000Z')
    await router.discover({ source: xSource, limit: 20 })
    expect(primary.discover).toHaveBeenCalledTimes(1)
    expect(router.health('primary')).toMatchObject({ state: 'manual-recovery' })

    await router.restore('primary', async () => undefined)
    await router.discover({ source: xSource, limit: 20 })
    expect(primary.discover).toHaveBeenCalledTimes(2)
  })

  it('loads manual-recovery health after restart and only clears it after a successful probe', async () => {
    const persisted = new Map()
    const healthStore = {
      async load(providerId: string) {
        return persisted.get(providerId)
      },
      async save(providerId: string, health: unknown) {
        persisted.set(providerId, health)
      },
    }
    const primary = {
      providerId: 'primary',
      sourceType: 'x' as const,
      discover: vi.fn(async () => {
        throw new ProviderDiscoveryError('credential', 'invalid credential')
      }),
    }
    const fallback = {
      providerId: 'fallback',
      sourceType: 'x' as const,
      discover: vi.fn(async () => ({ items: [], providerId: 'fallback' })),
    }
    await createProviderRouter({
      providers: [primary, fallback],
      audit: async () => undefined,
      healthStore,
    }).discover({ source: xSource, limit: 20 })
    const restarted = createProviderRouter({
      providers: [primary, fallback],
      audit: async () => undefined,
      healthStore,
    })
    await restarted.discover({ source: xSource, limit: 20 })
    expect(primary.discover).toHaveBeenCalledTimes(1)
    await expect(
      restarted.restore('primary', async () => {
        throw new Error('probe failed')
      })
    ).rejects.toThrow('probe failed')
    await restarted.discover({ source: xSource, limit: 20 })
    expect(primary.discover).toHaveBeenCalledTimes(1)
    await restarted.restore('primary', async () => undefined)
    expect(restarted.health('primary')).toEqual({ state: 'healthy' })
  })
})

describe('stable platform identity', () => {
  it('identifies confirmed non-article destinations without catching articles', () => {
    expect(
      classifyNonArticlePage(
        'https://events.ycombinator.com/MakeSomethingAgentsWant'
      )
    ).toBe('活动页：活动报名与介绍，不是文章正文')
    expect(
      classifyNonArticlePage(
        'https://aws-experience.com/apj/smb/e/0700a/architecting-flexible-agentic-ai'
      )
    ).toBe('活动页：工作坊报名与介绍，不是文章正文')
    expect(
      classifyNonArticlePage('https://claude.ai/artifact/example')
    ).toBe('互动作品：游戏或应用，不是文章正文')
    expect(
      classifyNonArticlePage(
        'https://chatgpt.com/plugins?category=small-business'
      )
    ).toBe('目录页：插件列表，不是单篇文章')
    expect(classifyNonArticlePage('https://openai.com/gpt-tv/')).toBe(
      '互动页：播放器与操作界面，不是文章正文'
    )
    expect(
      classifyNonArticlePage('https://openai.com/index/gpt-6-astra')
    ).toBeUndefined()
  })
  it('normalizes all supported YouTube URLs to one video identity', () => {
    const urls = [
      'https://youtu.be/dQw4w9WgXcQ?t=30',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=x',
      'https://youtube.com/shorts/dQw4w9WgXcQ',
    ]
    expect(urls.map(normalizeYouTubeIdentity)).toEqual(
      urls.map(() => ({
        platformIdentity: 'youtube:dQw4w9WgXcQ',
        canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        videoId: 'dQw4w9WgXcQ',
      }))
    )
  })

  it('uses the fixed X carrier priority', () => {
    expect(
      selectXCarrier({
        tweetId: '1',
        text: 'announcement',
        urls: [
          { expandedUrl: 'https://example.com/story', kind: 'article' },
          { expandedUrl: 'https://youtu.be/dQw4w9WgXcQ', kind: 'external' },
        ],
        nativeVideo: true,
      })
    ).toMatchObject({
      kind: 'video',
      platformIdentity: 'youtube:dQw4w9WgXcQ',
    })
    expect(
      [
        'HTTPS://Example.com/story/?b=2&a=1&utm_source=x#top',
        'https://example.com/story?a=1&b=2',
      ].map(
        (expandedUrl) =>
          selectXCarrier({
            tweetId: '2',
            text: 'article',
            urls: [{ expandedUrl, kind: 'article' }],
          }).platformIdentity
      )
    ).toEqual([
      'url:https://example.com/story?a=1&b=2',
      'url:https://example.com/story?a=1&b=2',
    ])
    expect(
      selectXCarrier({
        tweetId: '2093022448132452398',
        text: 'Read the full article',
        urls: [
          {
            expandedUrl: 'https://x.com/i/article/2093011711712456704',
            kind: 'external',
          },
        ],
      })
    ).toMatchObject({
      kind: 'article',
      carrier: 'x-article',
      canonicalUrl: 'https://x.com/i/article/2093011711712456704',
    })
  })
})

describe('redacted real provider samples', () => {
  it('uses the original tweet id for an X Article found through a retweet', async () => {
    const provider = createTwitterApiIoProvider({
      apiKey: 'runtime-only',
      fetch: async (url) =>
        Response.json(
          String(url).includes('/user/info')
            ? { data: { id: 'author-1' } }
            : {
                data: {
                  tweets: [
                    {
                      id: '2093022448132452398',
                      text: 'RT: Read the article',
                      retweeted_tweet: {
                        id: '2093021551855812842',
                        text: 'Read the article',
                        entities: {
                          urls: [
                            {
                              expanded_url:
                                'https://x.com/i/article/2093011711712456704',
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
              }
        ),
    })
    const batch = await provider.discover({ source: xSource, limit: 20 })
    expect(batch.items[0]).toMatchObject({
      externalId: '2093021551855812842',
      platformIdentity: 'url:https://x.com/i/article/2093011711712456704',
      discoveryParts: [{ externalId: '2093022448132452398' }],
    })
  })

  it('keeps the complete X post text when the preview is shorter', async () => {
    const provider = createTwitterApiIoProvider({
      apiKey: 'runtime-only',
      fetch: async (url) =>
        Response.json(
          String(url).includes('/user/info')
            ? { data: { id: '1', userName: 'Example' } }
            : {
                data: {
                  tweets: [
                    {
                      id: '123',
                      text: 'Short preview',
                      fullText:
                        'The complete original post is substantially longer than the preview.',
                      url: 'https://x.com/Example/status/123',
                    },
                  ],
                },
              }
        ),
    })
    const batch = await provider.discover({
      source: { ...xSource, externalIdentity: 'Example' },
      limit: 20,
    })
    expect(batch.items[0]?.evidence?.sourceText).toBe(
      'The complete original post is substantially longer than the preview.'
    )
  })

  it('maps TwitterAPI.io list metrics without per-item requests', async () => {
    const calls: string[] = []
    const provider = createTwitterApiIoProvider({
      apiKey: 'runtime-only',
      fetch: async (url) => {
        calls.push(String(url))
        if (String(url).includes('/user/info')) {
          return Response.json({
            data: { id: '4398626122', userName: 'OpenAI' },
          })
        }
        return Response.json({
          data: {
            tweets: [
              {
                id: '1967209052908876057',
                text: 'A real redacted response sample',
                createdAt: 'Sun Sep 14 07:00:00 +0000 2026',
                likeCount: 42,
                replyCount: 3,
                retweetCount: 7,
                viewCount: 1000,
                url: 'https://x.com/OpenAI/status/1967209052908876057',
              },
            ],
          },
        })
      },
    })

    const batch = await provider.discover({ source: xSource, limit: 20 })
    expect(calls).toHaveLength(2)
    expect(batch.items[0]).toMatchObject({
      externalId: '1967209052908876057',
      platformIdentity: 'x:1967209052908876057',
      content: { kind: 'short_post' },
      interaction: {
        views: 1000,
        likes: 42,
        comments: 3,
        shares: 7,
        saves: null,
      },
    })
  })

  it('excludes ordinary replies, merges self-reply threads, and maps retweets to the original identity', async () => {
    const provider = createTwitterApiIoProvider({
      apiKey: 'runtime-only',
      fetch: async (url) =>
        String(url).includes('/user/info')
          ? Response.json({ data: { id: 'author-1' } })
          : Response.json({
              data: {
                tweets: [
                  {
                    id: 'root-1',
                    conversationId: 'root-1',
                    text: 'part one',
                    createdAt: '2026-09-14T07:00:00Z',
                    author: { id: 'author-1', userName: 'author' },
                  },
                  {
                    id: 'reply-self',
                    conversationId: 'root-1',
                    text: 'part two',
                    createdAt: '2026-09-14T07:01:00Z',
                    isReply: true,
                    inReplyToUserId: 'author-1',
                    author: { id: 'author-1', userName: 'author' },
                  },
                  {
                    id: 'reply-other',
                    conversationId: 'other',
                    text: 'ordinary reply',
                    isReply: true,
                    inReplyToUserId: 'someone-else',
                    author: { id: 'author-1', userName: 'author' },
                  },
                  {
                    id: 'original-1',
                    text: 'original text',
                    author: { id: 'other-author' },
                  },
                  {
                    id: 'retweet-evidence',
                    text: 'RT',
                    retweeted_tweet: {
                      id: 'original-1',
                      text: 'original text',
                      author: { id: 'other-author' },
                    },
                  },
                  {
                    id: 'quote-1',
                    text: 'quoted with comment',
                    quoted_tweet: { id: 'quoted-original' },
                    author: { id: 'author-1' },
                  },
                ],
              },
            }),
    })
    const batch = await provider.discover({ source: xSource, limit: 20 })
    expect(batch.items.map((item) => item.platformIdentity).sort()).toEqual([
      'x:original-1',
      'x:quote-1',
      'x:root-1',
    ])
    expect(
      batch.items.find((item) => item.platformIdentity === 'x:root-1')
        ?.description
    ).toBe('part one\n\npart two')
    expect(
      batch.items.find((item) => item.platformIdentity === 'x:original-1')
        ?.externalId
    ).toBe('original-1')
    expect(
      batch.items
        .find((item) => item.platformIdentity === 'x:original-1')
        ?.discoveryParts?.map((part) => part.externalId)
        .sort()
    ).toEqual(['original-1', 'retweet-evidence'])
  })

  it('keeps X photos and the complete quoted post with its photos', async () => {
    const provider = createTwitterApiIoProvider({
      apiKey: 'runtime-only',
      fetch: async (url) =>
        String(url).includes('/user/info')
          ? Response.json({ data: { id: 'author-1' } })
          : Response.json({
              data: {
                tweets: [{
                  id: 'quote-2',
                  text: 'My comment',
                  author: { userName: 'alice', name: 'Alice' },
                  extendedEntities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/main.jpg' }] },
                  quoted_tweet: {
                    id: 'original-2',
                    text: 'The complete quoted text',
                    author: { userName: 'bob', name: 'Bob' },
                    extendedEntities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/quoted.jpg' }] },
                  },
                }],
              },
            }),
    })
    const item = (await provider.discover({ source: xSource, limit: 20 })).items[0]
    expect(item?.images).toEqual([{ order: 0, url: 'https://pbs.twimg.com/media/main.jpg' }])
    expect(item?.quotedPost).toEqual({
      url: 'https://x.com/i/status/original-2',
      authorName: 'Bob',
      authorHandle: 'bob',
      text: 'The complete quoted text',
      images: [{ order: 0, url: 'https://pbs.twimg.com/media/quoted.jpg' }],
    })
  })

  it('keeps both X discovery records when two posts link the same YouTube video', async () => {
    const provider = createTwitterApiIoProvider({
      apiKey: 'runtime-only',
      fetch: async (url) =>
        String(url).includes('/user/info')
          ? Response.json({ data: { id: 'author-1' } })
          : Response.json({
              data: {
                tweets: ['post-1', 'post-2'].map((id) => ({
                  id,
                  conversationId: id,
                  text: `YouTube discovery ${id}`,
                  viewCount: id === 'post-1' ? 10 : 20,
                  author: { id: 'author-1', userName: 'author' },
                  entities: {
                    urls: [{ expanded_url: 'https://youtu.be/dQw4w9WgXcQ' }],
                  },
                })),
              },
            }),
    })
    const batch = await provider.discover({ source: xSource, limit: 20 })
    expect(batch.items).toHaveLength(1)
    expect(batch.items[0]?.platformIdentity).toBe('youtube:dQw4w9WgXcQ')
    expect(
      batch.items[0]?.discoveryParts?.map((part) => part.externalId)
    ).toEqual(['post-1', 'post-2'])
    expect(
      batch.items[0]?.discoveryParts?.map((part) => part.interaction?.views)
    ).toEqual([10, 20])
  })

  it('keeps a self-reply thread identity stable when its parts arrive on different pages', async () => {
    let page = 0
    const provider = createTwitterApiIoProvider({
      apiKey: 'runtime-only',
      fetch: async (url) => {
        if (String(url).includes('/user/info')) {
          return Response.json({ data: { id: 'author-1' } })
        }
        page += 1
        return Response.json({
          data: {
            tweets:
              page === 1
                ? [
                    {
                      id: 'root-1',
                      conversationId: 'root-1',
                      text: 'part one',
                      author: { id: 'author-1', userName: 'author' },
                    },
                  ]
                : [
                    {
                      id: 'reply-self',
                      conversationId: 'root-1',
                      text: 'part two',
                      isReply: true,
                      inReplyToUserId: 'author-1',
                      author: { id: 'author-1', userName: 'author' },
                    },
                    {
                      id: 'reply-self-2',
                      conversationId: 'root-1',
                      text: 'part three',
                      isReply: true,
                      inReplyToUserId: 'author-1',
                      author: { id: 'author-1', userName: 'author' },
                    },
                  ],
          },
        })
      },
    })

    const first = await provider.discover({ source: xSource, limit: 20 })
    const second = await provider.discover({ source: xSource, limit: 20 })
    expect(first.items[0]).toMatchObject({
      externalId: 'root-1',
      platformIdentity: 'x:root-1',
    })
    expect(second.items[0]).toMatchObject({
      externalId: 'reply-self',
      platformIdentity: 'x:root-1',
      content: { canonicalUrl: 'https://x.com/i/status/root-1' },
      thread: {
        conversationId: 'root-1',
        complete: false,
        parts: [
          { id: 'reply-self', text: 'part two' },
          { id: 'reply-self-2', text: 'part three' },
        ],
      },
      discoveryParts: [
        { externalId: 'reply-self' },
        { externalId: 'reply-self-2' },
      ],
    })
  })

  it('maps Google list details, excludes live and Shorts by default, and shares X identity', async () => {
    const provider = createYouTubeDataApiProvider({
      apiKey: 'runtime-only',
      fetch: async (url) => {
        const value = String(url)
        if (value.includes('/@OpenAI/videos')) {
          return new Response(
            '{"videoId":"dQw4w9WgXcQ"}{"videoId":"live0000001"}'
          )
        }
        if (value.includes('/channels')) {
          return Response.json({
            items: [
              { contentDetails: { relatedPlaylists: { uploads: 'UU-test' } } },
            ],
          })
        }
        if (value.includes('/playlistItems')) {
          return Response.json({
            items: [
              {
                contentDetails: {
                  videoId: 'dQw4w9WgXcQ',
                  videoPublishedAt: '2026-09-14T07:00:00Z',
                },
              },
              {
                contentDetails: {
                  videoId: 'short000001',
                  videoPublishedAt: '2026-09-14T06:00:00Z',
                },
              },
              {
                contentDetails: {
                  videoId: 'live0000001',
                  videoPublishedAt: '2026-09-14T05:00:00Z',
                },
              },
            ],
          })
        }
        return Response.json({
          items: [
            {
              id: 'dQw4w9WgXcQ',
              snippet: { title: 'Normal video', liveBroadcastContent: 'none' },
              contentDetails: { duration: 'PT12M' },
              statistics: {
                viewCount: '100',
                likeCount: '9',
                commentCount: '2',
              },
            },
            {
              id: 'short000001',
              snippet: { title: 'Short', liveBroadcastContent: 'none' },
              contentDetails: { duration: 'PT59S' },
              statistics: {},
            },
            {
              id: 'live0000001',
              snippet: { title: 'Live', liveBroadcastContent: 'live' },
              contentDetails: { duration: 'PT1H' },
              statistics: {},
            },
          ],
        })
      },
    })

    const batch = await provider.discover({ source: youtubeSource, limit: 20 })
    expect(batch.items).toHaveLength(1)
    expect(batch.items[0]).toMatchObject({
      externalId: 'dQw4w9WgXcQ',
      platformIdentity: 'youtube:dQw4w9WgXcQ',
      content: {
        kind: 'video',
        canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      },
      interaction: {
        views: 100,
        likes: 9,
        comments: 2,
        shares: null,
        saves: null,
      },
    })
  })

  it('paginates the normal-video tab without mixing in uploads from other scopes', async () => {
    const provider = createYouTubeDataApiProvider({
      apiKey: 'runtime-only',
      fetch: async (url, init) => {
        if (init?.method === 'POST') {
          return Response.json({
            continuationItems: [{ videoId: 'second00001' }],
            continuationCommand: { token: 'third-page-token' },
          })
        }
        if (String(url).includes('/@OpenAI/videos')) {
          return new Response(
            '{"INNERTUBE_API_KEY":"public-key","INNERTUBE_CLIENT_VERSION":"2.0","videoId":"first000001"}'
          )
        }
        return Response.json({
          items: [
            {
              id: 'second00001',
              snippet: {
                title: 'Second-page normal video',
                liveBroadcastContent: 'none',
              },
              contentDetails: { duration: 'PT2M' },
              statistics: {},
            },
          ],
        })
      },
    })
    const batch = await provider.discover({
      source: youtubeSource,
      cursor: '{"providers":{"youtube-data-api":"second-page-token"}}',
      limit: 20,
    })
    expect(batch.items[0]?.externalId).toBe('second00001')
    expect(providerCursor(batch.nextCursor, 'youtube-data-api')).toBe(
      'third-page-token'
    )
  })

  it('clears only the active provider cursor when that provider reaches the end', async () => {
    const provider = createYouTubeDataApiProvider({
      apiKey: 'runtime-only',
      fetch: async (url, init) => {
        if (init?.method === 'POST') {
          return Response.json({
            continuationItems: [{ videoId: 'last0000001' }],
          })
        }
        if (String(url).includes('/@OpenAI/videos')) {
          return new Response(
            '{"INNERTUBE_API_KEY":"public-key","INNERTUBE_CLIENT_VERSION":"2.0","videoId":"first000001"}'
          )
        }
        return Response.json({
          items: [
            {
              id: 'last0000001',
              snippet: {
                title: 'Last normal video',
                liveBroadcastContent: 'none',
              },
              contentDetails: { duration: 'PT2M' },
              statistics: {},
            },
          ],
        })
      },
    })
    const batch = await provider.discover({
      source: youtubeSource,
      cursor:
        '{"providers":{"youtube-data-api":"finished","tikhub-youtube":"keep-me"}}',
      limit: 20,
    })
    expect(providerCursor(batch.nextCursor, 'youtube-data-api')).toBeUndefined()
    expect(providerCursor(batch.nextCursor, 'tikhub-youtube')).toBe('keep-me')
  })

  it('maps the current TikHub X timeline and YouTube web_v2 formats', async () => {
    const xProvider = createTikHubXProvider({
      token: 'runtime-only',
      fetch: async () =>
        Response.json({
          code: 200,
          data: {
            timeline: [
              {
                tweet_id: '2098796742435283027',
                text: 'A real redacted X response sample',
                created_at: 'Sun Sep 14 07:00:00 +0000 2026',
                views: '1000',
                favorites: 42,
                replies: 3,
                retweets: 7,
                bookmarks: 1,
                entities: {
                  urls: [{ expanded_url: 'https://youtu.be/wr6PMD06hP0' }],
                },
              },
            ],
            next_cursor: 'next-x',
          },
        }),
    })
    const youtubeProvider = createTikHubYouTubeProvider({
      token: 'runtime-only',
      channelId: 'UCcefcZRL2oaA_uBNeo5UOWg',
      fetch: async () =>
        Response.json({
          code: 200,
          data: {
            videos: [
              {
                video_id: 'wr6PMD06hP0',
                title: 'A real redacted YouTube response sample',
                duration: '12:34',
                view_count: '1.2K views',
                is_live: false,
                url: 'https://www.youtube.com/watch?v=wr6PMD06hP0',
              },
            ],
            continuation_token: 'next-youtube',
          },
        }),
    })

    const [xBatch, youtubeBatch] = await Promise.all([
      xProvider.discover({ source: xSource, limit: 20 }),
      youtubeProvider.discover({ source: youtubeSource, limit: 20 }),
    ])
    expect(providerCursor(xBatch.nextCursor, 'tikhub-x')).toBe('next-x')
    expect(providerCursor(youtubeBatch.nextCursor, 'tikhub-youtube')).toBe(
      'next-youtube'
    )
    expect(xBatch.items[0]?.platformIdentity).toBe('youtube:wr6PMD06hP0')
    expect(youtubeBatch.items[0]?.platformIdentity).toBe('youtube:wr6PMD06hP0')
    expect(youtubeBatch.items[0]?.interaction?.views).toBe(1_200)
  })

  it('classifies TikHub business errors returned inside HTTP 200', async () => {
    const provider = createTikHubXProvider({
      token: 'runtime-only',
      fetch: async () =>
        Response.json({
          code: 402,
          message: 'Insufficient balance',
          detail: { token: 'private-value' },
        }),
    })
    await expect(
      provider.discover({ source: xSource, limit: 20 })
    ).rejects.toMatchObject({ errorClass: 'balance' })
    await expect(
      provider.discover({ source: xSource, limit: 20 })
    ).rejects.not.toThrow('private-value')
  })

  it('rejects a TikHub response without an explicit business status', async () => {
    const provider = createTikHubXProvider({
      token: 'runtime-only',
      fetch: async () => Response.json({ data: {} }),
    })
    await expect(
      provider.discover({ source: xSource, limit: 20 })
    ).rejects.toMatchObject({ errorClass: 'invalid-response' })
  })

  it('fetches an available platform caption through the TikHub caption flow', async () => {
    const calls: string[] = []
    const provider = createTikHubYouTubeTranscriptProvider({
      token: 'runtime-only',
      fetch: async (url) => {
        calls.push(String(url))
        return calls.length === 1
          ? Response.json({
              code: 200,
              data: { captions: [{ language_code: 'en' }] },
            })
          : Response.json({
              code: 200,
              data: { text: 'complete platform transcript' },
            })
      },
    })
    await expect(provider.fetchTranscript('wr6PMD06hP0')).resolves.toEqual({
      status: 'available',
      text: 'complete platform transcript',
      languageCode: 'en',
    })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('format=txt')
  })

  it('gets the complete X Article by its originating tweet id', async () => {
    const calls: string[] = []
    const article = await fetchTwitterApiIoArticle({
      apiKey: 'runtime-only',
      tweetId: '2093022448132452398',
      canonicalUrl: 'https://x.com/i/article/2093011711712456704',
      fetch: async (url, init) => {
        calls.push(String(url))
        expect(new Headers(init?.headers).get('X-API-Key')).toBe('runtime-only')
        return Response.json({
          status: 'success',
          article: {
            title: 'A complete long article',
            contents: [
              { type: 'header-one', text: 'Introduction' },
              {
                type: 'unstyled',
                text: 'The complete first paragraph contains substantial original details rather than a preview. '.repeat(
                  2
                ),
              },
              {
                type: 'unstyled',
                text: 'The second paragraph follows in the same order and preserves the rest of the article.',
              },
            ],
          },
        })
      },
    })
    expect(calls).toEqual([
      'https://api.twitterapi.io/twitter/article?tweet_id=2093022448132452398',
    ])
    expect(article.title).toBe('A complete long article')
    expect(article.body).toContain('The second paragraph follows')
    expect(article.body).not.toContain('undefined')
  })

  it('resolves an old retweet id before retrying a missing X Article', async () => {
    const calls: string[] = []
    const article = await fetchTwitterApiIoArticle({
      apiKey: 'runtime-only',
      tweetId: '2093022448132452398',
      canonicalUrl: 'https://x.com/i/article/2093011711712456704',
      fetch: async (url) => {
        calls.push(String(url))
        if (String(url).includes('/twitter/tweets?')) {
          return Response.json({
            status: 'success',
            tweets: [
              {
                id: '2093022448132452398',
                retweeted_tweet: { id: '2093021551855812842' },
              },
            ],
          })
        }
        return Response.json(
          String(url).includes('2093021551855812842')
            ? {
                status: 'success',
                article: {
                  title: 'Recovered article',
                  contents: [
                    {
                      text: 'Complete original article paragraph. '.repeat(10),
                    },
                  ],
                },
              }
            : { status: 'failed', msg: 'article not found' }
        )
      },
    })
    expect(article.body).toContain('Complete original article')
    expect(calls).toEqual([
      'https://api.twitterapi.io/twitter/article?tweet_id=2093022448132452398',
      'https://api.twitterapi.io/twitter/tweets?tweet_ids=2093022448132452398',
      'https://api.twitterapi.io/twitter/article?tweet_id=2093021551855812842',
    ])
  })
})

describe('video completeness gate', () => {
  it('waits for manual transcription by default and only auto-transcribes eligible videos', () => {
    expect(
      decideVideoEnrichment({
        hasTranscript: false,
        durationSeconds: 600,
        autoTranscribe: false,
      })
    ).toEqual({ status: 'waiting-manual-transcription' })
    expect(
      decideVideoEnrichment({
        hasTranscript: false,
        durationSeconds: 600,
        autoTranscribe: true,
      })
    ).toEqual({ status: 'auto-transcription-pending' })
    expect(
      decideVideoEnrichment({
        hasTranscript: false,
        durationSeconds: 7_201,
        autoTranscribe: true,
      })
    ).toEqual({ status: 'waiting-manual-transcription' })
    expect(
      decideVideoEnrichment({
        hasTranscript: true,
        durationSeconds: 7_201,
        autoTranscribe: false,
      })
    ).toEqual({ status: 'ready' })
  })
})
