import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'

import {
  SingleTableRepository,
  contentIdentity,
  scoreContent,
  type OriginalContent,
  type ScoringRules,
} from './single-table.js'

const temporaryRoots: string[] = []
const repositories: SingleTableRepository[] = []

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

const scores = {
  interest_fit: { level: 5, reason: '直接相关' },
  concrete_gain: { level: 4, reason: '有可复用方法' },
  substance: { level: 4, reason: '有实际步骤' },
  new_information: { level: 3, reason: '有部分新见解' },
}

const shortPost: OriginalContent = {
  platform: 'x',
  sourceType: 'x',
  sourceAccountId: 'openai',
  sourceAccountName: 'OpenAI',
  externalContentId: '123',
  canonicalUrl: 'https://x.com/openai/status/123',
  title: 'English post',
  body: 'A useful workflow for AI agents.',
  kind: 'short_post',
  format: 'plain_text',
  language: 'en',
}

async function setup(): Promise<{
  root: string
  repository: SingleTableRepository
}> {
  const root = await mkdtemp(
    path.join(tmpdir(), 'qiushui-airadar-single-table-')
  )
  temporaryRoots.push(root)
  const repository = await SingleTableRepository.open(root)
  repositories.push(repository)
  return { root, repository }
}

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close()
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true }))
  )
})

describe('single-table content storage', () => {
  it('keeps source HTTP errors out of model retry and includes model response errors', async () => {
    const { repository } = await setup()
    const article = await repository.saveOriginal({
      ...shortPost,
      externalContentId: 'article-403',
      canonicalUrl: 'https://example.com/article-403',
      kind: 'article',
    })
    repository.fail(
      article.id,
      'enriching',
      'All providers failed for web_article: native-http: Article request failed with HTTP 403'
    )
    const model = await repository.saveOriginal({
      ...shortPost,
      externalContentId: 'model-401',
      canonicalUrl: 'https://x.com/openai/status/model-401',
    })
    repository.fail(model.id, 'classifying', '401: Authentication Fails')
    expect(repository.modelFailureRows().map((row) => row.id)).toEqual([
      model.id,
    ])
  })

  it('creates only contents and keeps a stable dated directory across duplicate capture', async () => {
    const { root, repository } = await setup()
    const original = await repository.saveOriginal(shortPost)
    const again = await repository.saveOriginal({
      ...shortPost,
      title: 'Changed title',
      sourceAccountName: 'New Name',
    })
    expect(again.id).toBe(original.id)
    expect(again.execution_log_markdown_path).toBe(
      original.execution_log_markdown_path
    )
    expect(original.execution_log_markdown_path).toMatch(
      /^contents\/\d{8}\/x-OpenAI-123-[a-f0-9]{8}\/执行日志\.md$/u
    )
    const database = new DatabaseSync(
      path.join(root, 'qiushui-airadar.sqlite')
    )
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
        .all()
    ).toEqual([{ name: 'contents' }])
    database.close()
    expect(repository.search()).toHaveLength(1)
    expect(original.chinese_markdown_path).toBeNull()
    await expect(
      stat(path.join(root, original.english_markdown_path!))
    ).resolves.toBeDefined()
  })

  it('uses article URL as identity regardless of source account', () => {
    const article = {
      ...shortPost,
      kind: 'article' as const,
      canonicalUrl: 'https://example.com/a/?utm_source=x&id=1',
    }
    expect(contentIdentity(article).key).toBe(
      'article:https://example.com/a?id=1'
    )
    expect(
      contentIdentity({ ...article, sourceAccountId: 'another' }).key
    ).toBe(contentIdentity(article).key)
  })

  it('updates only positive interaction values and preserves the capture time when none are usable', async () => {
    const { repository } = await setup()
    await repository.saveOriginal(shortPost)
    expect(
      repository.updateInteractionBySourceId('openai', '123', {
        capturedAt: '2026-09-18T00:00:00.000Z',
        views: 100,
        likes: 10,
        comments: 5,
        shares: 2,
        saves: 1,
      })
    ).toBe(1)
    expect(
      repository.updateInteractionBySourceId('openai', '123', {
        capturedAt: '2026-09-20T00:00:00.000Z',
        views: 120,
        likes: 0,
        comments: null,
        shares: 3,
        saves: 0,
      })
    ).toBe(1)
    expect(repository.search()[0]).toMatchObject({
      views: 120,
      likes: 10,
      comments: 5,
      shares: 3,
      saves: 1,
      interaction_captured_at: '2026-09-20T00:00:00.000Z',
    })
    expect(
      repository.updateInteractionBySourceId('openai', '123', {
        capturedAt: '2026-09-21T00:00:00.000Z',
        views: 0,
        likes: null,
        comments: 0,
        shares: null,
        saves: 0,
      })
    ).toBe(0)
    expect(repository.search()[0]?.interaction_captured_at).toBe(
      '2026-09-20T00:00:00.000Z'
    )
  })

  it('keeps junk and low-scored English untranslated, but translates qualifying English short posts', async () => {
    const { root, repository } = await setup()
    const first = await repository.saveOriginal(shortPost)
    await repository.saveClassification(first.id, {
      keywords: ['智能体', '工作流'],
      isJunk: false,
    })
    const scored = await repository.saveScoring(
      first.id,
      '能学到智能体工作流。',
      scores,
      rules
    )
    expect(scoreContent(scores, rules)).toEqual({
      totalScore: 83,
      recommendation: 'core',
    })
    expect(scored.total_score).toBe(83)
    await expect(
      repository.saveTranslation(
        first.id,
        '一套实用的 AI 智能体工作流。',
        '中文标题',
        84
      )
    ).rejects.toThrow('does not qualify')
    expect(repository.getById(first.id)?.chinese_markdown_path).toBeNull()
    const translated = await repository.saveTranslation(
      first.id,
      '一套实用的 AI 智能体工作流。',
      '中文标题',
      83
    )
    expect(translated.summary).toBe('一套实用的 AI 智能体工作流。')
    expect(translated.title).toBe('中文标题')
    const chinese = await readFile(
      path.join(root, translated.chinese_markdown_path!),
      'utf8'
    )
    const header = parseDocument(
      chinese.split('\n---\n\n')[0]!.slice(4)
    ).toJS() as Record<string, unknown>
    expect(header).toMatchObject({
      title: '中文标题',
      keywords_text: '智能体 工作流',
      total_score: 83,
      is_junk: false,
    })
    expect(chinese).toContain('一套实用的 AI 智能体工作流。')

    const junk = await repository.saveOriginal({
      ...shortPost,
      externalContentId: 'junk',
      body: 'Subscribe now',
    })
    await repository.saveClassification(junk.id, {
      keywords: ['广告'],
      isJunk: true,
      reason: '仅有广告',
    })
    expect(repository.getById(junk.id)?.total_score).toBeNull()
    expect(repository.getById(junk.id)?.chinese_markdown_path).toBeNull()
  })

  it('stores redacted request and response, and searches table fields', async () => {
    const { root, repository } = await setup()
    const row = await repository.saveOriginal(shortPost)
    await repository.appendLog(row.id, {
      action: 'classify',
      stage: 'classifying',
      status: 'succeeded',
      request: {
        headers: { Authorization: 'Bearer very-secret' },
        url: 'https://api.example.com/?token=abc&apiKey=def',
      },
      response: {
        body: JSON.stringify({ keywords: ['智能体'], apiKey: 'secret-key' }),
      },
    })
    const log = await readFile(
      path.join(root, row.execution_log_markdown_path),
      'utf8'
    )
    expect(log).toContain('### request')
    expect(log).toContain('### response')
    expect(log).not.toContain('very-secret')
    expect(log).not.toContain('secret-key')
    expect(log).not.toContain('token=abc')
    expect(log).not.toContain('apiKey=def')
    await repository.saveClassification(row.id, {
      keywords: ['智能体'],
      isJunk: false,
    })
    expect(repository.search({ keyword: '智能体' })).toHaveLength(1)
    expect(repository.search({ keyword: '不存在' })).toHaveLength(0)
  })

  it('bounds detailed log payloads while preserving the execution summary', async () => {
    const { repository } = await setup()
    const row = await repository.saveOriginal(shortPost)
    await repository.appendLog(row.id, {
      action: 'enrich',
      stage: 'enriching',
      status: 'failed',
      request: { payload: 'r'.repeat(100_000) },
      response: { payload: 's'.repeat(100_000) },
      error: 'provider failed',
    })
    const log = await repository.readLog(row.id)
    expect(log).toContain('[TRUNCATED original_bytes=')
    expect(Buffer.byteLength(log!)).toBeLessThan(80_000)
  })

  it('gives manual junk decisions priority and clears old scores', async () => {
    const { repository } = await setup()
    const row = await repository.saveOriginal(shortPost)
    await repository.saveClassification(row.id, {
      keywords: ['智能体'],
      isJunk: false,
    })
    await repository.saveScoring(row.id, '工作流有价值。', scores, rules)
    const junk = await repository.setManualJunk(
      row.id,
      true,
      '广告',
      '人工确认'
    )
    expect(junk.total_score).toBeNull()
    expect(junk.recommendation).toBe('none')
    await repository.saveClassification(row.id, {
      keywords: ['工作流'],
      isJunk: false,
    })
    expect(repository.getById(row.id)?.is_junk).toBe(1)
    expect(repository.getById(row.id)?.junk_source).toBe('manual')
    repository.setRead(row.id, true)
    repository.setUtilizationActions(row.id, ['favorite', 'favorite'])
    expect(
      repository.search({ isJunk: true, read: true, sourcePlatform: 'x' })
    ).toHaveLength(1)
  })

  it('records missing captions without creating an empty content file, then allows manual retry', async () => {
    const { root, repository } = await setup()
    const video: OriginalContent = {
      ...shortPost,
      platform: 'youtube',
      sourceType: 'youtube',
      externalContentId: 'video-1',
      kind: 'video',
      format: 'subtitle',
      title: 'Video title',
      originalTitle: 'Video title',
      body: 'Actual transcript.',
    }
    const waiting = await repository.recordUnavailable(
      video,
      'Captions missing; manual transcription required',
      true
    )
    expect(waiting.process_status).toBe('waiting-manual-transcription')
    expect(waiting.chinese_markdown_path).toBeNull()
    expect(waiting.english_markdown_path).toBeNull()
    expect(
      await readFile(
        path.join(root, waiting.execution_log_markdown_path),
        'utf8'
      )
    ).toContain('Captions missing')
    const retried = await repository.saveOriginal(video)
    expect(retried.id).toBe(waiting.id)
    expect(retried.english_markdown_path).toContain('英文.md')
    expect(
      await readFile(path.join(root, retried.english_markdown_path!), 'utf8')
    ).toContain('Actual transcript.')
  })

  it('marks a missing Markdown file as failed and does not automatically rebuild it', async () => {
    const { root, repository } = await setup()
    const row = await repository.saveOriginal(shortPost)
    const originalFile = path.join(root, row.english_markdown_path!)
    await rm(originalFile)
    await expect(
      repository.saveClassification(row.id, {
        keywords: ['智能体'],
        isJunk: false,
      })
    ).rejects.toThrow('ENOENT')
    expect(repository.getById(row.id)?.process_status).toBe('failed')
    await expect(stat(originalFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
