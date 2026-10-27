import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { beginCollectionRun, readCollectionRun } from './collection-run.js'
import {
  collectSingleTable,
  createCollectionControl,
} from './collect-single-table.js'
import { createSingleTableServiceApp } from './single-table-service.js'

it('starts asynchronously via HTTP, prevents duplicate starts and reports final progress', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'airadar-manual-'))
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { initializeSingleTableConfig } =
    await import('@qiushui-airadar/config')
  const configRoot = await initializeSingleTableConfig(
    path.resolve(import.meta.dirname, '../../../config'),
    root
  )
  const service = createSingleTableServiceApp({
    dataRoot: root,
    configRoot,
    promptsRoot: 'unused',
    gateway: {
      complete: async () => {
        throw new Error('unexpected model call')
      },
    },
    collectionProvider: {
      discover: async () => {
        await gate
        return { items: [], request: {}, response: {} }
      },
      resolve: async () => {
        throw new Error('unexpected resolve')
      },
    },
  })
  try {
    const { port } = await service.start({ host: '127.0.0.1', port: 0 })
    const url = `http://127.0.0.1:${port}`
    expect(
      (
        await fetch(url + '/api/collection/start', {
          method: 'POST',
          headers: { origin: 'https://example.com' },
        })
      ).status
    ).toBe(403)
    expect(
      (await fetch(url + '/api/collection/start', { method: 'POST' })).status
    ).toBe(202)
    expect(
      (await fetch(url + '/api/collection/start', { method: 'POST' })).status
    ).toBe(409)
    expect(
      (await (await fetch(url + '/api/runtime')).json()).collection.status
    ).toBe('running')
    release()
    await service.stop()
    expect((await readCollectionRun(root))?.status).toBe('completed')
    expect(
      (await readCollectionRun(root))?.sources.every(
        (source) => source.status === 'completed'
      )
    ).toBe(true)
  } finally {
    release()
    await service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

it('pauses at a safe checkpoint and resumes the same collection', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'airadar-pause-resume-'))
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const discovered: string[] = []
  const { initializeSingleTableConfig } =
    await import('@qiushui-airadar/config')
  const configRoot = await initializeSingleTableConfig(
    path.resolve(import.meta.dirname, '../../../config'),
    root
  )
  await writeFile(
    path.join(configRoot, 'sources.yaml'),
    'sources:\n  - {id: first, platform: x, account_name: First, external_identity: first, language: en, enabled: true}\n  - {id: second, platform: x, account_name: Second, external_identity: second, language: en, enabled: true}\n'
  )
  const service = createSingleTableServiceApp({
    dataRoot: root,
    configRoot,
    promptsRoot: 'unused',
    gateway: {
      complete: async () => {
        throw new Error('unexpected model call')
      },
    },
    collectionProvider: {
      discover: async (source) => {
        discovered.push(source.id)
        if (source.id === 'first') await firstGate
        return { items: [], request: {}, response: {} }
      },
      resolve: async () => {
        throw new Error('unexpected resolve')
      },
    },
  })
  try {
    const { port } = await service.start({ host: '127.0.0.1', port: 0 })
    const url = `http://127.0.0.1:${port}`
    expect(
      (await fetch(url + '/api/collection/start', { method: 'POST' })).status
    ).toBe(202)
    expect(
      (await fetch(url + '/api/collection/pause', { method: 'POST' })).status
    ).toBe(200)
    expect(
      (await (await fetch(url + '/api/runtime')).json()).collection.status
    ).toBe('paused')
    releaseFirst()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(discovered).not.toContain('second')
    expect(
      (await fetch(url + '/api/collection/resume', { method: 'POST' })).status
    ).toBe(200)
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await readCollectionRun(root))?.status === 'completed') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const run = await readCollectionRun(root)
    expect(run?.status).toBe('completed')
    expect(discovered).toEqual(['first', 'second'])
    expect(run?.events.map((event) => event.action)).toEqual(
      expect.arrayContaining(['collection-paused', 'collection-resumed'])
    )
  } finally {
    releaseFirst()
    await service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

it('persists progress, rejects overlapping runs and detects an exited owner', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'airadar-run-'))
  try {
    expect(await readCollectionRun(root)).toBeNull()
    const first = await beginCollectionRun(root)
    await first.save()
    expect((await readCollectionRun(root))?.status).toBe('running')
    await expect(beginCollectionRun(root)).rejects.toThrow('已有采集任务')
    first.run.pid = 2147483647
    await first.save()
    expect((await readCollectionRun(root))?.status).toBe('interrupted')
    await first.release()
    const next = await beginCollectionRun(root)
    await next.release()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('continues an interrupted collection with its original run id', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'airadar-continued-run-'))
  const { initializeSingleTableConfig } =
    await import('@qiushui-airadar/config')
  const configRoot = await initializeSingleTableConfig(
    path.resolve(import.meta.dirname, '../../../config'),
    root
  )
  const previous = await beginCollectionRun(root)
  const id = previous.run.id
  previous.run.pid = 2147483647
  await previous.save()
  await previous.release()
  const service = createSingleTableServiceApp({
    dataRoot: root,
    configRoot,
    promptsRoot: 'unused',
    gateway: {
      complete: async () => {
        throw new Error('unexpected model call')
      },
    },
    collectionProvider: {
      discover: async () => ({ items: [], request: {}, response: {} }),
      resolve: async () => {
        throw new Error('unexpected resolve')
      },
    },
  })
  try {
    const { port } = await service.start({ host: '127.0.0.1', port: 0 })
    const url = `http://127.0.0.1:${port}`
    expect(
      (await fetch(`${url}/api/collection/resume`, { method: 'POST' })).status
    ).toBe(202)
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await readCollectionRun(root))?.status === 'completed') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const run = await readCollectionRun(root)
    expect(run?.status).toBe('completed')
    expect(run?.id).toBe(id)
  } finally {
    await service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

it('pauses the entire run when a model rejects authentication', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'airadar-model-pause-'))
  const { initializeSingleTableConfig } =
    await import('@qiushui-airadar/config')
  const configRoot = await initializeSingleTableConfig(
    path.resolve(import.meta.dirname, '../../../config'),
    root
  )
  await writeFile(
    path.join(configRoot, 'sources.yaml'),
    'sources:\n  - {id: test, platform: x, account_name: Test, external_identity: test, language: zh, enabled: true}\n'
  )
  const control = createCollectionControl()
  const task = collectSingleTable({
    dataRoot: root,
    templateRoot: configRoot,
    promptsRoot: path.resolve(
      import.meta.dirname,
      '../../../docs/prompts/single-table-content'
    ),
    control,
    gateway: {
      getCapacity: () => ({
        contextWindow: 32000,
        maxOutputTokens: 8000,
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      }),
      complete: async () => {
        throw new Error('HTTP 401 invalid API key')
      },
    },
    provider: {
      discover: async () => ({
        items: [{ externalId: 'item', title: '测试', kind: 'short_post' }],
        request: {},
        response: {},
      }),
      resolve: async () => ({
        original: {
          platform: 'x',
          sourceType: 'x',
          sourceAccountId: 'test',
          sourceAccountName: 'Test',
          externalContentId: 'item',
          title: '测试',
          body: '测试内容',
          kind: 'short_post',
          format: 'plain_text',
          language: 'zh',
        },
      }),
    },
  })
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await readCollectionRun(root))?.status === 'paused') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const run = await readCollectionRun(root)
    expect(run?.status).toBe('paused')
    expect(run?.message).toContain('认证失败')
    expect(run?.message).toContain('deepseek')
  } finally {
    control.interrupt()
    await task.catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

it('tracks real collector source completion and failures without stopping remaining sources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'airadar-collection-'))
  try {
    const { initializeSingleTableConfig } =
      await import('@qiushui-airadar/config')
    const config = await initializeSingleTableConfig(
      path.resolve(import.meta.dirname, '../../../config'),
      root
    )
    await writeFile(
      path.join(config, 'sources.yaml'),
      'sources:\n  - {id: first, platform: x, account_name: First, external_identity: first, language: en, enabled: true}\n  - {id: second, platform: x, account_name: Second, external_identity: second, language: en, enabled: true}\n'
    )
    await collectSingleTable({
      dataRoot: root,
      templateRoot: config,
      promptsRoot: '',
      gateway: {
        complete: async () => {
          throw new Error('unexpected model call')
        },
      },
      provider: {
        discover: async (source) => {
          if (source.id === 'first') throw new Error('unavailable')
          return { items: [], request: {}, response: {} }
        },
        resolve: async () => {
          throw new Error('unexpected resolution')
        },
      },
    })
    const run = await readCollectionRun(root)
    expect(run?.status).toBe('completed')
    expect(
      run?.sources.map((source) => [source.status, source.failed])
    ).toEqual([
      ['completed', 1],
      ['completed', 0],
    ])
    expect(run?.events.map((event) => event.action)).toEqual([
      'collection-started',
      'source-started',
      'source-completed',
      'source-started',
      'source-completed',
      'collection-completed',
    ])
    const next = await beginCollectionRun(root)
    await next.release()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
