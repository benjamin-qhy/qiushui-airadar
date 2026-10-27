import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'

const level = z.number().int().min(1).max(5)
const dimensions = [
  'interest_fit',
  'concrete_gain',
  'substance',
  'new_information',
] as const
const weights = z.object(
  Object.fromEntries(
    dimensions.map((name) => [name, z.number().min(0).max(100)])
  ) as Record<(typeof dimensions)[number], z.ZodNumber>
)

const modelStageNames = ['classify', 'score', 'translate'] as const
const modelRouteSchema = z.union([
  z.string().min(1),
  z.object({ provider: z.string().min(1), model: z.string().min(1) }),
])

export const analysisModelConfigSchema = z
  .object({
    provider: z.string().min(1),
    default: z.string().min(1).optional(),
    // `name` is the pre-model-routing field. Keep reading it so existing
    // installations upgrade without requiring a manual config edit.
    name: z.string().min(1).optional(),
    stages: z
      .object({
        classify: modelRouteSchema.optional(),
        score: modelRouteSchema.optional(),
        translate: modelRouteSchema.optional(),
      })
      .default({}),
  })
  .refine((value) => Boolean(value.default ?? value.name), {
    message: 'A default model is required',
  })
  .transform((value) => ({
    provider: value.provider,
    default: value.default ?? value.name!,
    stages: Object.fromEntries(
      modelStageNames.flatMap((stage) =>
        value.stages[stage] ? [[stage, value.stages[stage]]] : []
      )
    ) as Partial<
      Record<
        (typeof modelStageNames)[number],
        string | { provider: string; model: string }
      >
    >,
  }))

export type AnalysisModelConfig = z.output<typeof analysisModelConfigSchema>

export const analysisConfigSchema = z.object({
  model: analysisModelConfigSchema,
  transcription: z
    .object({ auto: z.boolean().default(false) })
    .default({ auto: false }),
  prompts: z.object({
    classify: z.number().int().positive(),
    score: z.number().int().positive(),
    translate: z.number().int().positive(),
  }),
  translation: z.object({
    minimum_total_score: z.number().int().min(0).max(100),
    automatic_video_max_duration_seconds: z
      .number()
      .int()
      .positive()
      .default(1_800),
    automatic_max_source_characters: z
      .number()
      .int()
      .positive()
      .default(27_000),
  }),
  summarization: z.object({
    long_content_min_chars: z.number().int().positive(),
  }),
  scoring: z.object({
    weights: weights.refine(
      (value) => Object.values(value).reduce((a, b) => a + b, 0) === 100,
      'Weights must total 100'
    ),
    core_threshold: z.number().int().min(0).max(100),
    explore_threshold: z.number().int().min(0).max(100),
    core_min_levels: z.object({
      interest_fit: level,
      concrete_gain: level,
      substance: level,
    }),
    explore_min_levels: z.object({
      interest_fit: level,
      concrete_gain: level,
      substance: level,
    }),
  }),
})

export const profileConfigSchema = z.object({
  version: z.number().int().positive(),
  interests: z.array(z.string().min(1)).min(1),
  goals: z.array(z.string().min(1)).min(1),
  exclusions: z.array(z.string().min(1)),
})

export const runtimeConfigSchema = z.object({
  timezone: z.literal('Asia/Shanghai'),
  collection: z.object({
    schedule: z.string().min(1),
    list_pages: z.literal(1),
    max_retries: z.number().int().min(0).max(10),
    serial_sources: z.literal(true),
  }),
})

export const sourcesConfigSchema = z.object({
  sources: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/u),
      platform: z.enum(['x', 'youtube', 'rss']),
      account_name: z.string().min(1),
      external_identity: z.string().min(1),
      language: z.enum(['zh', 'en']),
      enabled: z.boolean(),
    })
  ),
})

export const retentionConfigSchema = z.object({
  junk: z.object({
    delete_after_days: z.number().int().nonnegative(),
    automatic_delete: z.boolean(),
  }),
})

const orderedProviders = <T extends [string, ...string[]]>(values: T) =>
  z
    .array(z.enum(values))
    .min(1)
    .max(values.length)
    .refine((items) => new Set(items).size === items.length, {
      message: 'Provider routes cannot contain duplicates',
    })

export const providerRoutesSchema = z
  .object({
    x_list: orderedProviders(['twitterapi.io', 'tikhub-x']),
    x_article: orderedProviders(['twitterapi.io', 'native-http']),
    youtube_list: orderedProviders(['youtube-data-api', 'tikhub-youtube']),
    youtube_captions: orderedProviders(['tikhub-youtube']),
    rss_list: orderedProviders(['native-rss']),
    web_article: orderedProviders(['native-http']),
  })
  .strict()

export type ProviderRoutes = z.output<typeof providerRoutesSchema>

export const defaultProviderRoutes: ProviderRoutes = {
  x_list: ['twitterapi.io', 'tikhub-x'],
  x_article: ['twitterapi.io', 'native-http'],
  youtube_list: ['youtube-data-api', 'tikhub-youtube'],
  youtube_captions: ['tikhub-youtube'],
  rss_list: ['native-rss'],
  web_article: ['native-http'],
}

export const providersConfigSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return value
    const record = value as Record<string, unknown>
    if (record.routes) return value
    const platforms = record.platforms as
      Record<string, { preferred?: string } | undefined> | undefined
    if (!platforms) return value
    const xPreferred = platforms.x?.preferred
    const youtubePreferred = platforms.youtube?.preferred
    return {
      routes: {
        ...defaultProviderRoutes,
        x_list:
          xPreferred === 'tikhub-x'
            ? ['tikhub-x', 'twitterapi.io']
            : defaultProviderRoutes.x_list,
        youtube_list:
          youtubePreferred === 'tikhub-youtube'
            ? ['tikhub-youtube', 'youtube-data-api']
            : defaultProviderRoutes.youtube_list,
      },
    }
  },
  z.object({ routes: providerRoutesSchema }).strict()
)

export const singleTableConfigFileNames = [
  'sources.yaml',
  'providers.yaml',
  'runtime.yaml',
  'analysis.yaml',
  'profile.yaml',
  'retention.yaml',
] as const

export const editableConfigFileNames = [
  'providers.yaml',
  'runtime.yaml',
  'analysis.yaml',
  'profile.yaml',
  'retention.yaml',
] as const

type SingleTableConfigFileName = (typeof singleTableConfigFileNames)[number]
export type EditableConfigFileName = (typeof editableConfigFileNames)[number]

const configSchemas = {
  'sources.yaml': sourcesConfigSchema,
  'providers.yaml': providersConfigSchema,
  'runtime.yaml': runtimeConfigSchema,
  'analysis.yaml': analysisConfigSchema,
  'profile.yaml': profileConfigSchema,
  'retention.yaml': retentionConfigSchema,
} as const

async function parseFile<T extends z.ZodType>(
  file: string,
  schema: T
): Promise<z.output<T>> {
  return schema.parse(parseYaml(await readFile(file, 'utf8')))
}

export async function loadSingleTableConfig(configRoot: string) {
  const [analysis, profile, runtime, sources, retention, providers] =
    await Promise.all([
      parseFile(path.join(configRoot, 'analysis.yaml'), analysisConfigSchema),
      parseFile(path.join(configRoot, 'profile.yaml'), profileConfigSchema),
      parseFile(path.join(configRoot, 'runtime.yaml'), runtimeConfigSchema),
      parseFile(path.join(configRoot, 'sources.yaml'), sourcesConfigSchema),
      parseFile(path.join(configRoot, 'retention.yaml'), retentionConfigSchema),
      parseFile(path.join(configRoot, 'providers.yaml'), providersConfigSchema),
    ])
  const ids = sources.sources.map((source) => source.id)
  if (new Set(ids).size !== ids.length)
    throw new Error('Duplicate source ID in sources.yaml')
  return { analysis, profile, runtime, sources, retention, providers }
}

export type SingleTableConfig = Awaited<
  ReturnType<typeof loadSingleTableConfig>
>

export async function initializeSingleTableConfig(
  templateRoot: string,
  dataRoot: string
): Promise<string> {
  const configRoot = path.join(dataRoot, 'config')
  await mkdir(configRoot, { recursive: true })
  for (const name of singleTableConfigFileNames) {
    try {
      await copyFile(
        path.join(templateRoot, name),
        path.join(configRoot, name),
        constants.COPYFILE_EXCL
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  for (const name of ['runtime.yaml', 'sources.yaml'] as const) {
    const target = path.join(configRoot, name)
    const content = await readFile(target, 'utf8')
    const migrated = content.replace(
      /^[\t ]+per_source_limit:[^\r\n]*(?:\r?\n|$)/gmu,
      ''
    )
    if (migrated !== content) await saveConfigFile(configRoot, name, migrated)
  }
  return configRoot
}

function validateConfigFile(
  name: SingleTableConfigFileName,
  content: string
): unknown {
  const value = configSchemas[name].parse(parseYaml(content))
  if (name === 'sources.yaml') {
    const ids = (value as z.output<typeof sourcesConfigSchema>).sources.map(
      (source) => source.id
    )
    if (new Set(ids).size !== ids.length)
      throw new Error('Duplicate source ID in sources.yaml')
  }
  return value
}

export function validateEditableConfigFile(
  name: EditableConfigFileName,
  content: string
): unknown {
  return validateConfigFile(name, content)
}

async function saveConfigFile(
  configRoot: string,
  name: SingleTableConfigFileName,
  content: string
): Promise<void> {
  validateConfigFile(name, content)
  const target = path.join(configRoot, name)
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(
    temporary,
    content.endsWith('\n') ? content : `${content}\n`,
    {
      flag: 'wx',
      mode: 0o600,
    }
  )
  await rename(temporary, target)
}

export async function saveEditableConfigFile(
  configRoot: string,
  name: EditableConfigFileName,
  content: string
): Promise<void> {
  await saveConfigFile(configRoot, name, content)
}

export async function saveSourcesConfig(
  configRoot: string,
  sources: z.output<typeof sourcesConfigSchema>['sources']
): Promise<void> {
  await saveConfigFile(configRoot, 'sources.yaml', stringifyYaml({ sources }))
}

export async function saveProvidersConfig(
  configRoot: string,
  providers: z.output<typeof providersConfigSchema>
): Promise<void> {
  await saveEditableConfigFile(
    configRoot,
    'providers.yaml',
    stringifyYaml(providers)
  )
}

export async function saveAnalysisModelConfig(
  configRoot: string,
  model: AnalysisModelConfig
): Promise<void> {
  const current = await parseFile(
    path.join(configRoot, 'analysis.yaml'),
    analysisConfigSchema
  )
  await saveEditableConfigFile(
    configRoot,
    'analysis.yaml',
    stringifyYaml({ ...current, model: analysisModelConfigSchema.parse(model) })
  )
}

export async function saveAnalysisTranscriptionConfig(
  configRoot: string,
  auto: boolean
): Promise<void> {
  const current = await parseFile(
    path.join(configRoot, 'analysis.yaml'),
    analysisConfigSchema
  )
  await saveEditableConfigFile(
    configRoot,
    'analysis.yaml',
    stringifyYaml({ ...current, transcription: { auto } })
  )
}

export interface SourceState {
  sources: Record<
    string,
    {
      last_seen_content_id?: string
      last_collected_at?: string
      enabled_override?: boolean | null
    }
  >
}

export async function loadSourceState(
  configRoot: string
): Promise<SourceState> {
  const file = path.join(configRoot, 'local', 'source-state.yaml')
  try {
    const parsed = parseYaml(await readFile(file, 'utf8')) as unknown
    return z
      .object({
        sources: z.record(
          z.string(),
          z.object({
            last_seen_content_id: z.string().optional(),
            last_collected_at: z.iso.datetime().optional(),
            enabled_override: z.boolean().nullable().optional(),
          })
        ),
      })
      .parse(parsed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { sources: {} }
    throw error
  }
}

export async function saveSourceState(
  configRoot: string,
  state: SourceState
): Promise<void> {
  const directory = path.join(configRoot, 'local')
  await mkdir(directory, { recursive: true })
  const target = path.join(directory, 'source-state.yaml')
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, stringifyYaml(state), { flag: 'wx', mode: 0o600 })
  await rename(temporary, target)
}
