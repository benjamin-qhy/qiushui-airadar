import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import {
  atomicWriteFile,
  runPendingTasks,
  RuntimeRepository,
  type RuntimeTask,
} from './index.js'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'qiushui-airadar-runtime-'))
  roots.push(root)
  return root
}

async function forceKillAtActiveStage(
  root: string,
  type: 'write' | RuntimeTask['type']
): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      path.join(import.meta.dirname, 'crash-fixture.ts'),
      root,
      type,
    ],
    { cwd: path.resolve(import.meta.dirname, '../../..') }
  )
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.stderr.on('data', (chunk) => reject(new Error(String(chunk))))
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('active')) resolve()
    })
  })
  child.kill('SIGKILL')
  await once(child, 'exit')
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  )
})

describe('atomic Markdown storage', () => {
  it('keeps the previous complete file if interrupted before replacement', async () => {
    const root = await temporaryRoot()
    const target = path.join(root, 'content.md')
    await writeFile(target, 'old complete value')

    await expect(
      atomicWriteFile(target, 'new partial value', {
        beforeRename() {
          throw new Error('forced interruption')
        },
      })
    ).rejects.toThrow('forced interruption')

    expect(await readFile(target, 'utf8')).toBe('old complete value')
    expect((await stat(target)).isFile()).toBe(true)
  })

  it('removes its temporary file if interrupted during writing', async () => {
    const root = await temporaryRoot()
    const target = path.join(root, 'content.md')
    await expect(
      atomicWriteFile(target, 'partial value', {
        beforeSync() {
          throw new Error('write interrupted')
        },
      })
    ).rejects.toThrow('write interrupted')
    expect(await readdir(root)).toEqual([])
  })

  it('keeps the old authority file when the writer process is force-killed', async () => {
    const root = await temporaryRoot()
    await forceKillAtActiveStage(root, 'write')
    expect(await readFile(path.join(root, 'interrupted.md'), 'utf8')).toBe(
      'old complete value'
    )
  })
})

describe('deterministic runtime repository', () => {
  it('persists immutable provider attempts and append-only interaction snapshots', async () => {
    const root = await temporaryRoot()
    let repository = await RuntimeRepository.open(root)
    await repository.saveProviderAttempt({
      id: 'attempt-1',
      providerId: 'twitterapi.io',
      sourceId: 'x-openai',
      startedAt: '2026-09-14T08:00:00.000Z',
      finishedAt: '2026-09-14T08:00:01.000Z',
      durationMs: 1_000,
      status: 'failed',
      itemCount: 0,
      errorClass: 'credential',
      error: 'Authorization: Bearer private-value',
    })
    await repository.saveInteractionSnapshot({
      id: 'snapshot-1',
      contentId: 'youtube:dQw4w9WgXcQ',
      sourceId: 'youtube-openai',
      providerId: 'youtube-data-api',
      capturedAt: '2026-09-14T08:00:02.000Z',
      views: 100,
      likes: 9,
      comments: 2,
      shares: null,
      saves: null,
    })
    await repository.saveProviderHealth({
      providerId: 'twitterapi.io',
      state: 'manual-recovery',
      errorClass: 'credential',
    })
    await repository.close()

    repository = await RuntimeRepository.open(root)
    expect(repository.listProviderAttempts('x-openai')).toMatchObject([
      { id: 'attempt-1', error: 'Authorization: [REDACTED]' },
    ])
    expect(
      repository.listInteractionSnapshots('youtube:dQw4w9WgXcQ')
    ).toMatchObject([{ id: 'snapshot-1', views: 100, shares: null }])
    expect(repository.getProviderHealth('twitterapi.io')).toMatchObject({
      state: 'manual-recovery',
      errorClass: 'credential',
    })
    await expect(
      repository.saveInteractionSnapshot({
        id: 'snapshot-1',
        contentId: 'youtube:dQw4w9WgXcQ',
        sourceId: 'youtube-openai',
        providerId: 'youtube-data-api',
        capturedAt: '2026-09-14T08:00:03.000Z',
        views: 101,
        likes: 9,
        comments: 2,
        shares: null,
        saves: null,
      })
    ).rejects.toThrow('immutable')
    await repository.close()
  })

  it('uses WAL and rebuilds its disposable SQLite index from Markdown', async () => {
    const root = await temporaryRoot()
    const repository = await RuntimeRepository.open(root)
    expect(repository.journalMode()).toBe('wal')
    await repository.enqueueTask({
      id: 'task-1',
      type: 'discover',
      sourceId: 'source-1',
      idempotencyKey: 'discover:source-1:2026-09-14',
    })
    await repository.close()

    await rm(path.join(root, '.index', 'runtime.sqlite'))
    const rebuilt = await RuntimeRepository.open(root)
    expect((await rebuilt.getTask('task-1'))?.status).toBe('pending')
    expect(rebuilt.indexedTaskCount()).toBe(1)
    await rebuilt.close()
  })

  it('recreates a corrupt SQLite file without changing Markdown authority', async () => {
    const root = await temporaryRoot()
    let repository = await RuntimeRepository.open(root)
    await repository.enqueueTask({
      id: 'task-survives-corruption',
      type: 'discover',
      sourceId: 'source-corruption',
      idempotencyKey: 'task-survives-corruption',
    })
    await repository.close()
    await writeFile(path.join(root, '.index', 'runtime.sqlite'), 'not sqlite')

    repository = await RuntimeRepository.open(root)
    expect((await repository.getTask('task-survives-corruption'))?.status).toBe(
      'pending'
    )
    await repository.close()
  })

  it('rejects a second live service for the same data root', async () => {
    const root = await temporaryRoot()
    const repository = await RuntimeRepository.open(root)
    await expect(RuntimeRepository.open(root)).rejects.toThrow(
      /already in use/i
    )
    await repository.close()
    const reopened = await RuntimeRepository.open(root)
    await reopened.close()
  })

  it('requires source identity for discovery tasks', async () => {
    const root = await temporaryRoot()
    const repository = await RuntimeRepository.open(root)
    await expect(
      repository.enqueueTask({
        id: 'missing-source',
        type: 'discover',
        idempotencyKey: 'missing-source',
      })
    ).rejects.toThrow(/source id/i)
    await repository.close()
  })

  it('deduplicates enqueue, enforces one running task per source, and recovers interruption', async () => {
    const root = await temporaryRoot()
    let repository = await RuntimeRepository.open(root)
    const input = {
      id: 'discover-a',
      type: 'discover' as const,
      sourceId: 'source-a',
      idempotencyKey: 'discover:source-a:1',
    }
    expect((await repository.enqueueTask(input)).id).toBe('discover-a')
    expect(
      (await repository.enqueueTask({ ...input, id: 'duplicate-id' })).id
    ).toBe('discover-a')
    await repository.enqueueTask({
      id: 'enrich-a',
      type: 'enrich',
      sourceId: 'source-a',
      idempotencyKey: 'enrich:source-a:content-1',
    })
    await repository.enqueueTask({
      id: 'discover-b',
      type: 'discover',
      sourceId: 'source-b',
      idempotencyKey: 'discover:source-b:1',
    })

    expect((await repository.claimNextTask('worker-1'))?.id).toBe('discover-a')
    expect((await repository.claimNextTask('worker-2'))?.id).toBe('discover-b')
    expect(await repository.claimNextTask('worker-3')).toBeUndefined()
    await repository.close()

    repository = await RuntimeRepository.open(root)
    expect((await repository.getTask('discover-a'))?.status).toBe('pending')
    expect((await repository.getTask('discover-b'))?.status).toBe('pending')
    expect(repository.activeSourceLockCount()).toBe(0)
    await repository.close()
  })

  it('limits automatic attempts to three and preserves every error', async () => {
    const root = await temporaryRoot()
    const repository = await RuntimeRepository.open(root)
    await repository.enqueueTask({
      id: 'task-retry',
      type: 'enrich',
      sourceId: 'source-1',
      idempotencyKey: 'enrich:source-1:content-1',
    })

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const task = await repository.claimNextTask(`worker-${attempt}`)
      expect(task?.attempt).toBe(attempt)
      await repository.failTask('task-retry', `failure-${attempt}`, {
        retryAt: '2000-01-01T00:00:00.000Z',
      })
    }

    const failed = await repository.getTask('task-retry')
    expect(failed?.status).toBe('failed')
    expect(failed?.errors.map((error) => error.message)).toEqual([
      'failure-1',
      'failure-2',
      'failure-3',
    ])
    expect(await repository.claimNextTask('worker-4')).toBeUndefined()
    await repository.close()
  })

  it.each(['discover', 'enrich', 'analyze'] as const)(
    'recovers a force-killed %s stage without losing or skipping its task',
    async (type) => {
      const root = await temporaryRoot()
      await forceKillAtActiveStage(root, type)

      const repository = await RuntimeRepository.open(root)
      const recovered = await repository.claimNextTask('worker-after-restart')
      expect(recovered?.id).toBe(`${type}-killed`)
      expect(recovered?.attempt).toBe(2)
      await repository.completeTask(recovered!.id)
      expect((await repository.getTask(recovered!.id))?.status).toBe(
        'succeeded'
      )
      expect(repository.indexedTaskCount()).toBe(1)
      await repository.close()
    }
  )

  it('serializes concurrent idempotent enqueue without orphan Markdown', async () => {
    const root = await temporaryRoot()
    let repository = await RuntimeRepository.open(root)
    const tasks = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        repository.enqueueTask({
          id: `concurrent-${index}`,
          type: 'analyze',
          idempotencyKey: 'same-work',
        })
      )
    )
    expect(new Set(tasks.map((task) => task.id))).toEqual(
      new Set(['concurrent-0'])
    )
    await repository.close()

    repository = await RuntimeRepository.open(root)
    expect(repository.indexedTaskCount()).toBe(1)
    await repository.close()
  })

  it('keeps parameter versions and audits immutable under concurrent writes', async () => {
    const root = await temporaryRoot()
    const repository = await RuntimeRepository.open(root)
    const parameterResults = await Promise.allSettled(
      ['first', 'second'].map((description) =>
        repository.saveParameterVersion({
          id: 'same-parameter-version',
          scope: { level: 'global' },
          description,
          values: { batchSize: description === 'first' ? 10 : 20 },
        })
      )
    )
    expect(
      parameterResults.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1)

    const baseAudit = {
      id: 'same-audit',
      sourceId: 'source-1',
      providerId: 'provider-1',
      startedAt: '2026-09-14T00:00:00.000Z',
      finishedAt: '2026-09-14T00:00:01.000Z',
      failed: 0,
      cursorBefore: 'cursor-1',
      cursorAfter: 'cursor-2',
      retries: 0,
    }
    const auditResults = await Promise.allSettled([
      repository.saveAudit({ ...baseAudit, succeeded: 1 }),
      repository.saveAudit({ ...baseAudit, succeeded: 2 }),
    ])
    expect(
      auditResults.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1)
    await repository.close()
  })

  it('keeps case-sensitive ids distinct on Windows-safe hashed paths', async () => {
    const root = await temporaryRoot()
    let repository = await RuntimeRepository.open(root)
    await repository.enqueueTask({
      id: 'Task-Case',
      type: 'analyze',
      idempotencyKey: 'upper-case',
    })
    await repository.enqueueTask({
      id: 'task-case',
      type: 'analyze',
      idempotencyKey: 'lower-case',
    })
    await repository.close()

    repository = await RuntimeRepository.open(root)
    expect(repository.indexedTaskCount()).toBe(2)
    await repository.close()
  })

  it('caps worker parallelism while allowing independent sources to proceed', async () => {
    const root = await temporaryRoot()
    const repository = await RuntimeRepository.open(root)
    for (let index = 1; index <= 4; index += 1) {
      await repository.enqueueTask({
        id: `parallel-${index}`,
        type: 'discover',
        sourceId: `source-${index}`,
        idempotencyKey: `parallel-${index}`,
      })
    }
    let active = 0
    let maximumActive = 0
    let releaseBoth!: () => void
    const bothActive = new Promise<void>((resolve) => {
      releaseBoth = resolve
    })
    await runPendingTasks(repository, {
      concurrency: 2,
      workerIdPrefix: 'pool',
      async handler() {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        if (active === 2) releaseBoth()
        await Promise.race([
          bothActive,
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ])
        active -= 1
      },
    })
    expect(maximumActive).toBe(2)
    expect(repository.indexedTaskCount()).toBe(4)
    await repository.close()
  })

  it('resolves global, source-type, and source parameters and freezes them at first start', async () => {
    const root = await temporaryRoot()
    const repository = await RuntimeRepository.open(root)
    await repository.saveParameterVersion({
      id: 'params-global-1',
      scope: { level: 'global' },
      description: 'global defaults',
      values: {
        retry: { limit: 2, delaySeconds: 10 },
        batchSize: 100,
        provider: { token: { secretRef: 'TIKHUB_TOKEN' } },
      },
    })
    await repository.saveParameterVersion({
      id: 'params-youtube-1',
      scope: { level: 'sourceType', sourceType: 'youtube' },
      description: 'youtube defaults',
      values: { retry: { delaySeconds: 20 }, includeShorts: false },
    })
    await repository.saveParameterVersion({
      id: 'params-source-1',
      scope: { level: 'source', sourceId: 'channel-1' },
      description: 'channel override',
      values: { batchSize: 20 },
    })
    await repository.enqueueTask({
      id: 'task-parameters',
      type: 'discover',
      sourceId: 'channel-1',
      sourceType: 'youtube',
      idempotencyKey: 'discover:channel-1:1',
    })

    let task = await repository.claimNextTask('worker-1')
    expect(task?.parameterSnapshot).toEqual({
      retry: { limit: 2, delaySeconds: 20 },
      batchSize: 20,
      includeShorts: false,
      provider: { token: { secretRef: 'TIKHUB_TOKEN' } },
    })
    expect(task?.parameterVersionIds).toEqual([
      'params-global-1',
      'params-youtube-1',
      'params-source-1',
    ])
    await repository.failTask('task-parameters', 'temporary', {
      retryAt: '2000-01-01T00:00:00.000Z',
    })
    await repository.saveParameterVersion({
      id: 'params-source-2',
      scope: { level: 'source', sourceId: 'channel-1' },
      description: 'future tasks only',
      values: { batchSize: 5 },
    })

    task = await repository.claimNextTask('worker-2')
    expect(task?.parameterSnapshot.batchSize).toBe(20)
    expect(task?.parameterVersionIds).not.toContain('params-source-2')
    await expect(
      repository.saveParameterVersion({
        id: 'params-source-2',
        scope: { level: 'source', sourceId: 'channel-1' },
        description: 'attempted overwrite',
        values: { batchSize: 1 },
      })
    ).rejects.toThrow(/immutable/i)
    await repository.close()
  })

  it('freezes an empty parameter snapshot before later versions are created', async () => {
    const root = await temporaryRoot()
    const repository = await RuntimeRepository.open(root)
    await repository.enqueueTask({
      id: 'empty-parameters',
      type: 'analyze',
      idempotencyKey: 'empty-parameters',
    })
    const first = await repository.claimNextTask('worker-1')
    expect(first?.parametersResolved).toBe(true)
    expect(first?.parameterVersionIds).toEqual([])
    await repository.failTask('empty-parameters', 'temporary', {
      retryAt: '2000-01-01T00:00:00.000Z',
    })
    await repository.saveParameterVersion({
      id: 'later-global',
      scope: { level: 'global' },
      description: 'created after task start',
      values: { batchSize: 1 },
    })
    const retried = await repository.claimNextTask('worker-2')
    expect(retried?.parameterVersionIds).toEqual([])
    expect(retried?.parameterSnapshot).toEqual({})
    await repository.close()
  })

  it('advances progress last so interrupted discovery is safe to replay without duplicates', async () => {
    const root = await temporaryRoot()
    const repository = await RuntimeRepository.open(root)
    const batch = {
      sourceId: 'source-1',
      nextCursor: 'cursor-2',
      contents: [
        { id: 'content-1', title: 'Title', body: 'complete source body' },
      ],
      discoveries: [
        {
          id: 'discovery-1',
          sourceId: 'source-1',
          contentId: 'content-1',
          discoveredAt: '2026-09-14T00:00:00.000Z',
        },
      ],
    }

    await expect(
      repository.commitDiscoveryBatch({
        ...batch,
        contents: [{ ...batch.contents[0]!, apiKey: 'must-not-persist' }],
      })
    ).rejects.toThrow(/secret/i)

    await expect(
      repository.commitDiscoveryBatch(batch, {
        beforeProgress() {
          throw new Error('forced interruption')
        },
      })
    ).rejects.toThrow('forced interruption')
    expect(repository.getProgress('source-1')).toBeUndefined()

    await repository.commitDiscoveryBatch(batch)
    await repository.commitDiscoveryBatch({
      ...batch,
      contents: [{ ...batch.contents[0]!, body: 'changed upstream body' }],
    })
    const mediaPath = await repository.saveContentMedia(
      'content-1',
      'cover.jpg',
      new Uint8Array([1, 2, 3])
    )
    expect(repository.getProgress('source-1')?.cursor).toBe('cursor-2')
    expect(repository.indexedContentCount()).toBe(1)
    expect(repository.indexedDiscoveryCount()).toBe(1)
    expect(repository.getContent('content-1')?.body).toBe(
      'complete source body'
    )
    expect(path.dirname(mediaPath)).toBe(
      path.dirname(repository.contentMarkdownPath('content-1'))
    )
    expect([...(await readFile(mediaPath))]).toEqual([1, 2, 3])
    await repository.close()
  })

  it('stores permanent audit evidence and purges expired redacted raw responses', async () => {
    const root = await temporaryRoot()
    const repository = await RuntimeRepository.open(root)
    await repository.saveAudit({
      id: 'audit-1',
      sourceId: 'source-1',
      providerId: 'provider-1',
      startedAt: '2026-09-14T00:00:00.000Z',
      finishedAt: '2026-09-14T00:00:01.000Z',
      succeeded: 1,
      failed: 0,
      cursorBefore: 'cursor-1',
      cursorAfter: 'cursor-2',
      retries: 0,
    })
    const rawPath = await repository.saveRawResponse({
      id: 'raw-1',
      providerId: 'provider-1',
      receivedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-08-31T00:00:00.000Z',
      payload: {
        Authorization: 'Bearer secret',
        data: {
          token: 'secret',
          decode_key: 'media-decryption-material',
          ok: 1,
          message:
            'Authorization: Basic dXNlcjpwYXNz\nCookie: session=cookie-secret',
        },
      },
    })
    const redactedRaw = await readFile(rawPath, 'utf8')
    expect(redactedRaw).not.toContain('secret')
    expect(redactedRaw).not.toContain('dXNlcjpwYXNz')
    expect(redactedRaw).not.toContain('session=')
    expect(redactedRaw).not.toContain('media-decryption-material')
    expect(await repository.getAudit('audit-1')).toMatchObject({ succeeded: 1 })

    expect(
      await repository.purgeExpiredRawResponses('2026-09-14T00:00:00.000Z')
    ).toBe(1)
    await expect(stat(rawPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await repository.close()
  })

  it('never puts secrets into task Markdown or SQLite', async () => {
    const root = await temporaryRoot()
    const repository = await RuntimeRepository.open(root)
    await expect(
      repository.enqueueTask({
        id: 'unsafe',
        type: 'analyze',
        idempotencyKey: 'unsafe',
        payload: { apiKey: 'plaintext' },
      })
    ).rejects.toThrow(/secret/i)
    await repository.close()

    const sqlite = new DatabaseSync(path.join(root, '.index', 'runtime.sqlite'))
    const rows = sqlite.prepare('SELECT payload_json FROM tasks').all()
    expect(JSON.stringify(rows)).not.toContain('plaintext')
    sqlite.close()
  })
})

describe('enriched content and analysis records', () => {
  it('freezes a successful body and rebuilds analysis evidence from Markdown', async () => {
    const root = await temporaryRoot()
    let repository = await RuntimeRepository.open(root)
    await repository.commitDiscoveryBatch({
      sourceId: 'rss-source',
      nextCursor: 'entry-1',
      contents: [
        {
          id: 'content-1',
          title: 'Article',
          body: '',
          canonicalUrl: 'https://example.com/article',
          enrichmentStatus: 'pending',
        },
      ],
      discoveries: [
        {
          id: 'discovery-1',
          sourceId: 'rss-source',
          contentId: 'content-1',
          discoveredAt: '2026-09-14T00:00:00.000Z',
        },
      ],
    })
    const invalidAnalysis = {
      id: 'analysis-invalid',
      contentId: 'content-1',
      fingerprint: 'fingerprint-1',
      version: 1,
      manual: false,
      provider: 'test',
      model: 'test-model',
      promptVersion: 'prompt-1',
      profileVersionId: 'profile-1',
      ruleVersion: 'rules-1',
      createdAt: '2026-09-14T00:01:00.000Z',
      durationMs: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
      result: {},
    }
    await expect(repository.saveAnalysis(invalidAnalysis)).rejects.toThrow(
      /completely enriched/i
    )

    const first = await repository.completeContentEnrichment('content-1', {
      body: 'First complete body',
      canonicalUrl: 'https://example.com/article',
    })
    const frozen = await repository.completeContentEnrichment('content-1', {
      body: 'Replacement body',
      canonicalUrl: 'https://example.com/changed',
    })
    expect(frozen).toEqual(first)

    await repository.commitDiscoveryBatch({
      sourceId: 'rss-source',
      contents: [
        {
          id: 'content-1',
          title: 'Article',
          body: 'A rediscovered excerpt',
          enrichmentStatus: 'succeeded',
          images: [{ order: 0, url: 'https://example.com/photo.jpg' }],
          quotedPost: {
            url: 'https://x.com/i/status/2',
            text: 'A quoted post',
            images: [],
          },
          mergePlatformMetadata: true,
        },
      ],
      discoveries: [],
    })
    expect(repository.getContent('content-1')).toMatchObject({
      body: 'First complete body',
      images: [{ order: 0, url: 'https://example.com/photo.jpg' }],
      quotedPost: { text: 'A quoted post' },
    })

    const analysis = await repository.saveAnalysis({
      ...invalidAnalysis,
      id: 'analysis-1',
      provider: 'openai-codex',
      model: 'gpt-5.3-codex-spark',
      createdAt: '2026-09-14T00:02:00.000Z',
      durationMs: 12,
      result: { recommendation: 'core', totalScore: 80 },
    })
    await repository.saveAnalysisCall({
      id: 'call-1',
      contentId: 'content-1',
      analysisId: analysis.id,
      provider: analysis.provider,
      model: analysis.model,
      startedAt: '2026-09-14T00:01:59.000Z',
      finishedAt: '2026-09-14T00:02:00.000Z',
      durationMs: 12,
      status: 'succeeded',
      usage: analysis.usage,
    })
    await repository.close()

    repository = await RuntimeRepository.open(root)
    expect(
      repository.getAnalysisByFingerprint('content-1', 'fingerprint-1')?.id
    ).toBe('analysis-1')
    expect(repository.nextAnalysisVersion('content-1')).toBe(2)
    expect(repository.listAnalysisCalls('content-1')).toEqual([
      expect.objectContaining({ id: 'call-1', status: 'succeeded' }),
    ])
    await repository.close()
  })
})

describe('cross-platform related content', () => {
  it('links distinct platform records without merging their identities and rebuilds from Markdown', async () => {
    const root = await temporaryRoot()
    let repository = await RuntimeRepository.open(root)
    await repository.commitDiscoveryBatch({
      sourceId: 'cross-platform',
      contents: [
        {
          id: 'douyin:work-1',
          title: 'Douyin upload',
          body: 'douyin transcript',
          enrichmentStatus: 'succeeded',
        },
        {
          id: 'xiaohongshu:work-2',
          title: 'XHS upload',
          body: 'xiaohongshu transcript',
          enrichmentStatus: 'succeeded',
        },
      ],
      discoveries: [
        {
          id: 'cross-platform:douyin',
          sourceId: 'cross-platform',
          contentId: 'douyin:work-1',
          discoveredAt: '2026-09-14T08:00:00.000Z',
        },
        {
          id: 'cross-platform:xhs',
          sourceId: 'cross-platform',
          contentId: 'xiaohongshu:work-2',
          discoveredAt: '2026-09-14T08:00:00.000Z',
        },
      ],
    })
    const relation = await repository.linkRelatedContents({
      id: 'relation-1',
      contentIds: ['douyin:work-1', 'xiaohongshu:work-2'],
      reason: '同一作品的跨平台上传',
      createdAt: '2026-09-14T08:01:00.000Z',
    })
    expect(relation.contentIds).toEqual(['douyin:work-1', 'xiaohongshu:work-2'])
    expect(repository.indexedContentCount()).toBe(2)
    expect(repository.listRelatedContents('douyin:work-1')).toEqual([relation])
    await expect(
      repository.linkRelatedContents({
        id: 'invalid-self',
        contentIds: ['douyin:work-1', 'douyin:work-1'],
        reason: 'invalid',
        createdAt: '2026-09-14T08:01:00.000Z',
      })
    ).rejects.toThrow('distinct')
    await repository.close()

    repository = await RuntimeRepository.open(root)
    expect(repository.listRelatedContents('xiaohongshu:work-2')).toEqual([
      relation,
    ])
    expect(repository.indexedContentCount()).toBe(2)
    await repository.close()
  })
})

describe('Web operations persistence', () => {
  it('removes retired source configurations without deleting historical content', async () => {
    const root = await temporaryRoot()
    let repository = await RuntimeRepository.open(root)
    await repository.importSources([
      {
        id: 'douyin_old',
        slug: 'douyin_old',
        name: 'Old Douyin source',
        type: 'douyin',
        externalIdentity: 'author-id',
        status: 'enabled',
      },
    ])
    await repository.commitDiscoveryBatch({
      sourceId: 'douyin_old',
      contents: [
        {
          id: 'douyin:historical',
          title: 'Historical video',
          body: '',
          enrichmentStatus: 'waiting-manual-transcription',
          sourceId: 'douyin_old',
        },
      ],
      discoveries: [
        {
          id: 'douyin_old:historical',
          sourceId: 'douyin_old',
          contentId: 'douyin:historical',
          discoveredAt: '2026-09-14T08:00:00.000Z',
        },
      ],
    })
    await repository.retireSourceConfigs(['douyin_old'])
    expect(repository.getSource('douyin_old')).toBeUndefined()
    expect(repository.getContent('douyin:historical')).toBeDefined()
    await repository.close()

    repository = await RuntimeRepository.open(root)
    expect(repository.getSource('douyin_old')).toBeUndefined()
    expect(repository.getContent('douyin:historical')).toBeDefined()
    expect(await readdir(path.join(root, 'retired-sources'))).toHaveLength(1)
    await repository.close()
  })

  it('imports source definitions idempotently and persists status changes', async () => {
    const root = await temporaryRoot()
    let repository = await RuntimeRepository.open(root)
    const sources = [
      {
        id: 'x_openai',
        slug: 'x_openai',
        name: 'X / OpenAI',
        type: 'x' as const,
        externalIdentity: 'OpenAI',
        status: 'enabled' as const,
        sortOrder: 0,
      },
      {
        id: 'x_anthropic',
        slug: 'x_anthropic',
        name: 'X / Anthropic',
        type: 'x' as const,
        externalIdentity: 'AnthropicAI',
        status: 'disabled' as const,
        sortOrder: 1,
      },
    ]
    await repository.importSources(sources)
    await repository.importSources(sources)
    expect(repository.listSources()).toEqual(
      sources.map((source) => ({ ...source, language: 'en' }))
    )
    await repository.updateSourceStatus('x_anthropic', 'enabled')
    await repository.close()

    repository = await RuntimeRepository.open(root)
    expect(repository.listSources()).toEqual([
      { ...sources[0], language: 'en' },
      { ...sources[1], language: 'en', status: 'enabled' },
    ])
    await repository.close()
  })

  it('clears utilization actions on junk and never restores them on undo', async () => {
    const root = await temporaryRoot()
    let repository = await RuntimeRepository.open(root)
    await repository.commitDiscoveryBatch({
      sourceId: 'x_openai',
      contents: [
        {
          id: 'x:item-1',
          title: '真实内容',
          body: '完整正文',
          enrichmentStatus: 'succeeded',
        },
      ],
      discoveries: [
        {
          id: 'x_openai:item-1',
          sourceId: 'x_openai',
          contentId: 'x:item-1',
          discoveredAt: '2026-09-14T08:00:00.000Z',
        },
      ],
    })
    await repository.setContentRead('x:item-1', true)
    await repository.setUtilizationActions('x:item-1', [
      'favorite',
      'card',
      'project',
    ])
    await repository.setManualJunk('x:item-1', {
      isJunk: true,
      reason: 'advertising',
      note: '人工确认',
    })
    expect(repository.getContentUserState('x:item-1')).toMatchObject({
      read: true,
      utilizationActions: [],
      manualJunk: { isJunk: true, reason: 'advertising' },
    })
    expect(repository.listJunkSamples('x:item-1')).toMatchObject([
      {
        decision: { isJunk: true, reason: 'advertising' },
        contentSnapshot: { title: '真实内容', body: '完整正文' },
      },
    ])
    await repository.setManualJunk('x:item-1', { isJunk: false })
    await repository.close()

    repository = await RuntimeRepository.open(root)
    expect(repository.getContentUserState('x:item-1')).toMatchObject({
      read: true,
      utilizationActions: [],
      manualJunk: { isJunk: false },
    })
    expect(repository.listJunkSamples('x:item-1')).toHaveLength(2)
    await repository.close()
  })
})

function assertTask(_task: RuntimeTask): void {}
void assertTask
