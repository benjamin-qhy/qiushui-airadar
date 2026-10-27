import path from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { afterEach, expect, it } from 'vitest'

import {
  analysisConfigSchema,
  initializeSingleTableConfig,
  loadSingleTableConfig,
  loadSourceState,
  runtimeConfigSchema,
  providersConfigSchema,
  saveAnalysisModelConfig,
  saveAnalysisTranscriptionConfig,
  saveEditableConfigFile,
  saveSourceState,
  sourcesConfigSchema,
} from './single-table-config.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  )
})

it('validates editable YAML before replacing the saved file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qiushuiai-airadar-edit-'))
  roots.push(root)
  const configRoot = await initializeSingleTableConfig(
    path.resolve(import.meta.dirname, '../../../config'),
    root
  )
  const file = path.join(configRoot, 'runtime.yaml')
  const before = await readFile(file, 'utf8')
  await expect(
    saveEditableConfigFile(configRoot, 'runtime.yaml', 'timezone: invalid\n')
  ).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe(before)
  await saveEditableConfigFile(
    configRoot,
    'runtime.yaml',
    before.replace('max_retries: 2', 'max_retries: 3')
  )
  expect(
    (await loadSingleTableConfig(configRoot)).runtime.collection.max_retries
  ).toBe(3)
  expect(
    (await loadSingleTableConfig(configRoot)).providers.routes.x_list
  ).toEqual(['twitterapi.io', 'tikhub-x'])
})

it('loads all YAML configuration and preserves source order', async () => {
  const config = await loadSingleTableConfig(
    path.resolve(import.meta.dirname, '../../../config')
  )
  expect(config.sources.sources).toHaveLength(34)
  expect(config.sources.sources[0]?.id).toBe('x_openai')
  expect(
    config.sources.sources
      .filter((source) => source.enabled)
      .map((source) => source.id)
  ).toEqual(['x_openai', 'yt_openai', 'openai_news'])
  expect(config.runtime.collection.list_pages).toBe(1)
  expect(config.runtime.collection.serial_sources).toBe(true)
  expect(config.providers.routes).toEqual({
    x_list: ['twitterapi.io', 'tikhub-x'],
    x_article: ['twitterapi.io', 'native-http'],
    youtube_list: ['youtube-data-api', 'tikhub-youtube'],
    youtube_captions: ['tikhub-youtube'],
    rss_list: ['native-rss'],
    web_article: ['native-http'],
  })
  expect(config.providers.routes).not.toHaveProperty('interaction')
  expect(config.analysis.scoring.weights).toEqual({
    interest_fit: 40,
    concrete_gain: 30,
    substance: 20,
    new_information: 10,
  })
  expect(config.analysis.translation.minimum_total_score).toBe(10)
  expect(config.analysis.transcription.auto).toBe(false)
  expect(config.analysis.model).toEqual({
    provider: 'codex',
    default: 'gpt-5.5',
    stages: {},
  })
})

it('keeps audio transcription off by default and preserves model settings when toggled', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'airadar-transcription-'))
  roots.push(root)
  const configRoot = await initializeSingleTableConfig(
    path.resolve(import.meta.dirname, '../../../config'),
    root
  )
  expect((await loadSingleTableConfig(configRoot)).analysis.transcription.auto).toBe(false)
  const originalModel = (await loadSingleTableConfig(configRoot)).analysis.model
  await saveAnalysisTranscriptionConfig(configRoot, true)
  const updated = await loadSingleTableConfig(configRoot)
  expect(updated.analysis.transcription.auto).toBe(true)
  expect(updated.analysis.model).toEqual(originalModel)
})

it('normalizes legacy preferred providers into ordered capability routes', () => {
  expect(
    providersConfigSchema.parse({
      platforms: {
        x: { preferred: 'tikhub-x' },
        youtube: { preferred: 'tikhub-youtube' },
        rss: { preferred: 'native-rss' },
      },
    })
  ).toEqual({
    routes: {
      x_list: ['tikhub-x', 'twitterapi.io'],
      x_article: ['twitterapi.io', 'native-http'],
      youtube_list: ['tikhub-youtube', 'youtube-data-api'],
      youtube_captions: ['tikhub-youtube'],
      rss_list: ['native-rss'],
      web_article: ['native-http'],
    },
  })
})

it('normalizes legacy model settings and saves per-stage routing', async () => {
  expect(
    analysisConfigSchema.shape.model.parse({
      provider: 'codex',
      name: 'legacy-model',
    })
  ).toEqual({ provider: 'codex', default: 'legacy-model', stages: {} })

  const root = await mkdtemp(path.join(tmpdir(), 'qiushuiai-airadar-models-'))
  roots.push(root)
  const configRoot = await initializeSingleTableConfig(
    path.resolve(import.meta.dirname, '../../../config'),
    root
  )
  await saveAnalysisModelConfig(configRoot, {
    provider: 'codex',
    default: 'gpt-5.5',
    stages: {
      score: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    },
  })
  expect((await loadSingleTableConfig(configRoot)).analysis.model).toEqual({
    provider: 'codex',
    default: 'gpt-5.5',
    stages: {
      score: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    },
  })
})

it('rejects pagination and invalid scoring weights', () => {
  expect(
    runtimeConfigSchema.safeParse({
      timezone: 'Asia/Shanghai',
      collection: {
        schedule: '0 8 * * *',
        list_pages: 2,
        max_retries: 2,
        serial_sources: true,
      },
    }).success
  ).toBe(false)
  expect(
    analysisConfigSchema.safeParse({
      model: { provider: 'codex', name: 'model' },
      prompts: { classify: 3, score: 3, translate: 3 },
      translation: { minimum_total_score: 60 },
      summarization: { long_content_min_chars: 1000 },
      scoring: {
        weights: {
          interest_fit: 50,
          concrete_gain: 30,
          substance: 20,
          new_information: 10,
        },
        core_threshold: 80,
        explore_threshold: 60,
        core_min_levels: { interest_fit: 5, concrete_gain: 4, substance: 3 },
        explore_min_levels: { interest_fit: 4, concrete_gain: 3, substance: 3 },
      },
    }).success
  ).toBe(false)
})

it('drops legacy collection limits instead of sending them to providers', () => {
  const source = {
    id: 'yt_ibm_tech',
    platform: 'youtube',
    account_name: 'YouTube / IBM Technology',
    external_identity: 'https://www.youtube.com/@IBMTechnology',
    language: 'en',
    enabled: true,
  }
  expect(
    sourcesConfigSchema.parse({ sources: [{ ...source, per_source_limit: 5 }] })
      .sources[0]
  ).not.toHaveProperty('per_source_limit')
  expect(
    runtimeConfigSchema.parse({
      timezone: 'Asia/Shanghai',
      collection: {
        schedule: '0 8 * * *',
        per_source_limit: 20,
        list_pages: 1,
        max_retries: 2,
        serial_sources: true,
      },
    }).collection
  ).not.toHaveProperty('per_source_limit')
})

it('initializes editable YAML under the new data root without overwriting edits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qiushuiai-airadar-config-'))
  roots.push(root)
  const templates = path.resolve(import.meta.dirname, '../../../config')
  const configRoot = await initializeSingleTableConfig(templates, root)
  expect(
    (await loadSingleTableConfig(configRoot)).sources.sources
  ).toHaveLength(34)
  await writeFile(path.join(configRoot, 'profile.yaml'), 'custom: true\n')
  await initializeSingleTableConfig(templates, root)
  expect(await readFile(path.join(configRoot, 'profile.yaml'), 'utf8')).toBe(
    'custom: true\n'
  )
  expect(await loadSourceState(configRoot)).toEqual({ sources: {} })
  await saveSourceState(configRoot, {
    sources: {
      x_openai: {
        last_seen_content_id: '123',
        last_collected_at: '2026-09-18T00:00:00.000Z',
      },
    },
  })
  expect(
    (await loadSourceState(configRoot)).sources.x_openai?.last_seen_content_id
  ).toBe('123')
})

it('removes legacy collection limits from an existing installation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qiushuiai-airadar-migrate-'))
  roots.push(root)
  const templates = path.resolve(import.meta.dirname, '../../../config')
  const configRoot = await initializeSingleTableConfig(templates, root)
  const runtimeFile = path.join(configRoot, 'runtime.yaml')
  const sourcesFile = path.join(configRoot, 'sources.yaml')
  await writeFile(
    runtimeFile,
    (await readFile(runtimeFile, 'utf8')).replace(
      "  schedule: '0 8 * * *'\n",
      "  schedule: '0 8 * * *'\n  per_source_limit: 20\n"
    )
  )
  await writeFile(
    sourcesFile,
    (await readFile(sourcesFile, 'utf8')).replace(
      '    enabled: true\n',
      '    enabled: true\n    per_source_limit: 5\n'
    )
  )
  await initializeSingleTableConfig(templates, root)
  expect(await readFile(runtimeFile, 'utf8')).not.toContain('per_source_limit')
  expect(await readFile(sourcesFile, 'utf8')).not.toContain('per_source_limit')
})
