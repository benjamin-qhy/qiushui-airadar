import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  initializeSingleTableConfig,
  loadSourceState,
  loadSingleTableConfig,
  saveSourceState,
} from '@qiushui-airadar/config'
import { SingleTableRepository } from '@qiushui-airadar/runtime'
import type {
  SingleTableModelGateway,
  SingleTableSourceProvider,
} from '@qiushui-airadar/pipeline'
import {
  collectSingleTable,
  createCollectionControl,
} from './collect-single-table.js'
import { readCollectionHistory, readCollectionRun } from './collection-run.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})
async function fixture(handles = ['first', 'second']) {
  const root = await mkdtemp(path.join(tmpdir(), 'airadar-staged-'))
  roots.push(root)
  const configRoot = await initializeSingleTableConfig(
    path.resolve('config'),
    root
  )
  await writeFile(
    path.join(configRoot, 'sources.yaml'),
    JSON.stringify({
      sources: handles.map((id) => ({
        id,
        platform: 'x',
        account_name: id,
        external_identity: id,
        language: 'en',
        enabled: true,
      })),
    })
  )
  return {
    dataRoot: root,
    templateRoot: configRoot,
    configRoot,
    promptsRoot: path.resolve('docs/prompts/single-table-content'),
  }
}
function model(events: string[]): SingleTableModelGateway {
  return {
    async complete(input) {
      events.push(input.stage)
      await new Promise((resolve) => setTimeout(resolve, 3))
      const interest = input.user.includes('low')
        ? 3
        : input.user.includes('sixty')
          ? 4
          : 3
      const gain =
        input.user.includes('low') || input.user.includes('sixty') ? 3 : 5
      return {
        text:
          input.stage === 'classify'
            ? '---\nkeywords: [测试]\nspam: {isJunk: false, reason: null}\n---\n中文摘要。'
            : input.stage === 'score'
              ? JSON.stringify({
                  valueSummary: '有价值',
                  scores: {
                    interestFit: { level: interest, reason: '兴趣' },
                    concreteGain: { level: gain, reason: '收获' },
                    substance: { level: 3, reason: '扎实' },
                    newInformation: { level: 3, reason: '新信息' },
                  },
                })
              : '{"chineseTitle":null,"chineseBody":"中文\n正文"}',
        provider: 'test',
        model: 'fixture',
        durationMs: 3,
      }
    },
  }
}
function provider(events: string[]): SingleTableSourceProvider {
  return {
    async discover(source) {
      events.push(`scan:${source.id}`)
      return {
        items: ['high', 'sixty', 'low'].map((name) => ({
          externalId: `${source.id}-${name}`,
          title: name,
          body: name,
          kind: 'short_post' as const,
        })),
        request: {},
        response: {},
      }
    },
    async resolve(source, item) {
      return {
        original: {
          platform: 'x',
          sourceType: 'x',
          sourceAccountId: source.id,
          sourceAccountName: source.account_name,
          externalContentId: item.externalId,
          title: item.title!,
          body: item.body!,
          kind: item.kind,
          format: 'plain_text',
          language: 'en',
        },
      }
    },
  }
}

it('runs ten source scans and ten analyses concurrently while using an independent translation limit', async () => {
  const setup = await fixture(
    Array.from({ length: 12 }, (_, index) => `source${index}`)
  )
  const config = await loadSingleTableConfig(setup.configRoot)
  Object.assign(config.runtime.collection, {
    scan_concurrency: 10,
    processing_concurrency: 10,
    translation_concurrency: 2,
  })
  await writeFile(
    path.join(setup.configRoot, 'runtime.yaml'),
    JSON.stringify(config.runtime)
  )
  let scans = 0,
    analyses = 0,
    translations = 0
  let maximumScans = 0,
    maximumAnalyses = 0,
    maximumTranslations = 0
  let releaseScans!: () => void
  let releaseAnalyses!: () => void
  const scanningGate = new Promise<void>((resolve) => {
    releaseScans = resolve
  })
  const analysisGate = new Promise<void>((resolve) => {
    releaseAnalyses = resolve
  })
  const baseProvider = provider([])
  const baseGateway = model([])
  await collectSingleTable({
    ...setup,
    provider: {
      ...baseProvider,
      async discover(source) {
        scans++
        maximumScans = Math.max(maximumScans, scans)
        if (scans === 10) releaseScans()
        await scanningGate
        scans--
        return {
          items: [
            {
              externalId: source.id,
              title: 'high',
              body: 'high',
              kind: 'short_post',
            },
          ],
          request: {},
          response: {},
        }
      },
    },
    gateway: {
      async complete(input) {
        if (input.stage === 'translate') {
          translations++
          maximumTranslations = Math.max(maximumTranslations, translations)
          try {
            await new Promise((resolve) => setTimeout(resolve, 20))
            return await baseGateway.complete(input)
          } finally {
            translations--
          }
        }
        analyses++
        maximumAnalyses = Math.max(maximumAnalyses, analyses)
        if (analyses === 10) releaseAnalyses()
        try {
          await analysisGate
          return await baseGateway.complete(input)
        } finally {
          analyses--
        }
      },
    },
  })
  expect(maximumScans).toBe(10)
  expect(maximumAnalyses).toBe(10)
  expect(maximumTranslations).toBe(2)
  expect((await readCollectionRun(setup.dataRoot))?.translated).toBe(12)
})

it('saves all discoveries before AI, analyzes concurrently, then translates only non-junk scores >=60 irrespective of recommendation', async () => {
  const setup = await fixture()
  const events: string[] = []
  let concurrent = 0
  let maximum = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const gateway = model(events)
  await collectSingleTable({
    ...setup,
    provider: provider(events),
    gateway: {
      async complete(input) {
        concurrent++
        maximum = Math.max(maximum, concurrent)
        if (concurrent === 3) release()
        await gate
        try {
          return await gateway.complete(input)
        } finally {
          concurrent--
        }
      },
    },
  })
  expect(events.slice(0, 2).sort()).toEqual(['scan:first', 'scan:second'])
  expect(
    events
      .slice(0, events.indexOf('translate'))
      .filter((stage) => stage === 'score'),
    JSON.stringify(events)
  ).toHaveLength(6)
  expect(events.filter((stage) => stage === 'translate')).toHaveLength(4)
  expect(maximum).toBe(3)
  const repository = await SingleTableRepository.open(setup.dataRoot)
  try {
    const rows = repository.search({})
    expect(rows).toHaveLength(6)
    expect(
      rows
        .filter((row) => row.title === 'sixty')
        .every(
          (row) =>
            row.total_score === 60 && row.translation_status === 'succeeded'
        )
    ).toBe(true)
    expect(
      rows
        .filter((row) => row.title === 'high')
        .every(
          (row) =>
            row.recommendation === 'none' &&
            row.translation_status === 'succeeded'
        )
    ).toBe(true)
    expect(
      rows
        .filter((row) => row.title === 'low')
        .every((row) => row.translation_status === 'skipped')
    ).toBe(true)
    expect(
      await repository.readBody(
        rows.find((row) => row.title === 'high')!.id,
        'zh'
      )
    ).toBe('中文\n正文')
  } finally {
    repository.close()
  }
  const run = await readCollectionRun(setup.dataRoot)
  expect(run?.phase).toBe('finished')
  expect(run?.translated).toBe(4)
  expect(
    run?.sources.reduce((sum, entry) => sum + (entry.newlyInflow ?? 0), 0)
  ).toBe(6)
  expect((await readCollectionHistory(setup.dataRoot))[0]?.id).toBe(run?.id)
})

it('keeps the time window and next cursor after a page failure and continues without reanalyzing saved posts', async () => {
  const setup = await fixture(['first'])
  const events: string[] = []
  const base = provider(events)
  let fail = true
  const cursors: Array<string | undefined> = []
  const sourceProvider: SingleTableSourceProvider = {
    ...base,
    async discover(source, limit, window) {
      cursors.push(window?.cursor)
      if (window?.cursor === 'page2' && fail)
        throw new Error('temporary list failure')
      if (window?.cursor === 'page2')
        return { items: [], request: {}, response: {} }
      if (cursors.length > 2) return { items: [], request: {}, response: {} }
      return { ...(await base.discover(source, limit)), nextCursor: 'page2' }
    },
  }
  await collectSingleTable({
    ...setup,
    provider: sourceProvider,
    gateway: model(events),
  })
  const state = await loadSourceState(setup.configRoot)
  expect(state.sources.first?.discovered_until).toBeUndefined()
  expect(state.sources.first?.pending_window?.cursor).toBe('page2')
  const previousScores = events.filter((event) => event === 'score').length
  fail = false
  await collectSingleTable({
    ...setup,
    provider: sourceProvider,
    gateway: model(events),
  })
  expect(cursors[2]).toBe('page2')
  expect(events.filter((event) => event === 'score')).toHaveLength(
    previousScores
  )
  expect(
    (await loadSourceState(setup.configRoot)).sources.first?.pending_window
  ).toBeUndefined()
  expect(await readCollectionHistory(setup.dataRoot)).toHaveLength(2)
})

it('resumes the durable analyzed jobs after interruption without rescanning or repeating AI analysis', async () => {
  const setup = await fixture(['first'])
  const events: string[] = []
  const control = createCollectionControl()
  const base = model(events)
  await expect(
    collectSingleTable({
      ...setup,
      control,
      provider: provider(events),
      gateway: {
        async complete(input) {
          const result = await base.complete(input)
          if (input.stage === 'score') control.interrupt()
          return result
        },
      },
    })
  ).rejects.toThrow('COLLECTION_INTERRUPTED')
  const interrupted = await readCollectionRun(setup.dataRoot)
  expect(interrupted?.status).toBe('interrupted')
  const scores = events.filter((event) => event === 'score').length
  const changed = await loadSingleTableConfig(setup.configRoot)
  changed.analysis.translation.minimum_total_score = 80
  await writeFile(
    path.join(setup.configRoot, 'analysis.yaml'),
    JSON.stringify(changed.analysis)
  )
  await collectSingleTable({
    ...setup,
    resume: true,
    provider: provider(events),
    gateway: model(events),
  })
  expect(events.filter((event) => event.startsWith('scan:'))).toHaveLength(1)
  expect(events.filter((event) => event === 'score')).toHaveLength(scores)
  expect((await readCollectionRun(setup.dataRoot))?.id).toBe(interrupted?.id)
  expect((await readCollectionRun(setup.dataRoot))?.translated).toBe(2)
  expect(await readCollectionHistory(setup.dataRoot)).toHaveLength(1)
  const work = await readFile(
    path.join(setup.dataRoot, 'collection-work', interrupted!.id, 'work.json'),
    'utf8'
  )
  expect(
    JSON.parse(work).jobs.every(
      (job: { status: string }) => job.status === 'done'
    )
  ).toBe(true)
})

it('does not translate 59-point content and never scores or translates junk', async () => {
  const setup = await fixture(['first'])
  const config = await loadSingleTableConfig(setup.configRoot)
  config.analysis.scoring.weights = {
    interest_fit: 36,
    concrete_gain: 28,
    substance: 20,
    new_information: 16,
  }
  await writeFile(
    path.join(setup.configRoot, 'analysis.yaml'),
    JSON.stringify(config.analysis)
  )
  const events: string[] = []
  const base = model(events)
  await collectSingleTable({
    ...setup,
    provider: provider(events),
    gateway: {
      async complete(input) {
        if (input.stage === 'classify' && input.user.includes('high'))
          return {
            text: '---\nkeywords: []\nspam: {isJunk: true, reason: 广告}\n---\n',
            provider: 'test',
            model: 'fixture',
            durationMs: 1,
          }
        return base.complete(input)
      },
    },
  })
  expect(events.filter((event) => event === 'score')).toHaveLength(2)
  expect(events).not.toContain('translate')
  const repository = await SingleTableRepository.open(setup.dataRoot)
  try {
    const rows = repository.search({})
    expect(rows.find((row) => row.title === 'sixty')?.total_score).toBe(59)
    expect(rows.find((row) => row.title === 'high')?.is_junk).toBe(1)
  } finally {
    repository.close()
  }
})

it('runs a due timeline reconciliation after incremental discovery and schedules the next check', async () => {
  const setup = await fixture(['first'])
  await saveSourceState(setup.configRoot, {
    sources: {
      first: {
        discovered_until: new Date(Date.now() - 86_400_000).toISOString(),
        next_reconcile_at: new Date(Date.now() - 1000).toISOString(),
      },
    },
  })
  const modes: string[] = []
  await collectSingleTable({
    ...setup,
    provider: {
      async discover(_source, _limit, window) {
        modes.push(window!.mode)
        return { items: [], request: {}, response: {} }
      },
      resolve: async () => {
        throw new Error('no content')
      },
    },
    gateway: model([]),
  })
  expect(modes).toEqual(['search', 'timeline'])
  const state = (await loadSourceState(setup.configRoot)).sources.first!
  expect(Date.parse(state.next_reconcile_at!)).toBeGreaterThan(Date.now())
  expect(state.pending_window).toBeUndefined()
})

it('analyzes and translates a redirected article identity only once across simultaneous sources', async () => {
  const setup = await fixture()
  const events: string[] = []
  const canonicalUrl = 'https://example.com/one-article'
  const translationPrompts: string[] = []
  const gateway = model(events)
  await collectSingleTable({
    ...setup,
    gateway: {
      async complete(input) {
        if (input.stage === 'translate') translationPrompts.push(input.user)
        return gateway.complete(input)
      },
    },
    provider: {
      async discover(source) {
        return {
          items: [
            {
              externalId: source.id,
              title: 'high',
              url: `https://example.com/redirect/${source.id}`,
              kind: 'article',
            },
          ],
          request: {},
          response: {},
        }
      },
      async resolve(source, item) {
        return {
          original: {
            platform: 'x',
            sourceType: 'x',
            sourceAccountId: source.id,
            sourceAccountName: source.account_name,
            externalContentId: item.externalId,
            canonicalUrl,
            title: 'high',
            body: 'high article',
            kind: 'article',
            format: 'markdown_article',
            language: 'en',
          },
        }
      },
    },
  })
  expect(events.filter((event) => event === 'score')).toHaveLength(1)
  expect(events.filter((event) => event === 'translate')).toHaveLength(1)
  expect(translationPrompts[0]).toContain('原文格式：markdown_article')
  const repository = await SingleTableRepository.open(setup.dataRoot)
  try {
    expect(repository.search({})).toHaveLength(1)
  } finally {
    repository.close()
  }
})

it('retains resolved subtitle format and duration when translating after the analysis phase', async () => {
  const setup = await fixture(['first'])
  const cfg = await loadSingleTableConfig(setup.configRoot)
  cfg.runtime.collection.process_media = true
  await writeFile(
    path.join(setup.configRoot, 'runtime.yaml'),
    JSON.stringify(cfg.runtime)
  )
  const gateway = model([])
  const translationPrompts: string[] = []
  await collectSingleTable({
    ...setup,
    provider: {
      async discover() {
        return {
          items: [{ externalId: 'video', title: 'high', kind: 'video' }],
          request: {},
          response: {},
        }
      },
      async resolve(source) {
        return {
          original: {
            platform: 'x',
            sourceType: 'x',
            sourceAccountId: source.id,
            sourceAccountName: source.account_name,
            externalContentId: 'video',
            title: 'high',
            originalTitle: 'Resolved video title',
            body: 'high captions',
            kind: 'video',
            format: 'subtitle',
            language: 'en',
            videoDurationSeconds: 1200,
          },
        }
      },
    },
    gateway: {
      async complete(input) {
        if (input.stage === 'translate') translationPrompts.push(input.user)
        return gateway.complete(input)
      },
    },
  })
  expect(translationPrompts).toHaveLength(1)
  expect(translationPrompts[0]).toContain('原文格式：subtitle')
  expect(translationPrompts[0]).toContain('原始标题：Resolved video title')
  const repository = await SingleTableRepository.open(setup.dataRoot)
  try {
    expect(repository.search({})[0]).toMatchObject({
      original_format: 'subtitle',
      video_duration_seconds: 1200,
      translation_status: 'succeeded',
    })
  } finally {
    repository.close()
  }
})

it('finishes an older pending reconciliation before catching up to the current run window', async () => {
  const setup = await fixture(['first'])
  const oldUntil = new Date(Date.now() - 86_400_000).toISOString()
  await saveSourceState(setup.configRoot, {
    sources: {
      first: {
        discovered_until: oldUntil,
        next_reconcile_at: oldUntil,
        pending_window: {
          mode: 'timeline',
          since: new Date(Date.now() - 8 * 86_400_000).toISOString(),
          until: oldUntil,
          cursor: 'old-reconciliation',
        },
      },
    },
  })
  const modes: string[] = []
  await collectSingleTable({
    ...setup,
    provider: {
      async discover(_source, _limit, window) {
        modes.push(window!.mode)
        return { items: [], request: {}, response: {} }
      },
      resolve: async () => {
        throw new Error('no content')
      },
    },
    gateway: model([]),
  })
  expect(modes).toEqual(['timeline', 'search'])
  expect(
    (await loadSourceState(setup.configRoot)).sources.first?.discovered_until
  ).toBe((await readCollectionRun(setup.dataRoot))?.startedAt)
})

it('preserves an enable override changed while a source is being scanned', async () => {
  const setup = await fixture(['first'])
  await collectSingleTable({
    ...setup,
    provider: {
      async discover() {
        await saveSourceState(setup.configRoot, {
          sources: { first: { enabled_override: false } },
        })
        return { items: [], request: {}, response: {} }
      },
      resolve: async () => {
        throw new Error('no content')
      },
    },
    gateway: model([]),
  })
  expect(
    (await loadSourceState(setup.configRoot)).sources.first?.enabled_override
  ).toBe(false)
})

it('excludes Twitter video posts before any enrichment or AI call by default and supports opting in', async () => {
  const setup = await fixture(['first'])
  expect(
    (await loadSingleTableConfig(setup.configRoot)).runtime.collection
      .process_twitter_videos
  ).toBe(false)
  let resolves = 0
  const candidate: SingleTableSourceProvider = {
    async discover() {
      return {
        items: [
          {
            externalId: 'native-video',
            title: 'Video with article link',
            kind: 'video',
            body: 'Post text',
          },
          {
            externalId: 'live',
            kind: 'article',
            url: 'https://x.com/i/broadcasts/123',
          },
        ],
        request: {},
        response: {},
      }
    },
    async resolve() {
      resolves++
      throw new Error('video must not be resolved')
    },
  }
  await collectSingleTable({
    ...setup,
    provider: candidate,
    gateway: {
      async complete() {
        throw new Error('video must not invoke AI')
      },
    },
  })
  const repository = await SingleTableRepository.open(setup.dataRoot)
  try {
    const rows = repository.search({ sourceAccountId: 'first' })
    expect(rows).toHaveLength(2)
    for (const row of rows)
      expect(row).toMatchObject({
        is_unprocessed: 1,
        is_junk: 0,
        unprocessed_reason: 'Twitter 视频',
        process_status: 'completed',
        translation_status: 'skipped',
      })
    expect(resolves).toBe(0)
    const config = await loadSingleTableConfig(setup.configRoot)
    config.runtime.collection.process_media = true
    await writeFile(
      path.join(setup.configRoot, 'runtime.yaml'),
      JSON.stringify(config.runtime)
    )
    await collectSingleTable({
      ...setup,
      provider: {
        ...candidate,
        async discover() {
          return {
            items: [{ externalId: 'new-opt-in-video', kind: 'video' }],
            request: {},
            response: {},
          }
        },
      },
      gateway: model([]),
    })
    expect(resolves).toBe(1)
  } finally {
    repository.close()
  }
})

it('routes video, audio, interactive pages and unsupported files into unprocessed without resolution or AI', async () => {
  const setup = await fixture(['first'])
  const config = await loadSingleTableConfig(setup.configRoot)
  config.sources.sources[0]!.platform = 'youtube'
  await writeFile(
    path.join(setup.configRoot, 'sources.yaml'),
    JSON.stringify(config.sources)
  )
  await collectSingleTable({
    ...setup,
    provider: {
      async discover() {
        return {
          items: [
            { externalId: 'video', kind: 'video' },
            {
              externalId: 'audio',
              kind: 'article',
              mediaType: 'audio',
              url: 'https://example.com/episode',
            },
            {
              externalId: 'pdf',
              kind: 'article',
              url: 'https://example.com/test.pdf',
            },
            {
              externalId: 'interactive',
              kind: 'article',
              url: 'https://huggingface.co/spaces/a/b',
            },
          ],
          request: {},
          response: {},
        }
      },
      async resolve() {
        throw new Error('Excluded content must not be fetched')
      },
    },
    gateway: {
      async complete() {
        throw new Error('Excluded content must not call AI')
      },
    },
  })
  const repository = await SingleTableRepository.open(setup.dataRoot)
  try {
    expect(repository.unprocessedRows()).toHaveLength(4)
    expect(
      repository
        .unprocessedRows()
        .every((row) => !row.is_junk && row.translation_status === 'skipped')
    ).toBe(true)
  } finally {
    repository.close()
  }
  const run = await readCollectionRun(setup.dataRoot)
  expect(run?.sources[0]).toMatchObject({
    newlyCompleted: 0,
    failed: 0,
    skipped: 4,
  })
})
