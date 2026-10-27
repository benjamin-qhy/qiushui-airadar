import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RuntimeRepository } from '@qiushui-airadar/runtime'
import { createServiceApp, type ServiceApp } from './index.js'

describe('background service shell', () => {
  let service: ServiceApp | undefined
  let dataRoot: string

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'qiushui-airadar-service-'))
  })

  afterEach(async () => {
    await service?.stop()
    await rm(dataRoot, { recursive: true })
  })

  it('exposes English as the language of the current source definitions', async () => {
    service = createServiceApp({ dataRoot })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const response = await fetch(
      `http://${address.host}:${address.port}/api/sources`
    )
    const sources = (
      (await response.json()) as { items: Array<{ language: string }> }
    ).items
    expect(sources.length).toBeGreaterThan(0)
    expect(sources.every((source) => source.language === 'en')).toBe(true)
  })

  it('queues old complete non-junk English content for one translation backfill', async () => {
    const repository = await RuntimeRepository.open(dataRoot)
    await repository.commitDiscoveryBatch({
      sourceId: 'x_openai',
      contents: [
        {
          id: 'x:backfill',
          sourceId: 'x_openai',
          title: 'Update',
          body: 'We shipped an important product update today.',
          canonicalUrl: 'https://x.com/OpenAI/status/backfill',
          enrichmentStatus: 'succeeded',
          kind: 'short_post',
        },
      ],
      discoveries: [],
    })
    await repository.close()
    service = createServiceApp({ dataRoot })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    expect(
      (await fetch(`http://${address.host}:${address.port}/api/sources`)).status
    ).toBe(200)
    await service.stop()
    service = undefined
    const reopened = await RuntimeRepository.open(dataRoot)
    expect(
      reopened
        .listTasks()
        .filter(
          (task) =>
            task.idempotencyKey ===
            'translation-backfill:english-full-translation-v2:x:backfill'
        )
    ).toHaveLength(1)
    await reopened.close()
  })

  it('marks confirmed non-article X destinations as junk with distinct reasons', async () => {
    const repository = await RuntimeRepository.open(dataRoot)
    const urls = [
      'https://events.ycombinator.com/MakeSomethingAgentsWant',
      'https://chatgpt.com/plugins?category=small-business',
      'https://openai.com/gpt-tv',
      'https://openai.com/index/gpt-6-astra',
    ]
    await repository.commitDiscoveryBatch({
      sourceId: 'x_openai',
      contents: urls.map((url, index) => ({
        id: `url:${url}`,
        title: `Content ${index}`,
        body: index === 3 ? 'Complete article body' : '',
        canonicalUrl: url,
        sourceId: 'x_openai',
        kind: 'article',
        enrichmentStatus: index === 3 ? 'succeeded' : 'failed',
      })),
      discoveries: urls.map((url, index) => ({
        id: `discovery-${index}`,
        sourceId: 'x_openai',
        contentId: `url:${url}`,
        discoveredAt: '2026-09-14T00:00:00.000Z',
      })),
    })
    await repository.close()
    service = createServiceApp({ dataRoot })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const response = await fetch(
      `http://${address.host}:${address.port}/api/contents`
    )
    const items = (
      (await response.json()) as {
        items: Array<{
          url: string
          junk: { isJunk: boolean; source: string; note?: string }
        }>
      }
    ).items
    const byUrl = Object.fromEntries(items.map(({ url, junk }) => [url, junk]))
    expect(byUrl).toEqual({
      [urls[0]!]: {
        isJunk: true,
        source: 'rule',
        reason: 'other',
        note: '活动页：活动报名与介绍，不是文章正文',
      },
      [urls[1]!]: {
        isJunk: true,
        source: 'rule',
        reason: 'other',
        note: '目录页：插件列表，不是单篇文章',
      },
      [urls[2]!]: {
        isJunk: true,
        source: 'rule',
        reason: 'other',
        note: '互动页：播放器与操作界面，不是文章正文',
      },
      [urls[3]!]: { isJunk: false, source: 'none' },
    })
  })

  it('starts on loopback and exposes only a minimal health response', async () => {
    service = createServiceApp({ dataRoot })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const response = await fetch(
      `http://${address.host}:${address.port}/health`,
      { headers: { origin: 'http://localhost:5173' } }
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:5173'
    )
    expect(await response.json()).toEqual({
      service: 'qiushui-airadar',
      status: 'ready',
    })
  })

  it('does not expose unknown routes', async () => {
    service = createServiceApp({ dataRoot })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const response = await fetch(
      `http://${address.host}:${address.port}/secrets`
    )

    expect(response.status).toBe(404)
  })

  it('serves the built Web app and keeps API routes separate', async () => {
    const webRoot = path.join(dataRoot, 'web')
    await mkdir(path.join(webRoot, 'assets'), { recursive: true })
    await writeFile(
      path.join(webRoot, 'index.html'),
      '<!doctype html><title>qiushui-airadar installed</title>'
    )
    await writeFile(
      path.join(webRoot, 'assets', 'app.js'),
      'window.qiushui-airadar=1'
    )
    service = createServiceApp({ dataRoot, webRoot })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const origin = `http://${address.host}:${address.port}`

    const page = await fetch(`${origin}/daily`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('qiushui-airadar installed')

    const asset = await fetch(`${origin}/assets/app.js`)
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    expect(await asset.text()).toBe('window.qiushui-airadar=1')

    const api = await fetch(`${origin}/api/missing`)
    expect(api.status).toBe(404)
    expect(await api.json()).toEqual({ error: 'not_found' })
  })

  it('rejects cross-site and non-JSON mutation requests', async () => {
    service = createServiceApp({ dataRoot })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const target = `http://${address.host}:${address.port}/api/config/versions`
    expect(
      (
        await fetch(target, {
          method: 'POST',
          headers: {
            origin: 'https://evil.example',
            'content-type': 'application/json',
          },
          body: '{}',
        })
      ).status
    ).toBe(403)
    expect((await fetch(target, { method: 'POST', body: '{}' })).status).toBe(
      415
    )
  })

  it('allows an explicitly trusted LAN or Tailscale Web origin', async () => {
    process.env.QIUSHUI_AIRADAR_WEB_ORIGINS =
      'http://192.168.3.108:5173,https://qiushui-airadar.example.ts.net'
    try {
      service = createServiceApp({ dataRoot })
      const address = await service.start({ host: '127.0.0.1', port: 0 })
      const response = await fetch(
        `http://${address.host}:${address.port}/api/config/preview`,
        {
          method: 'POST',
          headers: {
            origin: 'http://192.168.3.108:5173',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            scope: { level: 'global' },
            values: {},
          }),
        }
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe(
        'http://192.168.3.108:5173'
      )
    } finally {
      delete process.env.QIUSHUI_AIRADAR_WEB_ORIGINS
    }
  })

  it('serves all analyzed content and a filtered daily feed from real records', async () => {
    const repository = await RuntimeRepository.open(dataRoot)
    await repository.commitDiscoveryBatch({
      sourceId: 'rss',
      nextCursor: '2',
      contents: [
        {
          id: 'content-core',
          title: 'Core item',
          body: 'Complete body',
          canonicalUrl: 'https://example.com/core',
          enrichmentStatus: 'succeeded',
          kind: 'image_post',
          images: [
            { order: 0, url: 'https://media.example/core.webp' },
            { order: 1, url: 'file:///tmp/private.png' },
          ],
          quotedPost: {
            url: 'https://x.com/i/status/2',
            authorName: 'Author',
            text: 'Complete quote',
            images: [{ order: 0, url: 'https://media.example/quote.jpg' }],
          },
        },
        {
          id: 'content-none',
          title: 'Other item',
          body: 'Complete body',
          canonicalUrl: 'https://example.com/other',
          enrichmentStatus: 'succeeded',
        },
      ],
      discoveries: [
        {
          id: 'discovery-core',
          sourceId: 'rss',
          contentId: 'content-core',
          discoveredAt: '2026-09-14T00:00:00.000Z',
        },
        {
          id: 'discovery-none',
          sourceId: 'rss',
          contentId: 'content-none',
          discoveredAt: '2026-09-14T00:00:01.000Z',
        },
      ],
    })
    for (const [id, recommendation] of [
      ['content-core', 'core'],
      ['content-none', 'none'],
    ] as const) {
      await repository.saveAnalysis({
        id: `analysis-${id}`,
        contentId: id,
        fingerprint: `fingerprint-${id}`,
        version: 1,
        manual: false,
        provider: 'test',
        model: 'test-model',
        promptVersion: 'prompt-1',
        profileVersionId: 'profile-1',
        ruleVersion: 'rules-1',
        createdAt: '2026-09-14T01:00:00.000Z',
        durationMs: 1,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        },
        result: {
          summary: `${id} summary`,
          topics: ['AI'],
          totalScore: recommendation === 'core' ? 90 : 20,
          recommendation,
          spam: { isSpam: false },
        },
      })
    }
    const initiallyExcluded = repository.listAnalyses('content-none')[0]!
    await repository.saveAnalysis({
      ...initiallyExcluded,
      id: 'analysis-content-none-promoted',
      fingerprint: 'fingerprint-content-none-promoted',
      version: 2,
      manual: true,
      createdAt: '2026-09-15T01:00:00.000Z',
      result: {
        ...initiallyExcluded.result,
        totalScore: 90,
        recommendation: 'core',
      },
    })
    await repository.close()

    service = createServiceApp({ dataRoot })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const base = `http://${address.host}:${address.port}`
    const all = (await (await fetch(`${base}/api/contents`)).json()) as {
      items: Array<{
        id: string
        kind?: string
        firstInflowAt?: string
        images?: Array<{ order?: number; url: string }>
        quotedPost?: { text: string; images: Array<{ url: string }> }
      }>
    }
    const daily = (await (await fetch(`${base}/api/daily`)).json()) as {
      items: Array<{ id: string }>
    }
    expect(all.items.map((item) => item.id).sort()).toEqual([
      'content-core',
      'content-none',
    ])
    expect(all.items.find((item) => item.id === 'content-core')?.kind).toBe(
      'image_post'
    )
    expect(
      all.items.find((item) => item.id === 'content-core')?.images
    ).toEqual([{ order: 0, url: 'https://media.example/core.webp' }])
    expect(
      all.items.find((item) => item.id === 'content-core')?.quotedPost
    ).toMatchObject({
      text: 'Complete quote',
      images: [{ url: 'https://media.example/quote.jpg' }],
    })
    expect(daily.items.map((item) => item.id).sort()).toEqual([
      'content-core',
      'content-none',
    ])
    expect(
      all.items.find((item) => item.id === 'content-none')?.firstInflowAt
    ).toBe('2026-09-15T01:00:00.000Z')
  })

  it('imports only X, YouTube, and RSS source configurations and masks secrets', async () => {
    process.env.TIKHUB_API_KEY = 'test-secret-value'
    try {
      service = createServiceApp({ dataRoot })
      const address = await service.start({ host: '127.0.0.1', port: 0 })
      const base = `http://${address.host}:${address.port}`
      const sources = (await (await fetch(`${base}/api/sources`)).json()) as {
        items: Array<{ type: string; status: string }>
      }
      expect(sources.items).toHaveLength(33)
      expect(
        Object.fromEntries(
          ['x', 'youtube', 'rss'].map((type) => [
            type,
            sources.items.filter(
              (source) => source.type === type && source.status === 'enabled'
            ).length,
          ])
        )
      ).toEqual({
        x: 1,
        youtube: 1,
        rss: 1,
      })
      const providers = (await (
        await fetch(`${base}/api/providers`)
      ).json()) as {
        items: Array<{
          id: string
          secretStatus?: { configured: boolean; maskedValue?: string }
        }>
      }
      const tikHub = providers.items.find(
        (provider) => provider.id === 'tikhub-x'
      )
      expect(tikHub?.secretStatus).toMatchObject({ configured: true })
      expect(JSON.stringify(providers)).not.toContain('test-secret-value')
      expect(tikHub?.secretStatus?.maskedValue).toContain('•')
    } finally {
      delete process.env.TIKHUB_API_KEY
    }
  })

  it('removes former Chinese-platform source configs on startup but keeps their content', async () => {
    const repository = await RuntimeRepository.open(dataRoot)
    await repository.importSources([
      {
        id: 'douyin_qinghua_jiang',
        slug: 'douyin_qinghua_jiang',
        name: '抖音 / 清华姜学长',
        type: 'douyin',
        externalIdentity: 'former-author',
        status: 'enabled',
      },
    ])
    await repository.commitDiscoveryBatch({
      sourceId: 'douyin_qinghua_jiang',
      contents: [
        {
          id: 'douyin:retained',
          title: '保留历史内容',
          body: '',
          sourceId: 'douyin_qinghua_jiang',
          enrichmentStatus: 'waiting-manual-transcription',
        },
      ],
      discoveries: [],
    })
    await repository.close()

    service = createServiceApp({ dataRoot })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const base = `http://${address.host}:${address.port}`
    const sources = (await (await fetch(`${base}/api/sources`)).json()) as {
      items: Array<{ id: string }>
    }
    const contents = (await (await fetch(`${base}/api/contents`)).json()) as {
      items: Array<{ id: string; source?: { name: string } }>
    }
    expect(
      sources.items.some((source) => source.id === 'douyin_qinghua_jiang')
    ).toBe(false)
    expect(contents.items).toContainEqual(
      expect.objectContaining({
        id: 'douyin:retained',
        source: expect.objectContaining({ name: '抖音 / 清华姜学长' }),
      })
    )
  })

  it('persists read, utilization and junk operations and removes junk from daily immediately', async () => {
    const repository = await RuntimeRepository.open(dataRoot)
    await repository.commitDiscoveryBatch({
      sourceId: 'x_openai',
      contents: [
        {
          id: 'x:persistent-item',
          title: 'Persistent item',
          body: 'Complete body',
          canonicalUrl: 'https://x.com/OpenAI/status/persistent-item',
          enrichmentStatus: 'succeeded',
          kind: 'short_post',
        },
      ],
      discoveries: [
        {
          id: 'x_openai:persistent-item',
          sourceId: 'x_openai',
          contentId: 'x:persistent-item',
          discoveredAt: '2026-09-14T00:00:00.000Z',
        },
      ],
    })
    await repository.saveAnalysis({
      id: 'analysis-persistent-item',
      contentId: 'x:persistent-item',
      fingerprint: 'fingerprint-persistent-item',
      version: 1,
      manual: false,
      provider: 'test',
      model: 'test-model',
      promptVersion: 'prompt-1',
      profileVersionId: 'profile-1',
      ruleVersion: 'rules-1',
      createdAt: '2026-09-14T01:00:00.000Z',
      durationMs: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
      result: {
        summary: 'summary',
        chineseTranslation: '这是一条已翻译的英文帖子。',
        topics: ['AI'],
        totalScore: 90,
        recommendation: 'core',
        spam: { isSpam: false },
      },
    })
    await repository.close()

    service = createServiceApp({ dataRoot })
    let address = await service.start({ host: '127.0.0.1', port: 0 })
    let base = `http://${address.host}:${address.port}`
    const mutate = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect(
      (
        await mutate('/api/contents/x%3Apersistent-item/read', {
          read: true,
        })
      ).status
    ).toBe(200)
    await mutate('/api/contents/x%3Apersistent-item/actions', {
      actions: ['favorite', 'project'],
    })
    await mutate('/api/contents/x%3Apersistent-item/junk', {
      isJunk: true,
      reason: 'advertising',
    })
    expect(
      (
        (await (await fetch(`${base}/api/daily`)).json()) as {
          items: unknown[]
        }
      ).items
    ).toEqual([])
    await mutate('/api/contents/x%3Apersistent-item/junk', { isJunk: false })
    await service.stop()
    service = undefined

    service = createServiceApp({ dataRoot })
    address = await service.start({ host: '127.0.0.1', port: 0 })
    base = `http://${address.host}:${address.port}`
    const item = (
      (await (await fetch(`${base}/api/contents`)).json()) as {
        items: Array<{
          id: string
          originalLanguage: string
          chineseTranslation?: string
          translatedToChinese: boolean
          read: boolean
          utilizationActions: string[]
          junk: { isJunk: boolean; source: string }
        }>
      }
    ).items[0]
    expect(item).toMatchObject({
      id: 'x:persistent-item',
      originalLanguage: 'en',
      chineseTranslation: '这是一条已翻译的英文帖子。',
      translatedToChinese: true,
      read: true,
      utilizationActions: [],
      junk: { isJunk: false, source: 'manual' },
    })
  })

  it('previews, versions and rolls back three-level configuration while fixed rules stay read-only', async () => {
    service = createServiceApp({ dataRoot })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const base = `http://${address.host}:${address.port}`
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const initial = (await (await fetch(`${base}/api/config`)).json()) as {
      fixedRules: string[]
      versions: Array<{ id: string }>
    }
    expect(initial.fixedRules).toContain('平台内容身份不可修改')
    const preview = (await (
      await post('/api/config/preview', {
        scope: { level: 'sourceType', sourceType: 'x' },
        values: { collection: { batchLimit: 50 } },
      })
    ).json()) as { affectedSources: number }
    expect(preview.affectedSources).toBe(16)
    expect(
      (
        await post('/api/config/versions', {
          scope: { level: 'sourceType', sourceType: 'x' },
          values: { collection: { batchLimit: 50 } },
          description: 'X 覆盖',
        })
      ).status
    ).toBe(201)
    const inherited = (await (
      await post('/api/config/preview', {
        scope: { level: 'sourceType', sourceType: 'x' },
        values: {},
      })
    ).json()) as {
      before: { collection: { batchLimit: number } }
      after: { collection: { batchLimit: number } }
    }
    expect(inherited.before.collection.batchLimit).toBe(50)
    expect(inherited.after.collection.batchLimit).toBe(100)
    const saved = await post('/api/config/versions', {
      scope: { level: 'global' },
      values: { collection: { batchLimit: 50 } },
      description: '批量上限调整',
    })
    expect(saved.status).toBe(201)
    const rollback = await post('/api/config/rollback', {
      versionId: initial.versions[0]?.id,
    })
    expect(rollback.status).toBe(201)
    const after = (await (await fetch(`${base}/api/config`)).json()) as {
      versions: Array<{ description: string }>
    }
    expect(after.versions[0]?.description).toContain('回退到')
    const rejectedSecret = await post('/api/config/versions', {
      scope: { level: 'global' },
      values: { apiKey: 'must-not-persist' },
    })
    expect(rejectedSecret.status).toBe(400)
    expect(JSON.stringify(await rejectedSecret.json())).not.toContain(
      'must-not-persist'
    )
    expect(
      (
        await post('/api/config/versions', {
          scope: { level: 'global' },
          values: { storage: { rawResponseRetentionDays: -1 } },
        })
      ).status
    ).toBe(400)
    expect(
      (
        await post('/api/config/preview', {
          scope: { level: 'global' },
          values: {
            scoring: {
              weights: {
                topicMatch: 1,
                substance: 1,
                credibility: 1,
                novelty: 1,
                actionability: 1,
                workValue: 1,
                clarity: 1,
              },
              coreThreshold: 80,
              exploreThreshold: 60,
            },
          },
        })
      ).status
    ).toBe(400)
    expect(
      (
        await post('/api/config/versions', {
          scope: { level: 'sourceType', sourceType: 'x' },
          values: { scoring: { coreThreshold: 70 } },
        })
      ).status
    ).toBe(201)
    expect(
      (
        await post('/api/config/versions', {
          scope: { level: 'global' },
          values: { scoring: { exploreThreshold: 75 } },
        })
      ).status
    ).toBe(400)
    expect(
      (
        await post('/api/config/versions', {
          scope: { level: 'global' },
          values: { collection: { schedule: '61 * * * *' } },
        })
      ).status
    ).toBe(400)
  })

  it('resumes pending tasks on startup and wakes future retries', async () => {
    const feedServer = createServer((_request, response) => {
      response.setHeader('content-type', 'application/rss+xml')
      response.end(
        '<rss><channel><title>Feed</title><item><title>Ready</title></item></channel></rss>'
      )
    })
    await new Promise<void>((resolve) =>
      feedServer.listen(0, '127.0.0.1', resolve)
    )
    const address = feedServer.address()
    if (!address || typeof address === 'string') throw new Error('No feed port')
    try {
      const repository = await RuntimeRepository.open(dataRoot)
      await repository.importSources([
        {
          id: 'rss-worker-test',
          slug: 'rss-worker-test',
          name: 'Worker feed',
          type: 'rss',
          externalIdentity: `http://127.0.0.1:${address.port}/feed.xml`,
          status: 'enabled',
          sortOrder: 999,
        },
      ])
      await repository.enqueueTask({
        id: 'future-preview',
        type: 'discover',
        sourceId: 'rss-worker-test',
        sourceType: 'rss',
        idempotencyKey: 'future-preview',
        payload: { preview: true },
        availableAt: new Date(Date.now() + 30).toISOString(),
      })
      await repository.close()
      service = createServiceApp({
        dataRoot,
        executeTasks: true,
        taskIntervalMs: 10,
      })
      await service.start({ host: '127.0.0.1', port: 0 })
      await new Promise((resolve) => setTimeout(resolve, 120))
      await service.stop()
      service = undefined
      const reopened = await RuntimeRepository.open(dataRoot)
      expect((await reopened.getTask('future-preview'))?.status).toBe(
        'succeeded'
      )
      await reopened.close()
    } finally {
      await new Promise<void>((resolve, reject) =>
        feedServer.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('enqueues source test-fetch and safe batch retries without exposing bulk delete', async () => {
    const repository = await RuntimeRepository.open(dataRoot)
    await repository.commitDiscoveryBatch({
      sourceId: 'x_openai',
      contents: [
        {
          id: 'x:failed-item',
          title: 'Failed item',
          body: '',
          enrichmentStatus: 'failed',
          enrichmentError: 'temporary',
        },
      ],
      discoveries: [
        {
          id: 'x_openai:failed-item',
          sourceId: 'x_openai',
          contentId: 'x:failed-item',
          discoveredAt: '2026-09-14T00:00:00.000Z',
        },
      ],
    })
    await repository.close()
    service = createServiceApp({ dataRoot })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const base = `http://${address.host}:${address.port}`
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await post('/api/sources/x_openai/test-fetch', {})).status).toBe(
      202
    )
    expect(
      (
        await post('/api/contents/batch', {
          ids: ['x:failed-item'],
          operation: 'retry',
        })
      ).status
    ).toBe(200)
    expect(
      (await fetch(`${base}/api/contents/batch`, { method: 'DELETE' })).status
    ).toBe(405)
    const runtime = (await (await fetch(`${base}/api/runtime`)).json()) as {
      tasks: Array<{ type: string }>
    }
    expect(runtime.tasks.map((task) => task.type).sort()).toEqual([
      'discover',
      'enrich',
    ])
  })

  it('shows a pending content as failed when its enrichment task is exhausted', async () => {
    const repository = await RuntimeRepository.open(dataRoot)
    await repository.commitDiscoveryBatch({
      sourceId: 'x_openai',
      contents: [
        {
          id: 'x:exhausted',
          title: 'Exhausted enrichment',
          body: '',
          enrichmentStatus: 'pending',
        },
      ],
      discoveries: [
        {
          id: 'x_openai:exhausted',
          sourceId: 'x_openai',
          contentId: 'x:exhausted',
          discoveredAt: '2026-09-14T00:00:00.000Z',
        },
      ],
    })
    await repository.enqueueTask({
      id: 'enrich-exhausted',
      type: 'enrich',
      sourceId: 'x_openai',
      sourceType: 'x',
      idempotencyKey: 'enrich-exhausted',
      payload: { contentId: 'x:exhausted' },
      maxAttempts: 1,
    })
    await repository.claimNextTask('test-worker')
    await repository.failTask('enrich-exhausted', 'provider unavailable')
    await repository.close()

    service = createServiceApp({ dataRoot })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const payload = (await (
      await fetch(`http://${address.host}:${address.port}/api/contents`)
    ).json()) as { items: Array<{ id: string; processStatus: string }> }
    expect(
      payload.items.find((item) => item.id === 'x:exhausted')?.processStatus
    ).toBe('failed')
  })
})
