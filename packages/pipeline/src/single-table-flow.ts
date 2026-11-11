import {
  checkPostCopy,
  parseTranslateOutput,
  needsShortTweetTranslation,
  isShortTweet,
  clampText,
  type ReaderCopy,
} from './x-post-writing.js'
import { contentCategories, contentThemes } from '@qiushui-airadar/domain'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { CredentialStore, Model, Models } from '@earendil-works/pi-ai'
import {
  createApplicationModels,
  type OllamaProviderConfig,
} from './pi-models.js'

import {
  contentIdentity,
  type SingleTableRepository,
  type ContentRow,
  type LogEvent,
  type OriginalContent,
  type ScoringRules,
} from '@qiushui-airadar/runtime'
import { createReadOnlyCodexCredentialStore } from './index.js'
import {
  automaticTranslationSkipReason,
  translateDocument,
  type AutomaticTranslationLimits,
  type ModelCapacity,
} from './document-translation.js'

const promptNames = {
  classify: '01-中文总结与内容判定.md',
  score: '02-内容分析与评分.md',
  translate: '03-英文内容意译.md',
} as const

const classificationSchema = z.object({
  category: z.enum(contentCategories).nullable(),
  themes: z
    .array(z.string())
    .transform((items) =>
      [...new Set(items)]
        .filter((theme) => contentThemes.some((allowed) => allowed === theme))
        .slice(0, 2)
    ),
  keywords: z
    .array(z.string())
    .transform((items) =>
      [...new Set(items.map((item) => item.trim()).filter(Boolean))].slice(0, 5)
    ),
  spam: z.object({ isJunk: z.boolean(), reason: z.string().nullable() }),
})
const scoringSchema = z
  .object({
    attentionScore: z.number().int().min(0).max(100),
  })
  .strict()
const translationSchema = z.object({
  chineseTitle: z.string().trim().min(1).nullable(),
  chineseBody: z.string().trim().min(1),
})

export interface SingleTableModelResponse {
  text: string
  request?: unknown
  response?: unknown
  provider: string
  model: string
  durationMs: number
}

type PostImage = { type: 'image'; data: string; mimeType: string }
async function firstPostImage(url?: string): Promise<PostImage | undefined> {
  if (!url || !/^https:\/\/pbs\.twimg\.com\//iu.test(url)) return
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    })
    const mimeType = res.headers.get('content-type')?.split(';')[0]
    if (
      !res.ok ||
      !mimeType ||
      !['image/png', 'image/webp', 'image/jpeg', 'image/gif'].includes(
        mimeType
      ) ||
      !res.body
    )
      return
    const reader = res.body.getReader(),
      chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 8_000_000) {
        await reader.cancel()
        return
      }
      chunks.push(value)
    }
    return {
      type: 'image',
      data: Buffer.concat(chunks).toString('base64'),
      mimeType,
    }
  } catch {
    return
  }
}
export interface SingleTableModelGateway {
  supportsImages?(stage: keyof typeof promptNames): boolean
  complete(input: {
    image?: PostImage
    system: string
    user: string
    stage: keyof typeof promptNames
    maxTokens?: number
  }): Promise<SingleTableModelResponse>
  getCapacity?(stage: keyof typeof promptNames): ModelCapacity
}

export interface SingleTableModelRouting {
  default: string
  stages?: Partial<
    Record<
      keyof typeof promptNames,
      string | { provider: string; model: string }
    >
  >
}

export function resolveSingleTableModel(
  routing: SingleTableModelRouting,
  stage: keyof typeof promptNames
): string {
  const route = routing.stages?.[stage]
  return typeof route === 'string' ? route : (route?.model ?? routing.default)
}

function resolveSingleTableModelRoute(
  providerId: string,
  routing: SingleTableModelRouting,
  stage: keyof typeof promptNames
): { provider: string; model: string } {
  const route = routing.stages?.[stage]
  return typeof route === 'object'
    ? {
        provider: normalizeSingleTableProviderId(route.provider),
        model: route.model,
      }
    : {
        provider: normalizeSingleTableProviderId(providerId),
        model: route ?? routing.default,
      }
}

export function listSingleTableCodexModels(): Array<{
  id: string
  name: string
}> {
  const models = createApplicationModels()
  return models
    .getModels('openai-codex')
    .map((model) => ({ id: model.id, name: model.name }))
}

export function normalizeSingleTableProviderId(providerId: string): string {
  return providerId === 'codex' ? 'openai-codex' : providerId
}

export function modelProviderSecretName(providerId: string): string {
  return `MODEL_PROVIDER_${providerId.replace(/[^a-z0-9]+/giu, '_').toUpperCase()}_API_KEY`
}

export function listSingleTableModelProviders(
  ollama?: OllamaProviderConfig
): Array<{
  id: string
  name: string
  authMethods: Array<'api_key' | 'oauth'>
  apiKeyLabel?: string
  apiKeyConfigurable: boolean
  oauthLabel?: string
  subscription: boolean
  modelCount: number
}> {
  const models = createApplicationModels({ ollama })
  return models.getProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    authMethods: [
      ...(provider.auth.apiKey?.login ? (['api_key'] as const) : []),
      ...(provider.auth.oauth ? (['oauth'] as const) : []),
    ],
    apiKeyLabel: provider.auth.apiKey?.name,
    apiKeyConfigurable: Boolean(provider.auth.apiKey?.login),
    oauthLabel: provider.auth.oauth?.loginLabel ?? provider.auth.oauth?.name,
    subscription: Boolean(provider.auth.oauth?.isSubscription),
    modelCount: provider.getModels().length,
  }))
}

export function listSingleTableModels(
  providerId: string,
  ollama?: OllamaProviderConfig
): Array<{
  id: string
  name: string
}> {
  const normalized = normalizeSingleTableProviderId(providerId)
  return createApplicationModels({ ollama })
    .getModels(normalized)
    .map((model) => ({
      id: model.id,
      name: model.name,
    }))
}

export function createSingleTableModelGateway(
  credentials: CredentialStore,
  providerId: string,
  routing: string | SingleTableModelRouting,
  ollama?: OllamaProviderConfig
): SingleTableModelGateway {
  const normalizedProvider = normalizeSingleTableProviderId(providerId)
  const models = createApplicationModels({ credentials, ollama })
  const routes: SingleTableModelRouting =
    typeof routing === 'string' ? { default: routing } : routing
  const modelRoutes = [
    { provider: normalizedProvider, model: routes.default },
    ...Object.values(routes.stages ?? {}).map((route) =>
      typeof route === 'string'
        ? { provider: normalizedProvider, model: route }
        : {
            provider: normalizeSingleTableProviderId(route.provider),
            model: route.model,
          }
    ),
  ]
  for (const route of modelRoutes) {
    if (!models.getModel(route.provider, route.model))
      throw new Error(`Model is unavailable: ${route.provider}/${route.model}`)
  }
  return createGateway(models, normalizedProvider, routes)
}

function createGateway(
  models: Models,
  providerId: string,
  routes: SingleTableModelRouting
): SingleTableModelGateway {
  return {
    supportsImages(stage) {
      const r = resolveSingleTableModelRoute(providerId, routes, stage)
      return (
        models.getModel(r.provider, r.model)?.input.includes('image') ?? false
      )
    },
    getCapacity(stage) {
      const route = resolveSingleTableModelRoute(providerId, routes, stage)
      const model = models.getModel(route.provider, route.model)!
      return {
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        provider: model.provider,
        model: model.id,
      }
    },
    async complete(input) {
      const route = resolveSingleTableModelRoute(
        providerId,
        routes,
        input.stage
      )
      const model = models.getModel(route.provider, route.model)!
      const maxTokens =
        input.maxTokens ??
        (input.stage === 'translate'
          ? 32_000
          : input.stage === 'classify'
            ? 8_000
            : 4_000)
      const request = {
        context: {
          systemPrompt: input.system,
          messages: [
            {
              role: 'user' as const,
              content: input.image
                ? [{ type: 'text' as const, text: input.user }, input.image]
                : input.user,
              timestamp: 0,
            },
          ],
        },
        options: {
          reasoning: 'off' as const,
          maxTokens,
          maxRetries: 0,
        },
      }
      const started = Date.now()
      const executionOptions = { maxTokens, maxRetries: 0 }
      const message =
        model.api === 'openai-codex-responses'
          ? await models.complete(
              model as Model<'openai-codex-responses'>,
              request.context,
              {
                ...executionOptions,
                reasoningEffort: 'none',
              }
            )
          : await models.completeSimple(
              model,
              request.context,
              executionOptions
            )
      const response = {
        provider: message.provider,
        model: message.model,
        stopReason: message.stopReason,
        errorMessage: message.errorMessage,
        content: message.content
          .filter((block) => block.type === 'text')
          .map((block) => ({ type: 'text', text: block.text })),
        omittedNonTextBlocks: message.content.filter(
          (block) => block.type !== 'text'
        ).length,
        usage: message.usage,
      }
      if (message.stopReason === 'error') {
        const error = new Error(
          message.errorMessage || 'Model request failed'
        ) as Error & { response: unknown }
        error.response = response
        throw error
      }
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (!text) {
        const error = new Error('Model returned no text') as Error & {
          response: unknown
        }
        error.response = response
        throw error
      }
      return {
        text,
        request: input.image
          ? {
              stage: input.stage,
              user: input.user,
              system: input.system,
              imageMimeType: input.image.mimeType,
            }
          : request,
        response,
        provider: message.provider,
        model: message.model,
        durationMs: Date.now() - started,
      }
    },
  }
}

export function createSingleTableCodexGateway(
  authPath: string,
  routing: string | SingleTableModelRouting
): SingleTableModelGateway {
  const models = createApplicationModels({
    credentials: createReadOnlyCodexCredentialStore(authPath),
  })
  const routes: SingleTableModelRouting =
    typeof routing === 'string' ? { default: routing } : routing
  const modelRoutes = [
    { provider: 'openai-codex', model: routes.default },
    ...Object.values(routes.stages ?? {}).map((route) =>
      typeof route === 'string'
        ? { provider: 'openai-codex', model: route }
        : {
            provider: normalizeSingleTableProviderId(route.provider),
            model: route.model,
          }
    ),
  ]
  for (const route of modelRoutes) {
    if (
      route.provider !== 'openai-codex' ||
      !models.getModel(route.provider, route.model)
    )
      throw new Error(
        `Codex model is unavailable: ${route.provider}/${route.model}`
      )
  }
  return createGateway(models, 'openai-codex', routes)
}

export interface ContentFlowOptions {
  repository: SingleTableRepository
  gateway: SingleTableModelGateway
  promptsRoot: string
  original: OriginalContent
  profile: { interests: string[]; goals: string[]; exclusions: string[] }
  profileVersion?: string
  scoring: ScoringRules
  longContentMinChars: number
  translationMinimumTotalScore: number
  automaticTranslationLimits?: AutomaticTranslationLimits
  capturedCalls?: LogEvent[]
  deferTranslation?: boolean
}

function getMarkdownSection(
  markdown: string,
  name: string,
  next: string
): string {
  markdown = markdown.replaceAll('\r\n', '\n')
  const start = markdown.indexOf(`## ${name}\n`)
  const end = markdown.indexOf(`## ${next}\n`, start + 3)
  if (start < 0 || end < 0) throw new Error(`Prompt section missing: ${name}`)
  return markdown.slice(start + name.length + 4, end).trim()
}

function promptTemplate(markdown: string): string {
  const section = getMarkdownSection(
    markdown,
    '发给模型的用户提示词模板',
    '输出与写入'
  )
  const match = /```text\n([\s\S]*?)\n```/u.exec(section)
  if (!match) throw new Error('User prompt template is missing')
  return match[1]!
}

function render(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{([a-z_]+)\}\}/gu, (_, name: string) => {
    if (!(name in variables))
      throw new Error(`Prompt variable missing: ${name}`)
    return variables[name]!
  })
}

export function renderPromptMarkdown(
  markdown: string,
  variables: Record<string, string>
): { system: string; user: string } {
  const system = getMarkdownSection(
    markdown,
    '发给模型的系统提示词',
    '发给模型的用户提示词模板'
  )
  return { system, user: render(promptTemplate(markdown), variables) }
}

export function parseTranslationResponse(text: string): {
  chineseTitle: string | null
  chineseBody: string
} {
  return translationSchema.parse(parseModelJson(text))
}

function parseFrontmatter(markdown: string): {
  attributes: unknown
  body: string
} {
  const clean = markdown
    .trim()
    .replace(/^```(?:markdown|yaml)?\s*\n([\s\S]*?)\n```$/iu, '$1')
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/u.exec(clean)
  if (!match) throw new Error('Model response has no YAML front matter')
  return {
    attributes: parseYaml(match[1]!),
    body: clean.slice(match[0].length).trim(),
  }
}

export function parseModelJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/iu.exec(trimmed)
  const json = fenced ? fenced[1]! : trimmed
  try {
    return JSON.parse(json)
  } catch {
    // Repair string escaping only. Keep malformed JSON structure as an error.
    let inside = false
    let repaired = ''
    for (let i = 0; i < json.length; i++) {
      const character = json[i]!
      if (inside && character === '\\') {
        const next = json[i + 1]
        const validUnicode =
          next === 'u' && /^[0-9a-f]{4}$/iu.test(json.slice(i + 2, i + 6))
        if (next && ('"\\/bfnrt'.includes(next) || validUnicode)) {
          repaired += character + next
          i++
        } else {
          repaired += '\\\\'
        }
      } else if (inside && character.charCodeAt(0) < 32) {
        repaired += JSON.stringify(character).slice(1, -1)
      } else {
        repaired += character
        if (character === '"') inside = !inside
      }
    }
    return JSON.parse(repaired)
  }
}

function longMode(original: OriginalContent, minimum: number): boolean {
  return (
    original.explicitLong === true ||
    original.kind === 'article' ||
    original.format === 'subtitle' ||
    (original.kind !== 'short_post' && original.body.length >= minimum) ||
    original.body.length >= minimum
  )
}

function modelResponse(error: unknown): unknown {
  if (error && typeof error === 'object' && 'response' in error)
    return (error as { response: unknown }).response
  return {
    received: false,
    errorType: error instanceof Error ? error.name : 'unknown',
  }
}

async function call<T>(
  options: ContentFlowOptions,
  row: ContentRow,
  stage: keyof typeof promptNames,
  variables: Record<string, string>,
  validate: (text: string) => T,
  maxTokens?: number,
  name: string = promptNames[stage],
  image?: PostImage
): Promise<{ value: T; metadata: SingleTableModelResponse }> {
  const prompt = await readFile(path.join(options.promptsRoot, name), 'utf8')
  const system = getMarkdownSection(
    prompt,
    '发给模型的系统提示词',
    '发给模型的用户提示词模板'
  )
  const user = render(promptTemplate(prompt), variables)
  const request = { stage, system, user }
  const started = Date.now()
  let received: SingleTableModelResponse | undefined
  try {
    received = await options.gateway.complete({
      stage,
      system,
      user,
      maxTokens,
      image,
    })
    const parsed = validate(received.text)
    await options.repository.appendLog(row.id, {
      action: stage,
      stage:
        stage === 'classify'
          ? 'classifying'
          : stage === 'score'
            ? 'scoring'
            : 'translating',
      status: 'succeeded',
      durationMs: received.durationMs,
      processor: `${received.provider}/${received.model}`,
      prompt: name,
      request: received.request ?? request,
      response: received.response ?? { text: received.text },
    })
    return { value: parsed, metadata: received }
  } catch (error) {
    if (stage === 'translate') options.repository.failTranslation(row.id, error)
    else options.repository.fail(row.id, stage, error)
    await options.repository.appendLog(row.id, {
      action: stage,
      stage,
      status: 'failed',
      durationMs: Date.now() - started,
      prompt: name,
      request: received?.request ?? request,
      response:
        received?.response ??
        (received ? { text: received.text } : modelResponse(error)),
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

async function writeXPost(
  options: ContentFlowOptions,
  row: ContentRow,
  variables: Record<string, string>,
  score: number
) {
  const { original } = options
  const text = original.body.trim()
  const quote = original.quotedPost
  if (!text.replace(/https?:\/\/\S+/giu, '').trim())
    return {
      mode: 'original-link',
      title: text || original.title,
      summary: text,
    }
  const material = {
    title: original.originalTitle || original.title,
    text,
    mainText: text,
    sourceKind: 'x_search',
    documentUrl: original.canonicalUrl,
    sourceName: original.sourceAccountName,
    quotedText: quote?.text,
  }
  const finish = async (mode: string, draft: ReaderCopy) => {
    const copy = await checkPostCopy(material, draft, async (issues, first) => {
      try {
        const result = await call(
          options,
          row,
          'classify',
          {
            ...variables,
            draft: JSON.stringify({
              titleZh: first.titleZh,
              summaryZh: first.summaryZh,
              reasonZh: first.reasonZh,
            }),
            issues: issues.map((issue) => '- ' + issue).join('\n'),
          },
          (output) =>
            z
              .object({
                titleZh: z.string().min(1),
                summaryZh: z.string().min(1),
                reasonZh: z.string().nullable(),
              })
              .parse(parseModelJson(output)),
          2048,
          '07-AIHOT-X措辞修订.md'
        )
        return result.value
      } catch (error) {
        if (
          error instanceof SyntaxError ||
          error instanceof z.ZodError ||
          /refus|content.filter/iu.test(String(error))
        )
          return first
        throw error
      }
    })
    if (!copy.summaryZh.trim())
      throw new Error('X 帖子文案未通过检查或正文为空，请保留现有文案并复核')
    return {
      mode,
      title: copy.titleZh,
      summary: copy.summaryZh,
      reason: copy.reasonZh ?? undefined,
    }
  }
  if (score > 50) {
    const context = [
      original.publishedAt && '【发布时间】' + original.publishedAt,
      original.images?.length && '【媒体】' + original.images.length + ' 张图',
      original.canonicalUrl && '【原文链接】' + original.canonicalUrl,
      quote?.text &&
        '【引用 ' +
          (quote.authorHandle || '原推') +
          '】（他人内容）\n' +
          quote.text,
      '【正文（作者自己的内容）】\n' + text.slice(0, 60000),
    ]
      .filter(Boolean)
      .join('\n')
    const understand = (image?: PostImage) =>
      call(
        options,
        row,
        'classify',
        { ...variables, original_body_or_transcript: context },
        (output) =>
          z
            .object({
              titleZh: z.string().min(1),
              summaryZh: z.string().min(1),
              editorialJudgment: z.string(),
            })
            .parse(parseModelJson(output)),
        16384,
        original.kind === 'video'
          ? '08-视频金字塔摘要.md'
          : '04-AIHOT长文总结.md',
        image
      )
    try {
      const image = options.gateway.supportsImages?.('classify')
        ? await firstPostImage(original.images?.[0]?.url)
        : undefined
      let result
      try {
        result = await understand(image)
      } catch (error) {
        if (
          !image ||
          /content.filter/iu.test(String(error)) ||
          !/image|图片|unsupported|refus/iu.test(String(error))
        )
          throw error
        result = await understand()
      }
      return await finish('understand', {
        ...result.value,
        reasonZh: result.value.editorialJudgment || null,
      })
    } catch (error) {
      if (!/content.filter|content.policy|safety policy/iu.test(String(error)))
        throw error
    }
  }
  const short = isShortTweet(text)
  if (short && !needsShortTweetTranslation(text)) {
    const main = text.replace(/\s+/gu, ' ')
    return { mode: 'verbatim', title: main, summary: main }
  }
  const stem = short ? '06-AIHOT-X短帖' : '06-AIHOT-X长帖'
  const quoted = quote?.text
    ? render(
        await readFile(
          path.join(options.promptsRoot, stem + '引用.md'),
          'utf8'
        ),
        {
          quoted_label: quote.authorHandle
            ? '@' + quote.authorHandle
            : '引用推文',
          quoted_text: clampText(quote.text, 1500),
        }
      )
    : ''
  const result = await call(
    options,
    row,
    'classify',
    {
      ...variables,
      post: clampText(text, 4000),
      quote: quoted ? '\n\n' + quoted : '',
    },
    parseTranslateOutput,
    2048,
    stem + '.md'
  )
  return finish(short ? 'short' : 'long', {
    titleZh: result.value.titleZh,
    summaryZh:
      (short ? result.value.bodyZh : result.value.summaryZh) ||
      result.value.bodyZh ||
      result.value.summaryZh,
    reasonZh: null,
  })
}

export async function processSingleTableContent(
  options: ContentFlowOptions
): Promise<ContentRow> {
  const original = options.original
  const existing = options.repository.get(contentIdentity(original).key)
  if (existing?.is_unprocessed) return existing
  const row = await options.repository.saveOriginal(original)
  for (const event of options.capturedCalls ?? [])
    await options.repository.appendLog(row.id, event)
  const variables = {
    original_title_or_none: original.originalTitle ?? '无',
    source_platform: original.platform,
    source_account_name: original.sourceAccountName,
    content_kind: original.kind,
    original_language: original.language,
    original_body_or_transcript: original.quotedPost?.text
      ? original.body + '\n\n引用推文：\n' + original.quotedPost.text
      : original.body,
    profile_exclusions: options.profile.exclusions.join('；'),
    source_format: original.format,
    subtitle_segments_or_none:
      original.format === 'subtitle' ? original.body : '无',
    english_body: original.body,
  }
  const isLong = longMode(original, options.longContentMinChars)
  const { value: classified } = await call(
    options,
    row,
    'classify',
    {
      ...variables,
      summary_mode: isLong ? 'long' : 'short',
    },
    (text) => {
      const parsed = parseFrontmatter(text)
      const value = classificationSchema.parse(parsed.attributes)
      if (!value.spam.isJunk && !value.category)
        throw Error('Missing content category')
      return value
    }
  )
  const junk =
    row.junk_source === 'manual' ? Boolean(row.is_junk) : classified.spam.isJunk
  let summary = original.body
  const isXPost =
    original.platform === 'x' &&
    (original.kind === 'short_post' || original.kind === 'image_post')
  if (!isXPost && (isLong || original.kind === 'video') && !junk) {
    const result = await call(
      options,
      row,
      'classify',
      variables,
      (text) =>
        z
          .object({ summaryZh: z.string().trim().min(1) })
          .parse(parseModelJson(text)),
      undefined,
      original.kind === 'video' ? '08-视频金字塔摘要.md' : '04-AIHOT长文总结.md'
    )
    summary = result.value.summaryZh
  }
  const afterClassification = await options.repository.saveClassification(
    row.id,
    {
      keywords: classified.keywords,
      tags: classified.category
        ? [...new Set([classified.category, ...classified.themes])]
        : [],
      isJunk: classified.spam.isJunk,
      reason: classified.spam.reason ?? undefined,
      summary,
    }
  )
  if (afterClassification.is_junk) return afterClassification

  const analysisCall = await call(options, row, 'score', variables, (text) =>
    scoringSchema.parse(parseModelJson(text))
  )
  const post = isXPost
    ? await writeXPost(
        options,
        row,
        variables,
        analysisCall.value.attentionScore
      )
    : undefined
  const scored = await options.repository.saveAttentionScore(
    row.id,
    analysisCall.value.attentionScore,
    analysisCall.metadata,
    post
  )
  if (original.language !== 'en') return scored
  if (
    original.kind === 'video' &&
    original.format !== 'plain_text' &&
    analysisCall.value.attentionScore <= 60
  )
    return options.repository.setTranslationSkipped(
      row.id,
      'below_score_threshold'
    )
  if (post?.mode === 'original-link')
    return options.repository.setTranslationSkipped(row.id, 'link_only')
  const skipReason = automaticTranslationSkipReason(
    {
      contentId: row.id,
      title: original.originalTitle,
      body: original.body,
      format: original.format,
      kind: original.kind,
      videoDurationSeconds: original.videoDurationSeconds,
    },
    original.kind === 'video' && original.format === 'plain_text'
      ? {
          maximumVideoDurationSeconds: Infinity,
          maximumSourceCharacters: Infinity,
        }
      : original.platform === 'youtube'
        ? { maximumVideoDurationSeconds: 1800, maximumSourceCharacters: Infinity }
        : (options.automaticTranslationLimits ?? {
            maximumVideoDurationSeconds: 1_800,
            maximumSourceCharacters: 27_000,
          })
  )
  if (skipReason)
    return options.repository.setTranslationSkipped(row.id, skipReason)
  if (options.deferTranslation) return scored
  return translateSingleTableContent({
    ...options,
    row: scored,
    manual: false,
  })
}

// X uses mathematical Latin letters as decorative bold and italic. Keep code and URLs literal.
function readablePostText(text: string): string {
  return text.replace(
    /```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+|[\u{1D400}-\u{1D6A3}]/gu,
    (token) =>
      token.length === 2 && /^[A-Za-z]$/.test(token.normalize('NFKC'))
        ? token.normalize('NFKC')
        : token
  )
}

export async function translateSingleTableContent(
  options: ContentFlowOptions & { row: ContentRow; manual: boolean }
): Promise<ContentRow> {
  const { original, row } = options
  if (
    original.language !== 'en' ||
    row.is_junk ||
    row.is_unprocessed ||
    !original.body.trim() ||
    row.translated_to_chinese
  )
    throw new Error('Content does not qualify for translation')
  if (
    !options.manual &&
    original.kind === 'video' &&
    original.format !== 'plain_text'
  ) {
    if (row.total_score == null || row.total_score <= 60)
      return options.repository.setTranslationSkipped(
        row.id,
        'below_score_threshold'
      )
    const reason = automaticTranslationSkipReason(
      {
        contentId: row.id,
        body: original.body,
        format: original.format,
        kind: original.kind,
        videoDurationSeconds: original.videoDurationSeconds,
      },
      { maximumVideoDurationSeconds: 1800, maximumSourceCharacters: Infinity }
    )
    if (reason) return options.repository.setTranslationSkipped(row.id, reason)
  }
  const capacity = options.gateway.getCapacity?.('translate') ?? {
    contextWindow: 32_000,
    maxOutputTokens: 16_000,
    provider: 'unknown',
    model: 'unknown',
  }
  const isXPost =
    original.platform === 'x' &&
    (original.kind === 'short_post' || original.kind === 'image_post')
  const translationPrompt = isXPost
    ? '05-AIHOT-X帖子翻译.md'
    : promptNames.translate
  let metadata: SingleTableModelResponse | undefined
  try {
    const translated = await translateDocument({
      document: {
        contentId: row.id,
        title: original.originalTitle,
        body: original.body,
        format: original.format,
        kind: original.kind,
        videoDurationSeconds: original.videoDurationSeconds,
      },
      capacity,
      checkpointRoot: path.join(
        options.repository.dataRoot,
        'translation-work'
      ),
      promptVersion: `${isXPost ? 7 : 6}:${translationPrompt}`,
      onPlan(total) {
        options.repository.beginTranslation(row.id, total)
      },
      onProgress(completed, total) {
        options.repository.updateTranslationProgress(row.id, completed, total)
      },
      async translateChunk(body, index, count, previousTranslationTail) {
        const translationCall = await call(
          options,
          row,
          'translate',
          {
            original_title_or_none:
              index === 0 ? (original.originalTitle ?? '无') : '无',
            content_kind: original.kind,
            source_format: original.format,
            english_body: isXPost ? readablePostText(body) : body,
            translation_chunk_position: `${index + 1}/${count}`,
            previous_translation_tail: previousTranslationTail || '无',
          },
          (text) => translationSchema.parse(parseModelJson(text)),
          Math.min(
            capacity.maxOutputTokens,
            Math.max(2_000, Buffer.byteLength(body, 'utf8') + 1_000)
          ),
          translationPrompt
        )
        metadata = translationCall.metadata
        return translationCall.value
      },
    })
    return options.repository.saveTranslation(
      row.id,
      translated.chineseBody,
      translated.chineseTitle,
      0,
      {
        provider: metadata?.provider ?? capacity.provider,
        model: metadata?.model ?? capacity.model,
        manual: options.manual,
        chunkCount: translated.chunkCount,
      }
    )
  } catch (error) {
    options.repository.failTranslation(row.id, error)
    throw error
  }
}
