import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  SingleTableRepository,
  type OriginalContent,
  type ScoringRules,
} from '@qiushuiai-airadar/runtime'

import {
  createSingleTableCodexGateway,
  processSingleTableContent,
  resolveSingleTableModel,
  type SingleTableModelGateway,
} from './single-table-flow.js'
import { createFileModelCredentialStore } from './model-credential-store.js'

const roots: string[] = []
const repositories: SingleTableRepository[] = []
const promptsRoot = path.resolve(
  import.meta.dirname,
  '../../../docs/prompts/single-table-content'
)

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
const original: OriginalContent = {
  platform: 'x',
  sourceType: 'x',
  sourceAccountId: 'author',
  sourceAccountName: 'Author',
  externalContentId: 'one',
  title: 'A short post',
  originalTitle: 'A short post',
  body: 'A practical AI workflow.',
  kind: 'short_post',
  format: 'plain_text',
  language: 'en',
}

async function fixture(
  outputs: Record<string, string>,
  minimum = 60,
  content = original
) {
  const root = await mkdtemp(path.join(tmpdir(), 'qiushuiai-airadar-flow-'))
  roots.push(root)
  const repository = await SingleTableRepository.open(root)
  repositories.push(repository)
  const calls: Array<{ stage: string; user: string }> = []
  const gateway: SingleTableModelGateway = {
    async complete(input) {
      calls.push({ stage: input.stage, user: input.user })
      return {
        text: outputs[input.stage]!,
        provider: 'mock',
        model: 'mock',
        durationMs: 1,
      }
    },
  }
  const result = await processSingleTableContent({
    repository,
    gateway,
    promptsRoot,
    original: content,
    profile: {
      interests: ['AI Agent'],
      goals: ['找工作流'],
      exclusions: ['纯广告'],
    },
    scoring: rules,
    longContentMinChars: 1000,
    translationMinimumTotalScore: minimum,
  })
  return { result, calls }
}

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  )
})

const score = JSON.stringify({
  valueSummary: '能学习一套可复用的工作流。',
  scores: {
    interestFit: { level: 5, reason: '相关' },
    concreteGain: { level: 4, reason: '可复用' },
    substance: { level: 4, reason: '有步骤' },
    newInformation: { level: 3, reason: '有新信息' },
  },
})

describe('single-table AI flow', () => {
  it('persists provider credentials without exposing secrets from list', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'qiushuiai-model-auth-'))
    roots.push(root)
    const file = path.join(root, 'model-auth.json')
    const store = createFileModelCredentialStore(file)
    await store.modify('openai', async () => ({
      type: 'api_key',
      key: 'secret-test-key',
    }))
    expect(await store.list()).toEqual([
      { providerId: 'openai', type: 'api_key' },
    ])
    expect(await store.read('openai')).toMatchObject({
      type: 'api_key',
      key: 'secret-test-key',
    })
    expect(await readFile(file, 'utf8')).toContain('secret-test-key')
    if (process.platform !== 'win32')
      expect((await stat(file)).mode & 0o077).toBe(0)
  })
  it('accepts the configured Codex model without reading credentials', () => {
    expect(
      createSingleTableCodexGateway('/nonexistent/auth.json', 'gpt-5.6-terra')
    ).toBeDefined()
  })
  it('uses a stage override and otherwise falls back to the default model', () => {
    const routing = {
      default: 'gpt-5.5',
      stages: { score: 'gpt-5.6-terra' },
    }
    expect(resolveSingleTableModel(routing, 'classify')).toBe('gpt-5.5')
    expect(resolveSingleTableModel(routing, 'score')).toBe('gpt-5.6-terra')
    expect(resolveSingleTableModel(routing, 'translate')).toBe('gpt-5.5')
    expect(
      resolveSingleTableModel(
        {
          default: 'gpt-5.5',
          stages: {
            score: { provider: 'deepseek', model: 'deepseek-v4-pro' },
          },
        },
        'score'
      )
    ).toBe('deepseek-v4-pro')
  })
  it('calls only classification for junk content', async () => {
    const { result, calls } = await fixture({
      classify:
        '---\nkeywords: ["广告"]\nspam:\n  isJunk: true\n  reason: "纯广告"\n---',
    })
    expect(calls.map((call) => call.stage)).toEqual(['classify'])
    expect(result.total_score).toBeNull()
    expect(result.chinese_markdown_path).toBeNull()
  })

  it('accepts empty keywords and summary when a long item is junk', async () => {
    const { result, calls } = await fixture(
      {
        classify:
          '---\nkeywords: []\nspam:\n  isJunk: true\n  reason: "纯广告"\n---',
      },
      10,
      {
        ...original,
        externalContentId: 'junk-article',
        kind: 'article',
        canonicalUrl: 'https://example.com/junk-article',
        body: 'This promotional article has no useful content.',
      }
    )
    expect(calls.map((call) => call.stage)).toEqual(['classify'])
    expect(result.process_status).toBe('completed')
    expect(result.keywords_json).toBe('[]')
  })

  it('caps excess model keywords instead of failing classification', async () => {
    const { result } = await fixture({
      classify:
        '---\nkeywords: ["a", "b", "c", "d", "e", "f"]\nspam:\n  isJunk: true\n  reason: "广告"\n---',
    })
    expect(JSON.parse(String(result.keywords_json))).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ])
  })

  it('accepts a JSON code fence around the model scoring response', async () => {
    const { result } = await fixture(
      {
        classify:
          '---\nkeywords: ["工作流"]\nspam:\n  isJunk: false\n  reason: null\n---',
        score: `\`\`\`json\n${score}\n\`\`\``,
      },
      100
    )
    expect(result.process_status).toBe('completed')
    expect(result.total_score).toBeGreaterThan(0)
  })

  it('scores low-value English without translating', async () => {
    const { result, calls } = await fixture(
      {
        classify:
          '---\nkeywords: ["工作流"]\nspam:\n  isJunk: false\n  reason: null\n---',
        score,
      },
      84
    )
    expect(calls.map((call) => call.stage)).toEqual(['classify', 'score'])
    expect(calls[1]!.user).not.toContain('summary')
    expect(result.summary).toBe(original.body)
    expect(result.chinese_markdown_path).toBeNull()
  })

  it('translates at 10 points and skips English content below 10 points', async () => {
    const classify =
      '---\nkeywords: ["工作流"]\nspam:\n  isJunk: false\n  reason: null\n---'
    const scoring = (interestFit: number) =>
      JSON.stringify({
        valueSummary: '提供基础参考。',
        scores: {
          interestFit: { level: interestFit, reason: '相关' },
          concreteGain: { level: 1, reason: '少量收获' },
          substance: { level: 1, reason: '内容较少' },
          newInformation: { level: 1, reason: '信息较少' },
        },
      })
    const untranslated = await fixture({ classify, score: scoring(1) }, 10)
    expect(untranslated.result.total_score).toBe(0)
    expect(untranslated.calls.map((call) => call.stage)).toEqual([
      'classify',
      'score',
    ])

    const translated = await fixture(
      {
        classify,
        score: scoring(2),
        translate: JSON.stringify({
          chineseTitle: '中文标题',
          chineseBody: '中文意译内容。',
        }),
      },
      10,
      { ...original, externalContentId: 'threshold-10' }
    )
    expect(translated.result.total_score).toBe(10)
    expect(translated.result.translated_to_chinese).toBe(1)
    expect(translated.calls.map((call) => call.stage)).toEqual([
      'classify',
      'score',
      'translate',
    ])
  })

  it('skips automatic video translation when duration or equivalent characters reach half an hour', async () => {
    const outputs = {
      classify:
        '---\nkeywords: ["视频"]\nspam:\n  isJunk: false\n  reason: null\n---\n\n视频总结。',
      score,
    }
    const duration = await fixture(outputs, 10, {
      ...original,
      externalContentId: 'duration-limit',
      body: 'English transcript.',
      kind: 'video',
      format: 'subtitle',
      videoDurationSeconds: 1_800,
    })
    expect(duration.calls.map((call) => call.stage)).toEqual([
      'classify',
      'score',
    ])
    expect(duration.result.translation_status).toBe('skipped')
    expect(duration.result.translation_skip_reason).toBe('video_duration_limit')

    const characters = await fixture(outputs, 10, {
      ...original,
      externalContentId: 'character-limit',
      body: 'a'.repeat(27_000),
      kind: 'video',
      format: 'subtitle',
      videoDurationSeconds: 1_799,
    })
    expect(characters.calls.map((call) => call.stage)).toEqual([
      'classify',
      'score',
    ])
    expect(characters.result.translation_skip_reason).toBe(
      'source_character_limit'
    )
  })

  it('keeps Chinese original and makes only classification plus scoring calls', async () => {
    const { result, calls } = await fixture(
      {
        classify:
          '---\nkeywords: ["智能体", "工作流"]\nspam:\n  isJunk: false\n  reason: null\n---',
        score,
      },
      60,
      {
        ...original,
        language: 'zh',
        body: '这是一套实用的 AI 智能体工作流。',
      }
    )
    expect(calls.map((call) => call.stage)).toEqual(['classify', 'score'])
    expect(result.summary).toBe('这是一套实用的 AI 智能体工作流。')
    expect(result.chinese_markdown_path).toContain('中文.md')
    expect(result.english_markdown_path).toBeNull()
  })

  it('makes three calls and replaces English short summary after translation', async () => {
    const { result, calls } = await fixture({
      classify:
        '---\nkeywords: ["工作流"]\nspam:\n  isJunk: false\n  reason: null\n---',
      score,
      translate: JSON.stringify({
        chineseTitle: '中文标题',
        chineseBody: '一套实用的 AI 工作流。',
      }),
    })
    expect(calls.map((call) => call.stage)).toEqual([
      'classify',
      'score',
      'translate',
    ])
    expect(result.summary).toBe('一套实用的 AI 工作流。')
    expect(result.chinese_markdown_path).toContain('中文.md')
  })

  it('keeps first-call Chinese Markdown summary for an English article', async () => {
    const article = {
      ...original,
      kind: 'article' as const,
      format: 'markdown_article' as const,
      canonicalUrl: 'https://example.com/article',
      body: '# Heading\n\nEnglish text.',
    }
    const { result, calls } = await fixture(
      {
        classify:
          '---\nkeywords: ["工作流"]\nspam:\n  isJunk: false\n  reason: null\n---\n\n## 中文总结\n\n实用做法。',
        score,
        translate: JSON.stringify({
          chineseTitle: '中文标题',
          chineseBody: '# 中文标题\n\n中文正文。',
        }),
      },
      60,
      article
    )
    expect(calls.map((call) => call.stage)).toEqual([
      'classify',
      'score',
      'translate',
    ])
    expect(result.summary).toBe('## 中文总结\n\n实用做法。')
    expect(calls[1]!.user).not.toContain('实用做法')
  })
})
