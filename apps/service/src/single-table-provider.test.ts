import { expect, it, vi } from 'vitest'

import { createSingleTableSourceProvider } from './single-table-provider.js'

it('uses local X video transcription only when a transcriber is supplied', async () => {
  const source = {
    id: 'x-example',
    platform: 'x',
    account_name: 'X / Example',
    external_identity: 'Example',
    language: 'en' as const,
    enabled: true,
  }
  const item = {
    externalId: 'video-1',
    url: 'https://x.com/Example/status/video-1',
    title: 'Video',
    kind: 'video' as const,
  }
  await expect(
    createSingleTableSourceProvider({}).resolve(source, item)
  ).rejects.toThrow('Video captions provider is unavailable')
  const transcribe = vi.fn(async () => 'Complete spoken content of the video.')
  const resolved = await createSingleTableSourceProvider({
    xVideoTranscriber: transcribe,
  }).resolve(source, item)
  expect(transcribe).toHaveBeenCalledWith(item.url)
  expect(resolved.original).toMatchObject({
    body: 'Complete spoken content of the video.',
    format: 'subtitle',
  })
})

it('uses platform captions for a YouTube video discovered from X', async () => {
  const calls: string[] = []
  const provider = createSingleTableSourceProvider({
    tikHubToken: 'test-only',
    fetch: async (url) => {
      calls.push(String(url))
      return calls.length === 1
        ? Response.json({
            code: 200,
            data: { captions: [{ language_code: 'en' }] },
          })
        : Response.json({
            code: 200,
            data: { text: 'Complete caption text from YouTube.' },
          })
    },
  })
  const resolved = await provider.resolve(
    {
      id: 'x-example',
      platform: 'x',
      account_name: 'X / Example',
      external_identity: 'Example',
      language: 'en',
      enabled: true,
    },
    {
      externalId: 'tweet-id',
      url: 'https://www.youtube.com/watch?v=oVKGKdIAgtg',
      title: 'Linked video',
      kind: 'video',
    }
  )
  expect(resolved.original.body).toBe('Complete caption text from YouTube.')
  expect(calls).toHaveLength(2)
  expect(calls[0]).toContain('oVKGKdIAgtg')
})

it('discovers one RSS page, fetches article body, and records both requests and responses', async () => {
  const requested: string[] = []
  const articleText =
    'This article explains a practical AI agent workflow with a concrete example and useful limitations. '.repeat(
      8
    )
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    requested.push(url)
    if (url.endsWith('feed.xml')) {
      return new Response(
        `<rss><channel><item><guid>one</guid><title>Example</title><link>https://example.com/article</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`,
        {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        }
      )
    }
    return new Response(
      `<html><head><title>Example Article</title></head><body><article><h1>Example Article</h1><p>${articleText}</p></article></body></html>`,
      {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }
    )
  }
  const provider = createSingleTableSourceProvider({ fetch: fetcher })
  const source = {
    id: 'feed',
    platform: 'rss',
    account_name: 'Example',
    external_identity: 'https://example.com/feed.xml',
    language: 'en' as const,
    enabled: true,
  }
  const page = await provider.discover(source, 20)
  expect(page.items).toHaveLength(1)
  expect(requested).toEqual(['https://example.com/feed.xml'])
  expect(JSON.stringify(page.response)).toContain('Example')
  const resolved = await provider.resolve(source, page.items[0]!)
  expect(requested).toEqual([
    'https://example.com/feed.xml',
    'https://example.com/article',
  ])
  expect(resolved.original.body).toContain('practical AI agent workflow')
  expect(resolved.original.originalTitle).toBe('Example Article')
  expect(resolved.calls?.[0]?.request).toMatchObject({
    method: 'GET',
    url: 'https://example.com/article',
  })
  expect(JSON.stringify(resolved.calls?.[0]?.response)).toContain(
    'Example Article'
  )
})

it('uses the native article request path for live RSS and keeps an audit event', async () => {
  const originalFetch = globalThis.fetch
  const feedUrl = 'https://example.com/feed.xml'
  const articleUrl = 'https://example.com/article'
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        `<rss><channel><item><guid>one</guid><title>Example</title><link>${articleUrl}</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`,
        { status: 200, headers: { 'content-type': 'application/xml' } }
      )
  ) as typeof fetch
  try {
    const articleEnricher = vi.fn(
      async (_url: string, fetcher?: typeof fetch) => {
        if (fetcher) throw new Error('Wrapped article request used')
        return {
          title: 'Example Article',
          body: 'Complete article body. '.repeat(20),
          canonicalUrl: articleUrl,
          images: [],
        }
      }
    )
    const provider = createSingleTableSourceProvider({ articleEnricher })
    const source = {
      id: 'feed',
      platform: 'rss',
      account_name: 'Example',
      external_identity: feedUrl,
      language: 'en' as const,
      enabled: true,
    }
    const page = await provider.discover(source, 1)
    const resolved = await provider.resolve(source, page.items[0]!)
    expect(articleEnricher).toHaveBeenCalledWith(articleUrl)
    expect(resolved.original.body).toContain('Complete article body')
    expect(resolved.calls?.[0]).toMatchObject({
      request: { method: 'GET', url: articleUrl },
      response: { title: 'Example Article' },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

it('passes X timeline interaction counts through single-table discovery', async () => {
  const provider = createSingleTableSourceProvider({
    twitterApiKey: 'test-only',
    fetch: async (input) =>
      String(input).includes('/user/info')
        ? Response.json({ data: { id: 'author-1' } })
        : Response.json({
            data: {
              tweets: [
                {
                  id: '123456789',
                  text: 'A useful AI workflow update.',
                  createdAt: 'Fri Sep 18 01:00:00 +0000 2026',
                  viewCount: 26743,
                  likeCount: 623,
                  replyCount: 77,
                  retweetCount: 21,
                },
              ],
            },
          }),
  })
  const source = {
    id: 'x-example',
    platform: 'x',
    account_name: 'X / Example',
    external_identity: 'Example',
    language: 'en' as const,
    enabled: true,
  }
  const page = await provider.discover(source, 1)
  expect(page.items[0]?.interaction).toMatchObject({
    views: 26743,
    likes: 623,
    comments: 77,
    shares: 21,
  })
})

it('keeps the provider default page size when collection does not set a limit', async () => {
  const tweets = Array.from({ length: 25 }, (_, index) => ({
    id: String(123456789 + index),
    text: `Post ${index + 1}`,
    createdAt: 'Fri Sep 18 01:00:00 +0000 2026',
  }))
  const provider = createSingleTableSourceProvider({
    twitterApiKey: 'test-only',
    fetch: async (input) =>
      String(input).includes('/user/info')
        ? Response.json({ data: { id: 'author-1' } })
        : Response.json({ data: { tweets } }),
  })
  const page = await provider.discover({
    id: 'x-example',
    platform: 'x',
    account_name: 'X / Example',
    external_identity: 'Example',
    language: 'en',
    enabled: true,
  })
  expect(page.items).toHaveLength(25)
})

it('tries the configured X list providers in order until one succeeds', async () => {
  const calls: string[] = []
  const provider = createSingleTableSourceProvider({
    twitterApiKey: 'twitter-test-only',
    tikHubToken: 'tikhub-test-only',
    providerRoutes: {
      x_list: ['twitterapi.io', 'tikhub-x'],
    },
    fetch: async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('api.twitterapi.io'))
        return new Response('temporary failure', { status: 503 })
      return Response.json({
        code: 200,
        data: {
          timeline: [
            {
              tweet_id: '123456789',
              text: 'Fallback provider result',
              created_at: 'Fri Sep 18 01:00:00 +0000 2026',
              views: '100',
            },
          ],
        },
      })
    },
  })
  const page = await provider.discover({
    id: 'x-example',
    platform: 'x',
    account_name: 'X / Example',
    external_identity: 'Example',
    language: 'en',
    enabled: true,
  })
  expect(page.providerId).toBe('tikhub-x')
  expect(page.items[0]?.externalId).toBe('123456789')
  expect(calls.some((url) => url.includes('api.twitterapi.io'))).toBe(true)
  expect(calls.some((url) => url.includes('api.tikhub.io'))).toBe(true)
})

it('falls back to native HTTP when the configured X article provider fails', async () => {
  const articleUrl = 'https://x.com/i/article/123456789'
  const articleEnricher = vi.fn(async () => ({
    title: 'Native fallback article',
    body: 'Complete native fallback body. '.repeat(20),
    canonicalUrl: articleUrl,
    images: [],
  }))
  const provider = createSingleTableSourceProvider({
    twitterApiKey: 'twitter-test-only',
    providerRoutes: {
      x_list: ['twitterapi.io'],
      x_article: ['twitterapi.io', 'native-http'],
    },
    articleEnricher,
    fetch: async (input) => {
      const url = String(input)
      if (url.includes('/twitter/user/info'))
        return Response.json({ data: { id: 'author-1' } })
      if (url.includes('/twitter/user/tweet_timeline'))
        return Response.json({
          data: {
            tweets: [
              {
                id: '123456789',
                text: 'Article introduction',
                createdAt: 'Fri Sep 18 01:00:00 +0000 2026',
                article: { url: articleUrl },
              },
            ],
          },
        })
      if (url.includes('/twitter/article'))
        return new Response('temporary failure', { status: 503 })
      throw new Error(`Unexpected request: ${url}`)
    },
  })
  const source = {
    id: 'x-example',
    platform: 'x',
    account_name: 'X / Example',
    external_identity: 'Example',
    language: 'en' as const,
    enabled: true,
  }
  const page = await provider.discover(source, 1)
  const resolved = await provider.resolve(source, page.items[0]!)
  expect(articleEnricher).toHaveBeenCalledWith(articleUrl, expect.any(Function))
  expect(resolved.original.title).toBe('Native fallback article')
  expect(resolved.original.body).toContain('Complete native fallback body')
  expect(resolved.calls).toHaveLength(1)
  expect(resolved.calls?.[0]?.response).toMatchObject({ status: 503 })
})
