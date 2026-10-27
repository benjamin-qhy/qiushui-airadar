import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { request } from 'node:http'

import { expect, it } from 'vitest'

import { initializeSingleTableConfig } from '@qiushui-airadar/config'
import { SingleTableRepository } from '@qiushui-airadar/runtime'

import { createSingleTableServiceApp } from './single-table-service.js'

it('accepts a same-origin LAN page while rejecting another site', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'airadar-lan-origin-'))
  let service: ReturnType<typeof createSingleTableServiceApp> | undefined
  try {
    const configRoot = await initializeSingleTableConfig(
      path.resolve(import.meta.dirname, '../../../config'),
      root
    )
    service = createSingleTableServiceApp({ dataRoot: root, configRoot })
    const address = await service.start({ host: '0.0.0.0', port: 0 })
    const target = `http://127.0.0.1:${address.port}/api/collection/pause`
    const headers = {
      host: `192.168.3.108:${address.port}`,
      origin: `http://192.168.3.108:${address.port}`,
      'content-type': 'application/json',
    }
    const body = JSON.stringify({ scope: { level: 'global' }, values: {} })
    const post = (origin: string) =>
      new Promise<number>((resolve, reject) => {
        const outgoing = request(
          target,
          { method: 'POST', headers: { ...headers, origin } },
          (response) => {
            response.resume()
            response.on('end', () => resolve(response.statusCode ?? 0))
          }
        )
        outgoing.on('error', reject)
        outgoing.end(body)
      })
    expect(await post(headers.origin)).toBe(409)
    expect(await post('https://evil.example')).toBe(403)
  } finally {
    await service?.stop()
    await rm(root, { recursive: true, force: true })
  }
})

it('starts one manual translation for completed English content and rejects retry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'airadar-manual-translate-'))
  let service: ReturnType<typeof createSingleTableServiceApp> | undefined
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    const configRoot = await initializeSingleTableConfig(
      path.resolve(import.meta.dirname, '../../../config'),
      root
    )
    const repository = await SingleTableRepository.open(root)
    const row = await repository.saveOriginal({
      platform: 'youtube',
      sourceType: 'youtube',
      sourceAccountId: 'yt_test',
      sourceAccountName: 'Test',
      externalContentId: 'long-video',
      title: 'Long video',
      originalTitle: 'Long video',
      body: 'Complete English transcript.',
      kind: 'video',
      format: 'subtitle',
      language: 'en',
      videoDurationSeconds: 2_000,
    })
    await repository.saveClassification(row.id, {
      keywords: ['视频'],
      isJunk: false,
      summary: '视频总结。',
    })
    await repository.saveScoring(
      row.id,
      '测试价值。',
      {
        interest_fit: { level: 1, reason: '测试' },
        concrete_gain: { level: 1, reason: '测试' },
        substance: { level: 1, reason: '测试' },
        new_information: { level: 1, reason: '测试' },
      },
      {
        weights: {
          interest_fit: 40,
          concrete_gain: 30,
          substance: 20,
          new_information: 10,
        },
        coreThreshold: 80,
        exploreThreshold: 60,
        coreMinLevels: {},
        exploreMinLevels: {},
      }
    )
    repository.setTranslationSkipped(row.id, 'video_duration_limit')
    repository.close()
    service = createSingleTableServiceApp({
      dataRoot: root,
      configRoot,
      gateway: {
        getCapacity() {
          return {
            contextWindow: 32_000,
            maxOutputTokens: 16_000,
            provider: 'mock',
            model: 'mock',
          }
        },
        async complete() {
          await wait
          return {
            text: JSON.stringify({
              chineseTitle: '长视频',
              chineseBody: '完整中文译文。',
            }),
            provider: 'mock',
            model: 'mock',
            durationMs: 1,
          }
        },
      },
    })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const base = `http://${address.host}:${address.port}`
    const accepted = await fetch(`${base}/api/contents/${row.id}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(accepted.status).toBe(202)
    expect(
      (
        await fetch(`${base}/api/contents/${row.id}/translate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status
    ).toBe(409)
    expect(
      (
        await fetch(`${base}/api/contents/${row.id}/retry`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status
    ).toBe(409)
    release()
    let item: Record<string, unknown> | undefined
    for (let attempt = 0; attempt < 50; attempt++) {
      const listResponse = await fetch(`${base}/api/contents`)
      if (!listResponse.ok)
        throw new Error(
          `Content polling failed: ${listResponse.status} ${await listResponse.text()}`
        )
      const payload = (await listResponse.json()) as {
        items: Array<Record<string, unknown>>
      }
      item = payload.items.find((candidate) => candidate.id === row.id)
      if (item?.translationStatus === 'succeeded') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(item).toMatchObject({
      translatedToChinese: true,
      translationStatus: 'succeeded',
      chineseTranslation: '完整中文译文。',
    })
  } finally {
    release()
    await service?.stop()
    await rm(root, { recursive: true, force: true })
  }
})

it('reclassifies a previously failed X plugin directory on retry without fetching it', async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), 'qiushui-airadar-directory-retry-')
  )
  let service: ReturnType<typeof createSingleTableServiceApp> | undefined
  try {
    const configRoot = await initializeSingleTableConfig(
      path.resolve(import.meta.dirname, '../../../config'),
      root
    )
    const repository = await SingleTableRepository.open(root)
    const row = await repository.recordUnavailable(
      {
        platform: 'x',
        sourceType: 'x',
        sourceAccountId: 'x_openai',
        sourceAccountName: 'OpenAI',
        externalContentId: '2097523484629090408',
        canonicalUrl: 'https://chatgpt.com/plugins?category=small-business',
        title: 'Plugins for small businesses',
        originalTitle: 'Plugins for small businesses',
        kind: 'article',
        format: 'plain_text',
        language: 'en',
      },
      'Could not extract a complete article body'
    )
    repository.close()
    service = createSingleTableServiceApp({ dataRoot: root, configRoot })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const response = await fetch(
      `http://${address.host}:${address.port}/api/contents/${row.id}/retry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }
    )
    expect(response.status).toBe(200)
    expect((await response.json()) as unknown).toMatchObject({
      item: {
        junk: {
          isJunk: true,
          source: 'rule',
          reason: '目录页：插件列表，不是单篇文章',
        },
      },
    })
  } finally {
    await service?.stop()
    await rm(root, { recursive: true, force: true })
  }
})

it('serves and updates content from the single table, with field-only keyword search', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qiushui-airadar-single-api-'))
  let service: ReturnType<typeof createSingleTableServiceApp> | undefined
  try {
    const configRoot = await initializeSingleTableConfig(
      path.resolve(import.meta.dirname, '../../../config'),
      root
    )
    const repository = await SingleTableRepository.open(root)
    const row = await repository.saveOriginal({
      platform: 'x',
      sourceType: 'x',
      sourceAccountId: 'x_openai',
      sourceAccountName: 'OpenAI',
      externalContentId: 'api-test',
      title: 'English post',
      body: 'An AI agent workflow.',
      kind: 'short_post',
      format: 'plain_text',
      language: 'en',
    })
    await repository.saveClassification(row.id, {
      keywords: ['智能体'],
      isJunk: false,
    })
    await repository.appendLog(row.id, {
      action: 'classify',
      stage: 'classifying',
      status: 'succeeded',
      durationMs: 12,
      request: { prompt: '测试', apiKey: 'private-secret' },
      response: { result: '智能体' },
    })
    repository.close()
    service = createSingleTableServiceApp({ dataRoot: root, configRoot })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const base = `http://${address.host}:${address.port}`
    const found = (await fetch(
      `${base}/api/contents?keyword=${encodeURIComponent('智能体')}`
    ).then((response) => response.json())) as {
      items: Array<Record<string, unknown>>
    }
    expect(found.items).toHaveLength(1)
    expect(found.items[0]).toMatchObject({
      id: row.id,
      keywordsText: '智能体',
      totalScore: null,
      externalContentId: 'api-test',
      originalFormat: 'plain_text',
      processStage: 'scoring',
    })
    const logs = (await fetch(`${base}/api/contents/${row.id}/logs`).then(
      (response) => response.json()
    )) as { items: Array<{ index: number; action: string; request?: string }> }
    expect(logs.items[0]).toMatchObject({ action: 'classify' })
    expect(logs.items[0]).not.toHaveProperty('request')
    const logDetail = (await fetch(
      `${base}/api/contents/${row.id}/logs?entry=${logs.items[0]!.index}`
    ).then((response) => response.json())) as {
      item: { request: string; response: string }
    }
    expect(logDetail.item.request).toContain('[REDACTED]')
    expect(logDetail.item.request).not.toContain('private-secret')
    expect(logDetail.item.response).toContain('智能体')
    const runtimeLogs = (await fetch(`${base}/api/runtime/logs`).then(
      (response) => response.json()
    )) as {
      items: Array<{
        contentId?: string
        contentTitle?: string
        message: string
        request?: string
      }>
      total: number
    }
    expect(runtimeLogs.total).toBeGreaterThan(0)
    expect(runtimeLogs.items[0]).toMatchObject({
      contentId: row.id,
      contentTitle: 'English post',
      message: '已完成内容判断',
    })
    expect(runtimeLogs.items[0]).not.toHaveProperty('request')
    const detailedLog = path.join(root, row.execution_log_markdown_path)
    const offlineLog = `${detailedLog}.offline`
    await rename(detailedLog, offlineLog)
    const summariesWithoutDetails = await fetch(`${base}/api/runtime/logs`)
    expect(summariesWithoutDetails.status).toBe(200)
    expect(
      ((await summariesWithoutDetails.json()) as { items: unknown[] }).items
    ).not.toHaveLength(0)
    await rename(offlineLog, detailedLog)
    expect(
      (await fetch(`${base}/api/contents/${row.id}/logs?entry=-1`)).status
    ).toBe(404)
    expect((await fetch(`${base}/api/contents/not-found/logs`)).status).toBe(
      404
    )
    const absent = (await fetch(`${base}/api/contents?keyword=不存在`).then(
      (response) => response.json()
    )) as { items: unknown[] }
    expect(absent.items).toHaveLength(0)
    const changed = await fetch(`${base}/api/contents/${row.id}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ read: true }),
    })
    expect(changed.status).toBe(200)
    expect(
      ((await changed.json()) as { item: { read: boolean } }).item.read
    ).toBe(true)
    const runtime = (await fetch(`${base}/api/runtime`).then((response) =>
      response.json()
    )) as {
      mode: string
      total: number
      recent: unknown[]
    }
    expect(runtime).toMatchObject({ mode: 'single-table', total: 1 })
    expect(runtime.recent).toHaveLength(1)
    const config = (await fetch(`${base}/api/config`).then((response) =>
      response.json()
    )) as {
      mode: string
      files: Array<{ name: string; content: string }>
    }
    expect(config.mode).toBe('file')
    expect(config.files.map((file) => file.name)).toContain('analysis.yaml')
    expect(config.files.map((file) => file.name)).not.toContain('sources.yaml')
    expect(JSON.stringify(config)).not.toContain('TIKHUB_API_KEY')
    const providers = (await fetch(`${base}/api/providers`).then((response) =>
      response.json()
    )) as {
      items: Array<{
        id: string
        health: { state: string }
        secretStatus?: { configured: boolean }
      }>
    }
    const nativeRss = providers.items.find(
      (provider) => provider.id === 'native-rss'
    )
    expect(nativeRss).toMatchObject({ health: { state: 'healthy' } })
    expect(nativeRss).not.toHaveProperty('secretStatus')
    const toggled = await fetch(`${base}/api/sources/x_openai/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    })
    expect(toggled.status).toBe(200)
    const sources = (await fetch(`${base}/api/sources`).then((response) =>
      response.json()
    )) as {
      items: Array<{ id: string; status: string }>
    }
    expect(
      sources.items.find((source) => source.id === 'x_openai')?.status
    ).toBe('disabled')
  } finally {
    await service?.stop()
    await rm(root, { recursive: true })
  }
})

it('only reruns a failed row after an explicit manual retry request', async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), 'qiushui-airadar-manual-retry-')
  )
  let service: ReturnType<typeof createSingleTableServiceApp> | undefined
  try {
    const configRoot = await initializeSingleTableConfig(
      path.resolve(import.meta.dirname, '../../../config'),
      root
    )
    const repository = await SingleTableRepository.open(root)
    const row = await repository.saveOriginal({
      platform: 'x',
      sourceType: 'x',
      sourceAccountId: 'x_openai',
      sourceAccountName: 'OpenAI',
      externalContentId: 'retry-test',
      title: 'Failed English post',
      body: 'An AI agent workflow.',
      kind: 'short_post',
      format: 'plain_text',
      language: 'en',
    })
    repository.fail(row.id, 'classify', new Error('Previous model failure'))
    repository.close()
    let calls = 0
    service = createSingleTableServiceApp({
      dataRoot: root,
      configRoot,
      gateway: {
        async complete() {
          calls++
          return {
            text: '---\nkeywords: ["智能体"]\nspam:\n  isJunk: true\n  reason: "低价值"\n---',
            provider: 'mock',
            model: 'mock',
            durationMs: 1,
          }
        },
      },
    })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const retry = await fetch(
      `http://${address.host}:${address.port}/api/contents/${row.id}/retry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }
    )
    expect(retry.status).toBe(200)
    expect(calls).toBe(1)
    const repeated = await fetch(
      `http://${address.host}:${address.port}/api/contents/${row.id}/retry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }
    )
    expect(repeated.status).toBe(409)
    const log = await readFile(
      path.join(root, row.execution_log_markdown_path),
      'utf8'
    )
    expect(log).toContain('manual-retry')
  } finally {
    await service?.stop()
    await rm(root, { recursive: true })
  }
})

it('processes a waiting video from a supplied transcript without rediscovering it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'airadar-video-transcript-'))
  let service: ReturnType<typeof createSingleTableServiceApp> | undefined
  try {
    const configRoot = await initializeSingleTableConfig(
      path.resolve(import.meta.dirname, '../../../config'),
      root
    )
    const repository = await SingleTableRepository.open(root)
    const row = await repository.recordUnavailable(
      {
        platform: 'x',
        sourceType: 'x',
        sourceAccountId: 'x_openai',
        sourceAccountName: 'OpenAI',
        externalContentId: 'waiting-video',
        title: 'Waiting video',
        kind: 'video',
        format: 'subtitle',
        language: 'en',
      },
      'Video captions provider is unavailable',
      true
    )
    repository.close()
    service = createSingleTableServiceApp({
      dataRoot: root,
      configRoot,
      gateway: {
        async complete() {
          return {
            text: '---\nkeywords: ["视频"]\nspam:\n  isJunk: true\n  reason: "低价值"\n---\n完整视频摘要，记录视频内容与可核对的细节。',
            provider: 'mock',
            model: 'mock',
            durationMs: 1,
          }
        },
      },
    })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const response = await fetch(
      `http://${address.host}:${address.port}/api/contents/${row.id}/retry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          transcript:
            'The complete spoken content of this video is available here.',
        }),
      }
    )
    const reopened = await SingleTableRepository.open(root)
    expect(
      response.status,
      String(reopened.getById(row.id)?.last_error ?? '')
    ).toBe(200)
    expect(reopened.getById(row.id)?.process_status).toBe('completed')
    expect(await reopened.readBody(row.id, 'en')).toContain('spoken content')
    reopened.close()
  } finally {
    await service?.stop()
    await rm(root, { recursive: true })
  }
})

it('retries model-failed rows in a persisted batch without reprocessing success', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'airadar-model-batch-'))
  let service: ReturnType<typeof createSingleTableServiceApp> | undefined
  try {
    const configRoot = await initializeSingleTableConfig(
      path.resolve(import.meta.dirname, '../../../config'),
      root
    )
    const repository = await SingleTableRepository.open(root)
    const row = await repository.saveOriginal({
      platform: 'x',
      sourceType: 'x',
      sourceAccountId: 'x_openai',
      sourceAccountName: 'OpenAI',
      externalContentId: 'batch-test',
      title: 'Failed post',
      body: 'An AI agent workflow.',
      kind: 'short_post',
      format: 'plain_text',
      language: 'en',
    })
    repository.fail(row.id, 'classify', new Error('Previous model failure'))
    repository.close()
    let calls = 0
    service = createSingleTableServiceApp({
      dataRoot: root,
      configRoot,
      gateway: {
        async complete() {
          calls++
          return {
            text: '---\nkeywords: ["智能体"]\nspam:\n  isJunk: true\n  reason: "低价值"\n---',
            provider: 'mock',
            model: 'mock',
            durationMs: 1,
          }
        },
      },
    })
    const { port } = await service.start({ host: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${port}`
    const started = await fetch(`${base}/api/model-retry/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(started.status).toBe(202)
    let batch: { status: string; succeeded: number } | null = null
    for (let attempt = 0; attempt < 50; attempt++) {
      batch = (
        (await fetch(`${base}/api/model-retry`).then((response) =>
          response.json()
        )) as { batch: { status: string; succeeded: number } | null }
      ).batch
      if (batch?.status === 'completed') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(batch).toMatchObject({ status: 'completed', succeeded: 1 })
    expect(calls).toBe(1)
    expect(
      (
        (await fetch(`${base}/api/model-retry/preview`).then((response) =>
          response.json()
        )) as { count: number }
      ).count
    ).toBe(0)
  } finally {
    await service?.stop()
    await rm(root, { recursive: true, force: true })
  }
})

it('manages sources, provider credentials, connection tests, and validated YAML', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qiushui-airadar-management-'))
  let service: ReturnType<typeof createSingleTableServiceApp> | undefined
  const modelConnectionTests: Array<{
    providerId: string
    modelId: string
  }> = []
  try {
    const configRoot = await initializeSingleTableConfig(
      path.resolve(import.meta.dirname, '../../../config'),
      root
    )
    service = createSingleTableServiceApp({
      dataRoot: root,
      configRoot,
      providerFetch: async () =>
        new Response(
          '<rss><channel><title>Feed</title><item><guid>one</guid><title>Item one</title><link>https://example.com/one</link></item></channel></rss>',
          { headers: { 'content-type': 'application/xml' } }
        ),
      modelConnectionTest: async (providerId, modelId) => {
        modelConnectionTests.push({ providerId, modelId })
        return { status: 'succeeded', message: 'connected' }
      },
    })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const base = `http://${address.host}:${address.port}`
    const mutate = (pathname: string, method: string, body: unknown) =>
      fetch(`${base}${pathname}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    const created = await mutate('/api/sources', 'POST', {
      id: 'rss_management_test',
      type: 'rss',
      name: '管理测试',
      externalIdentity: 'https://example.com/feed.xml',
      language: 'zh',
      enabled: true,
    })
    expect(created.status).toBe(201)
    const updated = await mutate('/api/sources/rss_management_test', 'PUT', {
      type: 'rss',
      name: '管理测试已修改',
      externalIdentity: 'https://example.com/updated.xml',
      language: 'zh',
      enabled: false,
    })
    expect(updated.status).toBe(200)
    expect(
      (
        (await fetch(`${base}/api/sources`).then((response) =>
          response.json()
        )) as { items: Array<{ id: string; name: string; status: string }> }
      ).items.find((source) => source.id === 'rss_management_test')
    ).toMatchObject({ name: '管理测试已修改', status: 'disabled' })

    const providerTest = await mutate(
      '/api/providers/native-rss/test',
      'POST',
      {}
    )
    expect(providerTest.status).toBe(200)
    expect(await providerTest.json()).toMatchObject({
      status: 'succeeded',
      providerId: 'native-rss',
    })
    const providerSave = await mutate('/api/providers/tikhub-x', 'PUT', {
      secret: 'test-provider-secret',
    })
    expect(providerSave.status).toBe(200)
    const routeSave = await mutate('/api/provider-routes/x_list', 'PUT', {
      providers: ['tikhub-x', 'twitterapi.io'],
    })
    expect(routeSave.status).toBe(200)
    expect(await routeSave.json()).toMatchObject({
      saved: 'x_list',
      providers: ['tikhub-x', 'twitterapi.io'],
    })
    const providers = await fetch(`${base}/api/providers`).then((response) =>
      response.text()
    )
    expect(providers).not.toContain('test-provider-secret')
    expect(JSON.parse(providers)).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: 'tikhub-x',
          secretStatus: { configured: true },
        }),
      ]),
      routes: expect.arrayContaining([
        expect.objectContaining({
          id: 'x_list',
          providers: ['tikhub-x', 'twitterapi.io'],
          availableProviders: ['twitterapi.io', 'tikhub-x'],
        }),
      ]),
    })
    const invalidInteractionRoute = await mutate(
      '/api/provider-routes/interaction',
      'PUT',
      { providers: ['twitterapi.io'] }
    )
    expect(invalidInteractionRoute.status).toBe(404)
    const models = (await fetch(`${base}/api/models`).then((response) =>
      response.json()
    )) as {
      defaultModel: string
      availableModels: Array<{ id: string }>
    }
    expect(models.defaultModel).toBe('gpt-5.5')
    expect(models.availableModels.map((model) => model.id)).toContain(
      'gpt-5.6-terra'
    )
    const modelSave = await mutate('/api/models', 'PUT', {
      defaultModel: 'gpt-5.5',
      stages: {
        score: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      },
    })
    expect(modelSave.status).toBe(409)
    expect(
      (
        await mutate('/api/models', 'PUT', {
          defaultModel: 'not-a-real-model',
          stages: {},
        })
      ).status
    ).toBe(400)
    const codexAuthPath = path.join(root, 'codex-auth.json')
    const accessToken = `header.${Buffer.from(
      JSON.stringify({ exp: 4_102_444_800 })
    ).toString('base64url')}.signature`
    await writeFile(
      codexAuthPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: accessToken,
          refresh_token: 'test-refresh-token',
        },
      })
    )
    const modelProviderSave = await mutate(
      '/api/model-providers/openai-codex',
      'PUT',
      { authPath: codexAuthPath }
    )
    expect(modelProviderSave.status).toBe(200)
    const providersAfterCodex = (await fetch(
      `${base}/api/model-providers`
    ).then((response) => response.json())) as {
      items: Array<Record<string, unknown>>
    }
    expect(providersAfterCodex.items).toHaveLength(40)
    expect(
      providersAfterCodex.items.find(
        (provider) => provider.id === 'openai-codex'
      )
    ).toMatchObject({
      id: 'openai-codex',
      name: 'OpenAI Codex',
      configured: false,
      pending: true,
      authPath: codexAuthPath,
      usesDefaultPath: false,
    })
    expect(
      (await fetch(`${base}/api/models`).then((response) =>
        response.json()
      )) as unknown
    ).toMatchObject({
      availableModelGroups: [],
    })
    expect(
      (await mutate('/api/model-providers/openai-codex/test', 'POST', {}))
        .status
    ).toBe(200)
    expect(modelConnectionTests).toEqual([
      { providerId: 'openai-codex', modelId: 'gpt-5.5' },
    ])
    expect(
      (
        await mutate('/api/model-providers/openai', 'PUT', {
          apiKey: 'test-api-key',
        })
      ).status
    ).toBe(200)
    expect(
      (
        await mutate('/api/model-providers/deepseek', 'PUT', {
          apiKey: 'test-deepseek-key',
        })
      ).status
    ).toBe(200)
    expect(
      (
        await mutate('/api/model-providers/deepseek/test', 'POST', {
          modelId: 'deepseek-v4-pro',
        })
      ).status
    ).toBe(200)
    expect(
      (
        await mutate('/api/models', 'PUT', {
          defaultModel: 'gpt-5.5',
          stages: { score: { provider: 'deepseek', model: 'deepseek-v4-pro' } },
        })
      ).status
    ).toBe(200)
    const providerPayload = JSON.stringify(
      await fetch(`${base}/api/model-providers`).then((response) =>
        response.json()
      )
    )
    expect(providerPayload).not.toContain('test-api-key')
    expect(providerPayload).toContain('"id":"openai"')
    expect(providerPayload).toContain('"pending":true')
    if (process.platform !== 'win32')
      expect(
        (await stat(path.join(root, 'model-auth.json'))).mode & 0o077
      ).toBe(0)

    const runtimeFile = path.join(configRoot, 'runtime.yaml')
    const runtimeBefore = await readFile(runtimeFile, 'utf8')
    const invalid = await mutate('/api/config/files/runtime.yaml', 'PUT', {
      content: 'timezone: invalid\n',
    })
    expect(invalid.status).toBe(400)
    expect(await readFile(runtimeFile, 'utf8')).toBe(runtimeBefore)
    const valid = await mutate('/api/config/files/runtime.yaml', 'PUT', {
      content: runtimeBefore.replace('max_retries: 2', 'max_retries: 3'),
    })
    expect(valid.status).toBe(200)
    expect(
      (
        await mutate('/api/config/files/sources.yaml', 'PUT', {
          content: await readFile(
            path.join(configRoot, 'sources.yaml'),
            'utf8'
          ),
        })
      ).status
    ).toBe(404)

    const deleted = await mutate(
      '/api/sources/rss_management_test',
      'DELETE',
      {}
    )
    expect(deleted.status).toBe(200)
    expect(
      await readFile(path.join(configRoot, 'sources.yaml'), 'utf8')
    ).not.toContain('rss_management_test')
  } finally {
    await service?.stop()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps a new API key pending until its model responds and excludes non-model failures from retry preview', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'airadar-model-validation-'))
  let service: ReturnType<typeof createSingleTableServiceApp> | undefined
  let connected = false
  try {
    const configRoot = await initializeSingleTableConfig(
      path.resolve(import.meta.dirname, '../../../config'),
      root
    )
    const repository = await SingleTableRepository.open(root)
    const baseRow = {
      platform: 'x',
      sourceType: 'x',
      sourceAccountId: 'test',
      sourceAccountName: 'Test',
      title: 'Test',
      kind: 'short_post' as const,
      format: 'plain_text' as const,
      language: 'zh' as const,
    }
    await repository.recordUnavailable(
      { ...baseRow, externalContentId: 'model-error' },
      'HTTP 401 invalid API key'
    )
    await repository.recordUnavailable(
      { ...baseRow, externalContentId: 'caption-error' },
      '字幕服务不可用'
    )
    repository.close()
    service = createSingleTableServiceApp({
      dataRoot: root,
      configRoot,
      promptsRoot: 'unused',
      modelConnectionTest: async () => {
        if (!connected) throw new Error('unauthorized')
        return { status: 'succeeded', message: 'OK' }
      },
    })
    const { port } = await service.start({ host: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${port}`
    const postJson = (url: string, method: string, body: object) =>
      fetch(`${base}${url}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect(
      (
        await postJson('/api/model-providers/deepseek', 'PUT', {
          apiKey: 'invalid-key',
        })
      ).status
    ).toBe(200)
    expect(
      (
        await postJson('/api/model-providers/deepseek/test', 'POST', {
          modelId: 'deepseek-v4-pro',
        })
      ).status
    ).toBe(400)
    const providersBefore = (await fetch(`${base}/api/model-providers`).then(
      (response) => response.json()
    )) as {
      items: Array<{ id: string; configured: boolean; pending: boolean }>
    }
    expect(
      providersBefore.items.find((item) => item.id === 'deepseek')
    ).toMatchObject({ configured: false, pending: true })
    connected = true
    expect(
      (
        await postJson('/api/model-providers/deepseek/test', 'POST', {
          modelId: 'deepseek-v4-pro',
        })
      ).status
    ).toBe(200)
    const providersAfter = (await fetch(`${base}/api/model-providers`).then(
      (response) => response.json()
    )) as {
      items: Array<{
        id: string
        configured: boolean
        pending: boolean
        verified: boolean
      }>
    }
    expect(
      providersAfter.items.find((item) => item.id === 'deepseek')
    ).toMatchObject({ configured: true, pending: false, verified: true })
    connected = false
    expect(
      (
        await postJson('/api/model-providers/deepseek', 'PUT', {
          apiKey: 'replacement-that-fails',
        })
      ).status
    ).toBe(200)
    expect(
      (
        await postJson('/api/model-providers/deepseek/test', 'POST', {
          modelId: 'deepseek-v4-pro',
        })
      ).status
    ).toBe(400)
    const activeCredentials = await readFile(
      path.join(root, 'model-auth.json'),
      'utf8'
    )
    expect(activeCredentials).toContain('invalid-key')
    expect(activeCredentials).not.toContain('replacement-that-fails')
    const preview = (await fetch(`${base}/api/model-retry/preview`).then(
      (response) => response.json()
    )) as { count: number }
    expect(preview.count).toBe(1)
    await writeFile(
      path.join(root, 'model-retry-batch.json'),
      JSON.stringify({
        id: 'previous-batch',
        status: 'running',
        ids: ['one', 'two'],
        cursor: 1,
        succeeded: 1,
        failed: 0,
      })
    )
    const recoveredBatch = (await fetch(`${base}/api/model-retry`).then(
      (response) => response.json()
    )) as { batch: { status: string; cursor: number } }
    expect(recoveredBatch.batch).toMatchObject({ status: 'paused', cursor: 1 })
    const start = await postJson('/api/collection/start', 'POST', {})
    expect(start.status).toBe(409)
    expect(await start.json()).toMatchObject({
      error: 'model_preflight_failed',
    })
  } finally {
    await service?.stop()
    await rm(root, { recursive: true, force: true })
  }
})
