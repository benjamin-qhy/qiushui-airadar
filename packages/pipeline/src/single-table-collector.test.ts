import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import {
  SingleTableRepository,
  type ScoringRules,
} from '@qiushui-airadar/runtime'

import {
  collectSourcesSerially,
  type ConfiguredSource,
} from './single-table-collector.js'

const roots: string[] = []
const repositories: SingleTableRepository[] = []
afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  )
})

it('classifies an X plugin directory as rule junk without fetching an article or invoking the model', async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), 'qiushui-airadar-directory-')
  )
  roots.push(root)
  const repository = await SingleTableRepository.open(root)
  repositories.push(repository)
  const url = 'https://chatgpt.com/plugins?category=small-business'
  const source: ConfiguredSource = {
    id: 'x_openai',
    platform: 'x',
    account_name: 'X / OpenAI',
    external_identity: 'OpenAI',
    language: 'en',
    enabled: true,
  }
  const input = {
    sources: [source],
    repository,
    promptsRoot: path.resolve(
      import.meta.dirname,
      '../../../docs/prompts/single-table-content'
    ),
    profile: { interests: [], goals: [], exclusions: [] },
    scoring: {
      weights: {
        interest_fit: 40,
        concrete_gain: 30,
        substance: 20,
        new_information: 10,
      },
      coreThreshold: 80,
      exploreThreshold: 60,
      coreMinLevels: { interest_fit: 5, concrete_gain: 4, substance: 3 },
      exploreMinLevels: { interest_fit: 4, concrete_gain: 3, substance: 3 },
    } satisfies ScoringRules,
    longContentMinChars: 1000,
    translationMinimumTotalScore: 60,
    provider: {
      async discover() {
        return {
          items: [
            {
              externalId: '2097523484629090408',
              url,
              title: 'Plugin directory',
              kind: 'article' as const,
            },
          ],
          request: {},
          response: {},
        }
      },
      async resolve(): Promise<never> {
        throw new Error('must not fetch directory')
      },
    },
    gateway: {
      async complete(): Promise<never> {
        throw new Error('must not analyze directory')
      },
    },
  }
  expect(await collectSourcesSerially(input)).toEqual([
    {
      sourceId: 'x_openai',
      discovered: 1,
      completed: 0,
      failed: 0,
      skipped: 1,
    },
  ])
  const row = repository.search({ sourceAccountId: 'x_openai' })[0]!
  expect(row).toMatchObject({
    is_junk: 1,
    junk_source: 'rule',
    junk_reason: '目录页：插件列表，不是单篇文章',
    process_status: 'completed',
  })
  expect(await collectSourcesSerially(input)).toEqual([
    {
      sourceId: 'x_openai',
      discovered: 1,
      completed: 1,
      failed: 0,
      skipped: 0,
    },
  ])
  expect(repository.search({ sourceAccountId: 'x_openai' })).toHaveLength(1)
})

it('runs sources and items serially with exactly one list call per source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qiushui-airadar-serial-'))
  roots.push(root)
  const repository = await SingleTableRepository.open(root)
  repositories.push(repository)
  const sources: ConfiguredSource[] = [
    {
      id: 'first',
      platform: 'x',
      account_name: 'First',
      external_identity: 'first',
      language: 'en',
      enabled: true,
    },
    {
      id: 'second',
      platform: 'x',
      account_name: 'Second',
      external_identity: 'second',
      language: 'en',
      enabled: true,
    },
  ]
  const events: string[] = []
  const rules: ScoringRules = {
    weights: {
      interest_fit: 40,
      concrete_gain: 30,
      substance: 20,
      new_information: 10,
    },
    coreThreshold: 80,
    exploreThreshold: 60,
    coreMinLevels: { interest_fit: 5, concrete_gain: 4, substance: 3 },
    exploreMinLevels: { interest_fit: 4, concrete_gain: 3, substance: 3 },
  }
  const result = await collectSourcesSerially({
    sources,
    repository,
    promptsRoot: path.resolve(
      import.meta.dirname,
      '../../../docs/prompts/single-table-content'
    ),
    profile: { interests: ['AI Agent'], goals: ['工作流'], exclusions: [] },
    scoring: rules,
    longContentMinChars: 1000,
    translationMinimumTotalScore: 60,
    provider: {
      async discover(source, limit) {
        events.push(`discover:${source.id}:${limit}`)
        return {
          items: [
            {
              externalId: `${source.id}-1`,
              body: 'A short post.',
              kind: 'short_post',
              interaction: {
                capturedAt: '2026-09-18T00:00:00.000Z',
                views: 123,
                likes: 7,
                comments: 2,
                shares: 1,
                saves: null,
              },
            },
          ],
          request: { source: source.id },
          response: { items: 1, nextCursor: 'ignored' },
        }
      },
      async resolve(source, item) {
        events.push(`resolve:${source.id}`)
        return {
          original: {
            platform: source.platform,
            sourceType: source.platform,
            sourceAccountId: source.id,
            sourceAccountName: source.account_name,
            externalContentId: item.externalId,
            title: 'Post',
            body: item.body!,
            kind: item.kind,
            format: 'plain_text',
            language: 'en',
          },
        }
      },
    },
    gateway: {
      async complete(input) {
        events.push(`model:${input.stage}`)
        return {
          text:
            input.stage === 'classify'
              ? '---\nkeywords: ["广告"]\nspam:\n  isJunk: true\n  reason: "纯广告"\n---'
              : '',
          provider: 'mock',
          model: 'mock',
          durationMs: 1,
        }
      },
    },
  })
  expect(result).toEqual([
    { sourceId: 'first', discovered: 1, completed: 1, failed: 0, skipped: 0 },
    { sourceId: 'second', discovered: 1, completed: 1, failed: 0, skipped: 0 },
  ])
  expect(events).toEqual([
    'discover:first:undefined',
    'resolve:first',
    'model:classify',
    'discover:second:undefined',
    'resolve:second',
    'model:classify',
  ])
  const stored = repository.search({ sourceAccountId: 'first' })[0]
  expect(stored?.views).toBe(123)
  expect(stored?.likes).toBe(7)
  expect(stored?.interaction_captured_at).toBe('2026-09-18T00:00:00.000Z')
})

it('refreshes duplicate interaction data without resolving or analyzing the content again', async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), 'qiushui-airadar-duplicate-refresh-')
  )
  roots.push(root)
  const repository = await SingleTableRepository.open(root)
  repositories.push(repository)
  await repository.saveOriginal({
    platform: 'youtube',
    sourceType: 'youtube',
    sourceAccountId: 'yt_openai',
    sourceAccountName: 'OpenAI',
    externalContentId: 'video-1',
    canonicalUrl: 'https://www.youtube.com/watch?v=video-1',
    title: 'Existing video',
    body: 'Existing transcript',
    kind: 'video',
    format: 'subtitle',
    language: 'en',
  })
  repository.updateInteractionBySourceId('yt_openai', 'video-1', {
    capturedAt: '2026-09-18T00:00:00.000Z',
    views: 100,
    likes: 10,
    comments: 5,
    shares: null,
    saves: null,
  })
  let resolveCalls = 0
  let modelCalls = 0
  const result = await collectSourcesSerially({
    sources: [
      {
        id: 'yt_openai',
        platform: 'youtube',
        account_name: 'YouTube / OpenAI',
        external_identity: 'https://www.youtube.com/@OpenAI',
        language: 'en',
        enabled: true,
      },
    ],
    repository,
    promptsRoot: path.resolve(
      import.meta.dirname,
      '../../../docs/prompts/single-table-content'
    ),
    profile: { interests: [], goals: [], exclusions: [] },
    scoring: {
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
    },
    longContentMinChars: 1000,
    translationMinimumTotalScore: 60,
    provider: {
      async discover() {
        return {
          items: [
            {
              externalId: 'video-1',
              url: 'https://www.youtube.com/watch?v=video-1',
              title: 'Existing video',
              kind: 'video' as const,
              interaction: {
                capturedAt: '2026-09-20T00:00:00.000Z',
                views: 120,
                likes: 0,
                comments: null,
                shares: null,
                saves: null,
              },
            },
          ],
          request: {},
          response: {},
        }
      },
      async resolve(): Promise<never> {
        resolveCalls++
        throw new Error('duplicate content must not be resolved')
      },
    },
    gateway: {
      async complete(): Promise<never> {
        modelCalls++
        throw new Error('duplicate content must not be analyzed')
      },
    },
  })
  expect(result).toEqual([
    {
      sourceId: 'yt_openai',
      discovered: 1,
      completed: 0,
      failed: 0,
      skipped: 1,
    },
  ])
  expect(resolveCalls).toBe(0)
  expect(modelCalls).toBe(0)
  expect(repository.search()).toHaveLength(1)
  expect(repository.search()[0]).toMatchObject({
    views: 120,
    likes: 10,
    comments: 5,
    interaction_captured_at: '2026-09-20T00:00:00.000Z',
  })
})

it('stops the current source after a provider balance failure', async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), 'qiushui-airadar-provider-balance-')
  )
  roots.push(root)
  const repository = await SingleTableRepository.open(root)
  repositories.push(repository)
  let resolveCalls = 0
  const result = await collectSourcesSerially({
    sources: [
      {
        id: 'yt_openai',
        platform: 'youtube',
        account_name: 'YouTube / OpenAI',
        external_identity: 'https://www.youtube.com/@OpenAI',
        language: 'en',
        enabled: true,
      },
    ],
    repository,
    promptsRoot: path.resolve(
      import.meta.dirname,
      '../../../docs/prompts/single-table-content'
    ),
    profile: { interests: [], goals: [], exclusions: [] },
    scoring: {
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
    },
    longContentMinChars: 1000,
    translationMinimumTotalScore: 60,
    provider: {
      async discover() {
        return {
          items: ['video-1', 'video-2', 'video-3'].map((externalId) => ({
            externalId,
            url: `https://www.youtube.com/watch?v=${externalId}`,
            title: externalId,
            kind: 'video' as const,
          })),
          request: {},
          response: {},
        }
      },
      async resolve(): Promise<never> {
        resolveCalls++
        throw new Error('HTTP 402: Insufficient balance')
      },
    },
    gateway: {
      async complete(): Promise<never> {
        throw new Error('must not analyze unresolved content')
      },
    },
  })
  expect(resolveCalls).toBe(1)
  expect(result).toEqual([
    {
      sourceId: 'yt_openai',
      discovered: 3,
      completed: 0,
      failed: 1,
      skipped: 0,
    },
  ])
  expect(repository.search()).toHaveLength(1)
})

it('does not automatically retry a failed content row on the next collection', async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), 'qiushui-airadar-no-auto-retry-')
  )
  roots.push(root)
  const repository = await SingleTableRepository.open(root)
  repositories.push(repository)
  await repository.recordUnavailable(
    {
      platform: 'x',
      sourceType: 'x',
      sourceAccountId: 'first',
      sourceAccountName: 'First',
      externalContentId: 'failed-1',
      title: 'Failed post',
      kind: 'short_post',
      format: 'plain_text',
      language: 'en',
    },
    'Previous enrichment failed'
  )
  let modelCalls = 0
  const result = await collectSourcesSerially({
    sources: [
      {
        id: 'first',
        platform: 'x',
        account_name: 'First',
        external_identity: 'first',
        language: 'en',
        enabled: true,
      },
    ],
    repository,
    promptsRoot: path.resolve(
      import.meta.dirname,
      '../../../docs/prompts/single-table-content'
    ),
    profile: { interests: [], goals: [], exclusions: [] },
    scoring: {
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
    },
    longContentMinChars: 1000,
    translationMinimumTotalScore: 60,
    provider: {
      async discover() {
        return {
          items: [
            {
              externalId: 'failed-1',
              kind: 'short_post',
              interaction: {
                capturedAt: '2026-09-18T01:00:00.000Z',
                views: 456,
                likes: 12,
                comments: null,
                shares: null,
                saves: null,
              },
            },
          ],
          request: {},
          response: {},
        }
      },
      async resolve() {
        return {
          original: {
            platform: 'x',
            sourceType: 'x',
            sourceAccountId: 'first',
            sourceAccountName: 'First',
            externalContentId: 'failed-1',
            title: 'Failed post',
            body: 'Now available',
            kind: 'short_post',
            format: 'plain_text',
            language: 'en',
          },
        }
      },
    },
    gateway: {
      async complete() {
        modelCalls++
        throw new Error('Must not call model')
      },
    },
  })
  expect(result).toEqual([
    { sourceId: 'first', discovered: 1, completed: 0, failed: 0, skipped: 1 },
  ])
  expect(modelCalls).toBe(0)
  const stored = repository.search({ sourceAccountId: 'first' })[0]
  expect(stored?.process_status).toBe('failed')
  expect(stored?.views).toBe(456)
  expect(stored?.likes).toBe(12)
})
