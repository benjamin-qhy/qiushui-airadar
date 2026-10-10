import { createHash, randomUUID } from 'node:crypto'
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { canonicalizeContentUrl } from '@qiushuiai-airadar/domain'

export type Recommendation = 'core' | 'explore' | 'none'
export type ScoreDimension =
  'interest_fit' | 'concrete_gain' | 'substance' | 'new_information'

export interface Score {
  level: number
  reason: string
}

export interface ScoringRules {
  weights: Record<ScoreDimension, number>
  coreThreshold: number
  exploreThreshold: number
  coreMinLevels: Partial<Record<ScoreDimension, number>>
  exploreMinLevels: Partial<Record<ScoreDimension, number>>
}

export interface OriginalContent {
  platform: string
  sourceType: string
  sourceAccountId: string
  sourceAccountName: string
  externalContentId?: string
  canonicalUrl?: string
  title: string
  originalTitle?: string
  body: string
  explicitLong?: boolean
  kind: 'short_post' | 'video' | 'image_post' | 'article'
  format: 'plain_text' | 'markdown_article' | 'subtitle'
  language: 'zh' | 'en'
  videoDurationSeconds?: number
  publishedAt?: string
  discoveredAt?: string
}

export interface RuntimeLogSummaryRecord {
  index: number
  timestamp: string
  action: string
  status: string
  stage: string
  trigger: string
  duration: string
  retryCount: string
  processor?: string
  prompt?: string
  error?: string
  contentId: string
  contentTitle: string
  sourceId: string
  sourceName: string
}

export interface ContentInteraction {
  capturedAt: string
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  saves: number | null
}

export interface ContentRow {
  [key: string]: unknown
  id: string
  identity_key: string
  title: string
  original_title: string | null
  content_kind: OriginalContent['kind']
  original_language: 'zh' | 'en' | 'unknown'
  summary: string | null
  keywords_text: string
  value_summary: string | null
  is_junk: number
  junk_source: 'ai' | 'manual' | 'rule' | 'none'
  junk_reason: string | null
  total_score: number | null
  recommendation: Recommendation
  chinese_markdown_path: string | null
  english_markdown_path: string | null
  execution_log_markdown_path: string
  translation_status:
    | 'not_applicable'
    | 'pending'
    | 'skipped'
    | 'running'
    | 'succeeded'
    | 'failed'
  translation_skip_reason: string | null
  translation_error: string | null
  translation_chunk_count: number
  translation_completed_chunks: number
}

export interface LogEvent {
  action: string
  stage: string
  status: 'succeeded' | 'failed'
  trigger?: 'scheduled' | 'manual-retry' | 'manual-action'
  durationMs?: number
  retryCount?: number
  processor?: string
  prompt?: string
  request?: unknown
  response?: unknown
  error?: string
}

export interface RuntimeLogDocument {
  contentId: string
  title: string
  sourceId: string
  sourceName: string
  logPath: string
}

// Only this one application table is created. SQLite's internal tables are not
// used for queues, sources, logs or search projections.
const schema = `
CREATE TABLE IF NOT EXISTS contents (
  id TEXT PRIMARY KEY,
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('source_content_id', 'article_url')),
  identity_value TEXT NOT NULL,
  identity_key TEXT NOT NULL UNIQUE,
  source_platform TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  source_account_name TEXT NOT NULL,
  external_content_id TEXT,
  canonical_url TEXT,
  title TEXT NOT NULL,
  original_title TEXT,
  chinese_title TEXT,
  content_kind TEXT NOT NULL CHECK (content_kind IN ('short_post', 'video', 'image_post', 'article')),
  original_format TEXT NOT NULL DEFAULT 'plain_text' CHECK (original_format IN ('plain_text', 'markdown_article', 'subtitle')),
  original_language TEXT NOT NULL CHECK (original_language IN ('zh', 'en', 'unknown')),
  translated_to_chinese INTEGER NOT NULL DEFAULT 0 CHECK (translated_to_chinese IN (0, 1)),
  translation_status TEXT NOT NULL DEFAULT 'not_applicable' CHECK (translation_status IN ('not_applicable', 'pending', 'skipped', 'running', 'succeeded', 'failed')),
  translation_skip_reason TEXT,
  translation_error TEXT,
  translation_chunk_count INTEGER NOT NULL DEFAULT 0,
  translation_completed_chunks INTEGER NOT NULL DEFAULT 0,
  original_status TEXT NOT NULL DEFAULT 'available' CHECK (original_status IN ('available', 'deleted', 'private', 'unavailable')),
  published_at TEXT,
  discovered_at TEXT NOT NULL,
  first_inflow_at TEXT NOT NULL,
  chinese_markdown_path TEXT,
  english_markdown_path TEXT,
  execution_log_markdown_path TEXT NOT NULL,
  summary TEXT,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  keywords_text TEXT NOT NULL DEFAULT '',
  value_summary TEXT,
  interest_fit_level INTEGER CHECK (interest_fit_level BETWEEN 1 AND 5),
  interest_fit_reason TEXT,
  concrete_gain_level INTEGER CHECK (concrete_gain_level BETWEEN 1 AND 5),
  concrete_gain_reason TEXT,
  substance_level INTEGER CHECK (substance_level BETWEEN 1 AND 5),
  substance_reason TEXT,
  new_information_level INTEGER CHECK (new_information_level BETWEEN 1 AND 5),
  new_information_reason TEXT,
  total_score INTEGER CHECK (total_score BETWEEN 0 AND 100),
  recommendation TEXT NOT NULL DEFAULT 'none' CHECK (recommendation IN ('core', 'explore', 'none')),
  scoring_rule_json TEXT,
  analysis_extra_json TEXT NOT NULL DEFAULT '{}',
  is_junk INTEGER NOT NULL DEFAULT 0 CHECK (is_junk IN (0, 1)),
  junk_source TEXT NOT NULL DEFAULT 'none' CHECK (junk_source IN ('ai', 'manual', 'rule', 'none')),
  junk_reason TEXT,
  junk_note TEXT,
  junk_updated_at TEXT,
  read INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
  utilization_actions_json TEXT NOT NULL DEFAULT '[]',
  interaction_captured_at TEXT,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  saves INTEGER,
  images_json TEXT NOT NULL DEFAULT '[]',
  video_duration_seconds INTEGER,
  video_thumbnail_url TEXT,
  video_media_url TEXT,
  quoted_post_json TEXT,
  reposted_by_json TEXT,
  process_status TEXT NOT NULL DEFAULT 'processing' CHECK (process_status IN ('processing', 'completed', 'failed', 'waiting-manual-transcription')),
  processing_stage TEXT NOT NULL DEFAULT 'discovered' CHECK (processing_stage IN ('discovered', 'enriching', 'classifying', 'scoring', 'translating', 'completed', 'failed', 'waiting-manual-transcription')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  last_error TEXT,
  last_processed_at TEXT,
  delete_after TEXT,
  analyzed_at TEXT,
  analysis_provider TEXT,
  analysis_model TEXT,
  analysis_prompt_version TEXT,
  analysis_profile_version_id TEXT,
  analysis_rule_version TEXT,
  analysis_duration_ms INTEGER,
  analysis_input_tokens INTEGER,
  analysis_output_tokens INTEGER,
  analysis_cache_read_tokens INTEGER,
  analysis_cache_write_tokens INTEGER,
  analysis_cost_usd REAL,
  analysis_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contents_list_sort ON contents (is_junk, process_status, recommendation, first_inflow_at DESC, total_score DESC);
CREATE INDEX IF NOT EXISTS contents_source_time ON contents (source_platform, source_account_id, published_at DESC);
CREATE INDEX IF NOT EXISTS contents_status_retry ON contents (process_status, processing_stage, retry_count, last_processed_at);
CREATE INDEX IF NOT EXISTS contents_keyword_search ON contents (title, chinese_title, summary, keywords_text, value_summary, source_account_name);
CREATE INDEX IF NOT EXISTS contents_expiry ON contents (delete_after) WHERE delete_after IS NOT NULL;
`

const scoreDimensions: ScoreDimension[] = [
  'interest_fit',
  'concrete_gain',
  'substance',
  'new_information',
]

export function scoreContent(
  scores: Record<ScoreDimension, Score>,
  rules: ScoringRules
): { totalScore: number; recommendation: Recommendation } {
  const weightTotal = Object.values(rules.weights).reduce((a, b) => a + b, 0)
  if (weightTotal !== 100) throw new Error('Scoring weights must total 100')
  for (const dimension of scoreDimensions) {
    const score = scores[dimension]
    if (
      !Number.isInteger(score.level) ||
      score.level < 1 ||
      score.level > 5 ||
      !score.reason.trim()
    )
      throw new Error(`Invalid ${dimension} score`)
  }
  const totalScore = Math.round(
    scoreDimensions.reduce(
      (total, dimension) =>
        total +
        ((scores[dimension].level - 1) * 25 * rules.weights[dimension]) / 100,
      0
    )
  )
  const qualifies = (minima: Partial<Record<ScoreDimension, number>>) =>
    scoreDimensions.every(
      (dimension) => scores[dimension].level >= (minima[dimension] ?? 1)
    )
  const recommendation: Recommendation =
    totalScore >= rules.coreThreshold && qualifies(rules.coreMinLevels)
      ? 'core'
      : totalScore >= rules.exploreThreshold &&
          qualifies(rules.exploreMinLevels)
        ? 'explore'
        : 'none'
  return { totalScore, recommendation }
}

export function contentIdentity(input: OriginalContent): {
  kind: 'source_content_id' | 'article_url'
  value: string
  key: string
} {
  if (input.kind === 'article') {
    if (!input.canonicalUrl) throw new Error('Article URL is required')
    const value = canonicalizeContentUrl(input.canonicalUrl)
    return { kind: 'article_url', value, key: `article:${value}` }
  }
  if (!input.externalContentId)
    throw new Error('Platform content ID is required')
  return {
    kind: 'source_content_id',
    value: input.externalContentId,
    key: `source:${input.sourceAccountId}:content:${input.externalContentId}`,
  }
}

function segment(value: string, maximum = 60): string {
  return (
    [
      ...value
        .normalize('NFKC')
        .replace(/[\\/:<>"|?*]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim(),
    ]
      .filter((character) => {
        const code = character.codePointAt(0) ?? 0
        return code >= 32 && code !== 127
      })
      .slice(0, maximum)
      .join('') || 'unknown'
  )
}

export function contentDirectory(
  input: OriginalContent,
  identity: ReturnType<typeof contentIdentity>,
  at: string
): string {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(at))
    .replace(/-/gu, '')
  const marker =
    identity.kind === 'article_url'
      ? createHash('sha256').update(identity.value).digest('hex')
      : `${segment(identity.value, 80)}-${createHash('sha256').update(input.sourceAccountId).digest('hex').slice(0, 8)}`
  const parts = [
    segment(input.platform),
    segment(input.sourceAccountName),
    marker,
  ]
  if (input.originalTitle?.trim()) parts.push(segment(input.originalTitle))
  return path.posix.join('contents', date, parts.join('-'))
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, { flag: 'wx' })
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

function redact(value: unknown, key = ''): unknown {
  if (
    /(?:authorization|api.?key|cookie|token|secret|password|credential|private.?key)/iu.test(
      key
    )
  )
    return '[REDACTED]'
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(redact(JSON.parse(value)))
      } catch {
        /* Preserve non-JSON source text. */
      }
    }
    return value
      .replace(/(Bearer\s+)\S+/giu, '$1[REDACTED]')
      .replace(
        /([?&](?:token|access_token|refresh_token|api_?key|key|client_secret|secret|signature|authorization)=)[^&#\s]+/giu,
        '$1[REDACTED]'
      )
      .replace(
        /(["']?(?:access_token|refresh_token|api[_-]?key|authorization|cookie|secret|password)["']?\s*[:=]\s*["']?)([^"'\s,}]+)/giu,
        '$1[REDACTED]'
      )
  }
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redact(item, name)])
    )
  return value
}

function markdownDocument(
  properties: Record<string, unknown>,
  body: string
): string {
  return `---\n${stringifyYaml(properties, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trimEnd()}\n`
}

const maximumLogPayloadBytes = 32 * 1024

function boundedLogPayload(value: unknown): string {
  const serialized = JSON.stringify(redact(value), null, 2)
  const bytes = Buffer.from(serialized)
  if (bytes.byteLength <= maximumLogPayloadBytes) return serialized
  const prefix = bytes.subarray(0, maximumLogPayloadBytes).toString('utf8')
  return `${prefix}\n[TRUNCATED original_bytes=${bytes.byteLength}]`
}

export class SingleTableRepository {
  private constructor(
    private readonly database: DatabaseSync,
    readonly dataRoot: string
  ) {}

  static async open(dataRoot: string): Promise<SingleTableRepository> {
    await mkdir(dataRoot, { recursive: true })
    const database = new DatabaseSync(
      path.join(dataRoot, 'qiushuiai-airadar.sqlite')
    )
    try {
      const tables = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
        .all() as { name: string }[]
      if (tables.some((table) => table.name !== 'contents'))
        throw new Error(
          'Data root contains legacy tables; use a separate new data root'
        )
      database.exec(
        'PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;'
      )
      database.exec(schema)
      const columns = new Set(
        (
          database.prepare('PRAGMA table_info(contents)').all() as Array<{
            name: string
          }>
        ).map((column) => column.name)
      )
      const migrations: Array<[string, string]> = [
        ['translation_status', "TEXT NOT NULL DEFAULT 'not_applicable'"],
        ['translation_skip_reason', 'TEXT'],
        ['translation_error', 'TEXT'],
        ['translation_chunk_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['translation_completed_chunks', 'INTEGER NOT NULL DEFAULT 0'],
      ]
      for (const [name, definition] of migrations)
        if (!columns.has(name))
          database.exec(`ALTER TABLE contents ADD COLUMN ${name} ${definition}`)
      database.exec(
        `UPDATE contents SET translation_status = CASE
          WHEN translated_to_chinese = 1 THEN 'succeeded'
          WHEN original_language = 'en' AND translation_status = 'not_applicable' THEN 'pending'
          ELSE translation_status END`
      )
      return new SingleTableRepository(database, dataRoot)
    } catch (error) {
      database.close()
      throw error
    }
  }

  close(): void {
    this.database.close()
  }

  get(identityKey: string): ContentRow | undefined {
    return this.database
      .prepare('SELECT * FROM contents WHERE identity_key = ?')
      .get(identityKey) as ContentRow | undefined
  }

  getById(id: string): ContentRow | undefined {
    return this.database
      .prepare('SELECT * FROM contents WHERE id = ?')
      .get(id) as ContentRow | undefined
  }

  updateInteractionBySourceId(
    sourceAccountId: string,
    externalContentId: string,
    interaction: ContentInteraction
  ): number {
    const positive = (value: number | null): number | null =>
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : null
    const values = {
      views: positive(interaction.views),
      likes: positive(interaction.likes),
      comments: positive(interaction.comments),
      shares: positive(interaction.shares),
      saves: positive(interaction.saves),
    }
    if (Object.values(values).every((value) => value === null)) return 0
    const result = this.database
      .prepare(
        `UPDATE contents SET interaction_captured_at=?,
         views=COALESCE(?, views), likes=COALESCE(?, likes),
         comments=COALESCE(?, comments), shares=COALESCE(?, shares),
         saves=COALESCE(?, saves), updated_at=?
         WHERE source_account_id=? AND external_content_id=?`
      )
      .run(
        interaction.capturedAt,
        values.views,
        values.likes,
        values.comments,
        values.shares,
        values.saves,
        new Date().toISOString(),
        sourceAccountId,
        externalContentId
      )
    return Number(result.changes)
  }

  async readBody(
    id: string,
    language: 'zh' | 'en'
  ): Promise<string | undefined> {
    const row = this.getById(id)
    if (!row) return undefined
    const relative =
      language === 'zh' ? row.chinese_markdown_path : row.english_markdown_path
    if (!relative) return undefined
    const text = await readFile(path.join(this.dataRoot, relative), 'utf8')
    const match = /^---\n[\s\S]*?\n---\n\n/u.exec(text)
    if (!match) throw new Error(`Invalid content Markdown: ${relative}`)
    return text.slice(match[0].length).trimEnd()
  }

  async readLog(id: string): Promise<string | undefined> {
    const row = this.getById(id)
    if (!row) return undefined
    const text = await readFile(
      path.join(this.dataRoot, row.execution_log_markdown_path),
      'utf8'
    )
    return String(redact(text))
  }

  async readRuntimeLogSummaries(): Promise<RuntimeLogSummaryRecord[]> {
    try {
      const text = await readFile(
        path.join(this.dataRoot, 'runtime-log-summaries.jsonl'),
        'utf8'
      )
      return text
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as RuntimeLogSummaryRecord]
          } catch {
            return []
          }
        })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async replaceRuntimeLogSummaries(
    summaries: RuntimeLogSummaryRecord[]
  ): Promise<void> {
    const text = summaries.map((entry) => JSON.stringify(entry)).join('\n')
    await atomicWrite(
      path.join(this.dataRoot, 'runtime-log-summaries.jsonl'),
      text ? `${text}\n` : ''
    )
  }

  async saveOriginal(input: OriginalContent): Promise<ContentRow> {
    if (!input.body.trim()) throw new Error('Cannot save empty original body')
    const identity = contentIdentity(input)
    const existing = this.get(identity.key)
    const now = new Date().toISOString()
    const directory = existing
      ? path.posix.dirname(existing.execution_log_markdown_path)
      : contentDirectory(input, identity, now)
    const chinesePath =
      input.language === 'zh' ? path.posix.join(directory, '中文.md') : null
    const englishPath =
      input.language === 'en' ? path.posix.join(directory, '英文.md') : null
    const logPath = path.posix.join(directory, '执行日志.md')
    if (!existing) {
      this.database
        .prepare(
          `INSERT INTO contents (
        id, identity_kind, identity_value, identity_key, source_platform, source_type,
        source_account_id, source_account_name, external_content_id, canonical_url,
        title, original_title, content_kind, original_format, original_language,
        published_at, discovered_at, first_inflow_at, chinese_markdown_path,
        english_markdown_path, execution_log_markdown_path, summary,
        video_duration_seconds, translation_status, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          randomUUID(),
          identity.kind,
          identity.value,
          identity.key,
          input.platform,
          input.sourceType,
          input.sourceAccountId,
          input.sourceAccountName,
          input.externalContentId ?? null,
          input.canonicalUrl
            ? canonicalizeContentUrl(input.canonicalUrl)
            : null,
          input.title,
          input.originalTitle ?? null,
          input.kind,
          input.format,
          input.language,
          input.publishedAt ?? null,
          input.discoveredAt ?? now,
          now,
          chinesePath,
          englishPath,
          logPath,
          input.kind === 'short_post' ? input.body : null,
          input.videoDurationSeconds ?? null,
          input.language === 'en' ? 'pending' : 'not_applicable',
          now,
          now
        )
    } else {
      this.database
        .prepare(
          `UPDATE contents SET discovered_at=?, updated_at=?,
        source_account_name=?, published_at=COALESCE(?, published_at),
        video_duration_seconds=COALESCE(?, video_duration_seconds),
        chinese_markdown_path=COALESCE(chinese_markdown_path, ?),
        english_markdown_path=COALESCE(english_markdown_path, ?),
        process_status='processing', processing_stage='discovered', last_error=NULL WHERE id=?`
        )
        .run(
          input.discoveredAt ?? now,
          now,
          input.sourceAccountName,
          input.publishedAt ?? null,
          input.videoDurationSeconds ?? null,
          chinesePath,
          englishPath,
          existing.id
        )
    }
    const row = this.get(identity.key)!
    try {
      await this.writeContent(row, input.body, input.language)
      if (!existing)
        await atomicWrite(
          path.join(this.dataRoot, logPath),
          markdownDocument(
            { content_id: row.id, created_at: now },
            '# 执行日志\n'
          )
        )
      await this.appendLog(row.id, {
        action: 'save-original',
        stage: 'discovered',
        status: 'succeeded',
        request: '无',
        response: '无',
      })
    } catch (error) {
      this.fail(row.id, 'discovered', error)
      throw error
    }
    return this.get(identity.key)!
  }

  async recordUnavailable(
    input: Omit<OriginalContent, 'body'>,
    reason: string,
    waitingForTranscription = false,
    event?: Pick<LogEvent, 'request' | 'response'>
  ): Promise<ContentRow> {
    const identity = contentIdentity({ ...input, body: '' })
    const existing = this.get(identity.key)
    const now = new Date().toISOString()
    const directory = existing
      ? path.posix.dirname(existing.execution_log_markdown_path)
      : contentDirectory({ ...input, body: '' }, identity, now)
    const logPath = path.posix.join(directory, '执行日志.md')
    const status = waitingForTranscription
      ? 'waiting-manual-transcription'
      : 'failed'
    if (!existing) {
      this.database
        .prepare(
          `INSERT INTO contents (
        id, identity_kind, identity_value, identity_key, source_platform, source_type,
        source_account_id, source_account_name, external_content_id, canonical_url,
        title, original_title, content_kind, original_format, original_language,
        published_at, discovered_at, first_inflow_at, execution_log_markdown_path,
        process_status, processing_stage, last_error, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          randomUUID(),
          identity.kind,
          identity.value,
          identity.key,
          input.platform,
          input.sourceType,
          input.sourceAccountId,
          input.sourceAccountName,
          input.externalContentId ?? null,
          input.canonicalUrl
            ? canonicalizeContentUrl(input.canonicalUrl)
            : null,
          input.title,
          input.originalTitle ?? null,
          input.kind,
          input.format,
          input.language,
          input.publishedAt ?? null,
          input.discoveredAt ?? now,
          now,
          logPath,
          status,
          status,
          String(redact(reason)),
          now,
          now
        )
      await atomicWrite(
        path.join(this.dataRoot, logPath),
        markdownDocument(
          {
            content_id: this.get(identity.key)!.id,
            created_at: now,
          },
          '# 执行日志\n'
        )
      )
    } else {
      this.database
        .prepare(
          `UPDATE contents SET process_status=?, processing_stage=?,
        last_error=?, retry_count=retry_count+1, updated_at=? WHERE id=?`
        )
        .run(status, status, String(redact(reason)), now, existing.id)
    }
    const row = this.get(identity.key)!
    await this.appendLog(row.id, {
      action: 'enrich',
      stage: status,
      status: 'failed',
      error: reason,
      request: event?.request,
      response: event?.response,
    })
    return row
  }

  private properties(
    row: ContentRow,
    language: 'zh' | 'en'
  ): Record<string, unknown> {
    const scores = Object.fromEntries(
      scoreDimensions.map((dimension) => [
        dimension,
        row[`${dimension}_level`] == null
          ? null
          : {
              level: row[`${dimension}_level`],
              reason: row[`${dimension}_reason`],
            },
      ])
    )
    return {
      content_id: row.id,
      language: language === 'zh' ? 'zh-CN' : 'en',
      ...(language === 'zh'
        ? {
            content_mode:
              row.original_language === 'zh' ? 'original' : 'translation',
          }
        : {}),
      ...(language === 'zh'
        ? { generated_at: row.updated_at }
        : { captured_at: row.created_at }),
      ...(language === 'zh' && row.original_language === 'zh'
        ? { translation_provider: 'original', translation_model: 'original' }
        : {}),
      source_platform: row.source_platform,
      source_account_id: row.source_account_id,
      original_format: row.original_format,
      source_url: row.canonical_url,
      published_at: row.published_at,
      title: row.title,
      original_title: row.original_title,
      summary: row.summary,
      keywords_text: row.keywords_text,
      value_summary: row.value_summary,
      is_junk: Boolean(row.is_junk),
      junk_reason: row.junk_reason,
      total_score: row.total_score,
      recommendation: row.recommendation,
      scores,
    }
  }

  private async writeContent(
    row: ContentRow,
    body: string,
    language: 'zh' | 'en'
  ): Promise<void> {
    const relative =
      language === 'zh' ? row.chinese_markdown_path : row.english_markdown_path
    if (!relative) throw new Error(`No ${language} Markdown path`)
    await atomicWrite(
      path.join(this.dataRoot, relative),
      markdownDocument(this.properties(row, language), body)
    )
  }

  async refreshFrontmatter(id: string): Promise<void> {
    const row = this.getById(id)
    if (!row) throw new Error('Content not found')
    for (const [language, relative] of [
      ['zh', row.chinese_markdown_path],
      ['en', row.english_markdown_path],
    ] as const) {
      if (!relative) continue
      const text = await readFile(path.join(this.dataRoot, relative), 'utf8')
      const match = /^---\n([\s\S]*?)\n---\n\n/u.exec(text)
      if (!match) throw new Error(`Invalid content Markdown: ${relative}`)
      const previous = parseYaml(match[1]!) as Record<string, unknown>
      await atomicWrite(
        path.join(this.dataRoot, relative),
        markdownDocument(
          { ...previous, ...this.properties(row, language) },
          text.slice(match[0].length)
        )
      )
    }
  }

  async appendLog(id: string, event: LogEvent): Promise<void> {
    const row = this.getById(id)
    if (!row) throw new Error('Content not found')
    const target = path.join(this.dataRoot, row.execution_log_markdown_path)
    const previous = await readFile(target, 'utf8')
    const request =
      event.request === undefined ? '无' : boundedLogPayload(event.request)
    const response =
      event.response === undefined ? '无' : boundedLogPayload(event.response)
    const timestamp = new Date().toISOString()
    const index = [...previous.matchAll(/^## /gmu)].length
    const entry =
      `\n## ${timestamp} | ${event.action} | ${event.status}\n\n` +
      `- 阶段：\`${event.stage}\`\n- 触发方式：\`${event.trigger ?? 'scheduled'}\`\n` +
      `- 耗时：\`${event.durationMs ?? 0} ms\`\n- 重试次数：\`${event.retryCount ?? 0}\`\n` +
      (event.processor ? `- 处理器：\`${event.processor}\`\n` : '') +
      (event.prompt ? `- 提示词：\`${event.prompt}\`\n` : '') +
      (event.error ? `- 错误摘要：\`${String(redact(event.error))}\`\n` : '') +
      `\n### request\n\n\`\`\`json\n${request}\n\`\`\`\n\n### response\n\n\`\`\`json\n${response}\n\`\`\`\n`
    await atomicWrite(target, previous.trimEnd() + '\n' + entry)
    await appendFile(
      path.join(this.dataRoot, 'runtime-log-summaries.jsonl'),
      `${JSON.stringify({
        index,
        timestamp,
        action: event.action,
        status: event.status,
        stage: event.stage,
        trigger: event.trigger ?? 'scheduled',
        duration: `${event.durationMs ?? 0} ms`,
        retryCount: String(event.retryCount ?? 0),
        ...(event.processor ? { processor: event.processor } : {}),
        ...(event.prompt ? { prompt: event.prompt } : {}),
        ...(event.error
          ? { error: String(redact(event.error)).slice(0, 2_000) }
          : {}),
        contentId: row.id,
        contentTitle: row.title,
        sourceId: String(row.source_account_id),
        sourceName: String(row.source_account_name),
      } satisfies RuntimeLogSummaryRecord)}\n`,
      'utf8'
    )
  }

  fail(id: string, _stage: string, error: unknown): void {
    this.database
      .prepare(
        `UPDATE contents SET process_status='failed', processing_stage='failed',
      retry_count=retry_count+1, last_error=?, last_processed_at=?, updated_at=? WHERE id=?`
      )
      .run(
        String(redact(error instanceof Error ? error.message : error)),
        new Date().toISOString(),
        new Date().toISOString(),
        id
      )
  }

  private async fileFailure(
    id: string,
    stage: string,
    error: unknown
  ): Promise<void> {
    this.fail(id, stage, error)
    try {
      await this.appendLog(id, {
        action: 'write-content',
        stage,
        status: 'failed',
        request: '无',
        response: '无',
        error: error instanceof Error ? error.message : String(error),
      })
    } catch {
      /* The log may be the unwritable file; leave the failed row for manual retry. */
    }
  }

  async saveClassification(
    id: string,
    input: {
      keywords: string[]
      isJunk: boolean
      reason?: string
      summary?: string
    }
  ): Promise<ContentRow> {
    const row = this.getById(id)
    if (!row) throw new Error('Content not found')
    if (
      !input.keywords.length ||
      input.keywords.length > 5 ||
      input.keywords.some((word) => !word.trim())
    )
      throw new Error('Expected 1–5 keywords')
    const now = new Date().toISOString()
    const isJunk =
      row.junk_source === 'manual' ? Boolean(row.is_junk) : input.isJunk
    this.database
      .prepare(
        `UPDATE contents SET keywords_json=?, keywords_text=?, summary=COALESCE(?,summary),
      is_junk=?, junk_source=CASE WHEN junk_source='manual' THEN 'manual' ELSE 'ai' END,
      junk_reason=CASE WHEN junk_source='manual' THEN junk_reason ELSE ? END,
      junk_updated_at=?, value_summary=CASE WHEN ?=1 THEN NULL ELSE value_summary END,
      interest_fit_level=CASE WHEN ?=1 THEN NULL ELSE interest_fit_level END,
      interest_fit_reason=CASE WHEN ?=1 THEN NULL ELSE interest_fit_reason END,
      concrete_gain_level=CASE WHEN ?=1 THEN NULL ELSE concrete_gain_level END,
      concrete_gain_reason=CASE WHEN ?=1 THEN NULL ELSE concrete_gain_reason END,
      substance_level=CASE WHEN ?=1 THEN NULL ELSE substance_level END,
      substance_reason=CASE WHEN ?=1 THEN NULL ELSE substance_reason END,
      new_information_level=CASE WHEN ?=1 THEN NULL ELSE new_information_level END,
      new_information_reason=CASE WHEN ?=1 THEN NULL ELSE new_information_reason END,
      total_score=CASE WHEN ?=1 THEN NULL ELSE total_score END,
      recommendation=CASE WHEN ?=1 THEN 'none' ELSE recommendation END,
      process_status=?, processing_stage=?, updated_at=? WHERE id=?`
      )
      .run(
        JSON.stringify(input.keywords),
        input.keywords.join(' '),
        input.summary ?? null,
        isJunk ? 1 : 0,
        input.reason ?? null,
        now,
        ...Array(11).fill(isJunk ? 1 : 0),
        isJunk ? 'completed' : 'processing',
        isJunk ? 'completed' : 'scoring',
        now,
        id
      )
    try {
      await this.refreshFrontmatter(id)
    } catch (error) {
      await this.fileFailure(id, 'classifying', error)
      throw error
    }
    return this.getById(id)!
  }

  async saveScoring(
    id: string,
    valueSummary: string,
    scores: Record<ScoreDimension, Score>,
    rules: ScoringRules,
    metadata?: {
      provider: string
      model: string
      promptVersion: string
      profileVersion: string
      durationMs: number
    }
  ): Promise<ContentRow> {
    const row = this.getById(id)
    if (!row || row.is_junk)
      throw new Error('Cannot score missing or junk content')
    if (!valueSummary.trim()) throw new Error('Value summary is required')
    const result = scoreContent(scores, rules)
    const now = new Date().toISOString()
    this.database
      .prepare(
        `UPDATE contents SET value_summary=?,
      interest_fit_level=?, interest_fit_reason=?, concrete_gain_level=?, concrete_gain_reason=?,
      substance_level=?, substance_reason=?, new_information_level=?, new_information_reason=?,
      total_score=?, recommendation=?, scoring_rule_json=?, analyzed_at=?,
      analysis_provider=?, analysis_model=?, analysis_prompt_version=?, analysis_profile_version_id=?,
      analysis_rule_version='single-table-v1', analysis_duration_ms=?,
      process_status='completed', processing_stage='completed', last_processed_at=?, updated_at=? WHERE id=?`
      )
      .run(
        valueSummary,
        scores.interest_fit.level,
        scores.interest_fit.reason,
        scores.concrete_gain.level,
        scores.concrete_gain.reason,
        scores.substance.level,
        scores.substance.reason,
        scores.new_information.level,
        scores.new_information.reason,
        result.totalScore,
        result.recommendation,
        JSON.stringify(rules),
        now,
        metadata?.provider ?? null,
        metadata?.model ?? null,
        metadata?.promptVersion ?? null,
        metadata?.profileVersion ?? null,
        metadata?.durationMs ?? null,
        now,
        now,
        id
      )
    try {
      await this.refreshFrontmatter(id)
    } catch (error) {
      await this.fileFailure(id, 'scoring', error)
      throw error
    }
    return this.getById(id)!
  }

  async saveTranslation(
    id: string,
    chineseBody: string,
    chineseTitle: string | null,
    minimumTotalScore: number,
    metadata?: {
      provider: string
      model: string
      manual?: boolean
      chunkCount?: number
    }
  ): Promise<ContentRow> {
    const row = this.getById(id)
    if (
      !row ||
      row.original_language !== 'en' ||
      row.is_junk ||
      (!metadata?.manual &&
        (row.total_score == null || row.total_score < minimumTotalScore))
    )
      throw new Error('Content does not qualify for translation')
    if (!chineseBody.trim()) throw new Error('Translation cannot be empty')
    const relative = path.posix.join(
      path.posix.dirname(row.execution_log_markdown_path),
      '中文.md'
    )
    const now = new Date().toISOString()
    this.database
      .prepare(
        `UPDATE contents SET chinese_markdown_path=?, translation_status='running',
      translation_skip_reason=NULL, translation_error=NULL,
      translation_chunk_count=?, translation_completed_chunks=?,
      updated_at=? WHERE id=?`
      )
      .run(
        relative,
        metadata?.chunkCount ?? 1,
        metadata?.chunkCount ?? 1,
        now,
        id
      )
    try {
      await this.writeContent(this.getById(id)!, chineseBody, 'zh')
      if (metadata) {
        const target = path.join(this.dataRoot, relative)
        const written = await readFile(target, 'utf8')
        const match = /^---\n([\s\S]*?)\n---\n\n/u.exec(written)
        if (!match)
          throw new Error('Translated Markdown front matter is invalid')
        await atomicWrite(
          target,
          markdownDocument(
            {
              ...(parseYaml(match[1]!) as Record<string, unknown>),
              translation_provider: metadata.provider,
              translation_model: metadata.model,
            },
            written.slice(match[0].length)
          )
        )
      }
      this.database
        .prepare(
          `UPDATE contents SET chinese_title=?, title=COALESCE(?,title),
          summary=CASE WHEN content_kind='short_post' THEN ? ELSE summary END,
          updated_at=? WHERE id=?`
        )
        .run(chineseTitle, chineseTitle, chineseBody, now, id)
      await this.refreshFrontmatter(id)
      this.database
        .prepare(
          `UPDATE contents SET translated_to_chinese=1,
          translation_status='succeeded', updated_at=? WHERE id=?`
        )
        .run(now, id)
    } catch (error) {
      await this.fileFailure(id, 'translating', error)
      throw error
    }
    return this.getById(id)!
  }

  setTranslationSkipped(id: string, reason: string): ContentRow {
    if (!this.getById(id)) throw new Error('Content not found')
    this.database
      .prepare(
        `UPDATE contents SET translation_status='skipped', translation_skip_reason=?,
        translation_error=NULL, translation_chunk_count=0,
        translation_completed_chunks=0, updated_at=? WHERE id=?`
      )
      .run(reason, new Date().toISOString(), id)
    return this.getById(id)!
  }

  beginTranslation(id: string, chunkCount: number): ContentRow {
    if (!this.getById(id)) throw new Error('Content not found')
    this.database
      .prepare(
        `UPDATE contents SET translation_status='running', translation_skip_reason=NULL,
        translation_error=NULL, translation_chunk_count=?,
        translation_completed_chunks=0, updated_at=? WHERE id=?`
      )
      .run(chunkCount, new Date().toISOString(), id)
    return this.getById(id)!
  }

  updateTranslationProgress(
    id: string,
    completed: number,
    total: number
  ): void {
    this.database
      .prepare(
        `UPDATE contents SET translation_status='running', translation_chunk_count=?,
        translation_completed_chunks=?, updated_at=? WHERE id=?`
      )
      .run(total, completed, new Date().toISOString(), id)
  }

  failTranslation(id: string, error: unknown): ContentRow {
    if (!this.getById(id)) throw new Error('Content not found')
    this.database
      .prepare(
        `UPDATE contents SET translation_status='failed', translation_error=?,
        updated_at=? WHERE id=?`
      )
      .run(
        String(redact(error instanceof Error ? error.message : error)),
        new Date().toISOString(),
        id
      )
    return this.getById(id)!
  }

  async setManualJunk(
    id: string,
    isJunk: boolean,
    reason?: string,
    note?: string
  ): Promise<ContentRow> {
    if (!this.getById(id)) throw new Error('Content not found')
    const now = new Date().toISOString()
    this.database
      .prepare(
        `UPDATE contents SET is_junk=?, junk_source='manual', junk_reason=?, junk_note=?,
      junk_updated_at=?, value_summary=CASE WHEN ?=1 THEN NULL ELSE value_summary END,
      interest_fit_level=CASE WHEN ?=1 THEN NULL ELSE interest_fit_level END,
      interest_fit_reason=CASE WHEN ?=1 THEN NULL ELSE interest_fit_reason END,
      concrete_gain_level=CASE WHEN ?=1 THEN NULL ELSE concrete_gain_level END,
      concrete_gain_reason=CASE WHEN ?=1 THEN NULL ELSE concrete_gain_reason END,
      substance_level=CASE WHEN ?=1 THEN NULL ELSE substance_level END,
      substance_reason=CASE WHEN ?=1 THEN NULL ELSE substance_reason END,
      new_information_level=CASE WHEN ?=1 THEN NULL ELSE new_information_level END,
      new_information_reason=CASE WHEN ?=1 THEN NULL ELSE new_information_reason END,
      total_score=CASE WHEN ?=1 THEN NULL ELSE total_score END,
      recommendation=CASE WHEN ?=1 THEN 'none' ELSE recommendation END,
      updated_at=? WHERE id=?`
      )
      .run(
        isJunk ? 1 : 0,
        reason ?? null,
        note ?? null,
        now,
        ...Array(11).fill(isJunk ? 1 : 0),
        now,
        id
      )
    await this.refreshFrontmatter(id)
    await this.appendLog(id, {
      action: 'manual-junk',
      stage: 'completed',
      status: 'succeeded',
      trigger: 'manual-action',
      request: { isJunk, reason, note },
      response: { updated: true },
    })
    return this.getById(id)!
  }

  async setRuleJunk(id: string, reason: string): Promise<ContentRow> {
    const row = this.getById(id)
    if (!row) throw new Error('Content not found')
    if (row.junk_source === 'manual') return row
    if (row.is_junk && row.junk_source === 'rule' && row.junk_reason === reason)
      return row
    const now = new Date().toISOString()
    this.database
      .prepare(
        `UPDATE contents SET is_junk=1, junk_source='rule', junk_reason=?,
       junk_updated_at=?, recommendation='none', total_score=NULL,
       updated_at=? WHERE id=?`
      )
      .run(reason, now, now, id)
    await this.refreshFrontmatter(id)
    await this.appendLog(id, {
      action: 'rule-junk',
      stage: 'failed',
      status: 'succeeded',
      request: { reason },
      response: { updated: true },
    })
    return this.getById(id)!
  }

  setRead(id: string, read: boolean): void {
    const result = this.database
      .prepare('UPDATE contents SET read=?, updated_at=? WHERE id=?')
      .run(read ? 1 : 0, new Date().toISOString(), id)
    if (!result.changes) throw new Error('Content not found')
  }

  setUtilizationActions(
    id: string,
    actions: Array<'favorite' | 'card' | 'video' | 'article' | 'project'>
  ): void {
    const unique = [...new Set(actions)]
    const result = this.database
      .prepare(
        'UPDATE contents SET utilization_actions_json=?, updated_at=? WHERE id=?'
      )
      .run(JSON.stringify(unique), new Date().toISOString(), id)
    if (!result.changes) throw new Error('Content not found')
  }

  search(
    query: {
      keyword?: string
      isJunk?: boolean
      recommendation?: Recommendation
      processStatus?:
        'processing' | 'completed' | 'failed' | 'waiting-manual-transcription'
      sourcePlatform?: string
      sourceAccountId?: string
      contentKind?: OriginalContent['kind']
      read?: boolean
      minScore?: number
      maxScore?: number
      firstInflowFrom?: string
      firstInflowTo?: string
      limit?: number
    } = {}
  ): ContentRow[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (query.keyword?.trim()) {
      clauses.push(
        `(title LIKE ? ESCAPE '\\' OR chinese_title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR keywords_text LIKE ? ESCAPE '\\' OR value_summary LIKE ? ESCAPE '\\' OR source_account_name LIKE ? ESCAPE '\\')`
      )
      const word = `%${query.keyword.trim().replace(/[\\%_]/gu, '\\$&')}%`
      params.push(...Array(6).fill(word))
    }
    if (query.isJunk !== undefined) {
      clauses.push('is_junk=?')
      params.push(query.isJunk ? 1 : 0)
    }
    if (query.recommendation) {
      clauses.push('recommendation=?')
      params.push(query.recommendation)
    }
    if (query.processStatus) {
      clauses.push('process_status=?')
      params.push(query.processStatus)
    }
    if (query.sourcePlatform) {
      clauses.push('source_platform=?')
      params.push(query.sourcePlatform)
    }
    if (query.sourceAccountId) {
      clauses.push('source_account_id=?')
      params.push(query.sourceAccountId)
    }
    if (query.contentKind) {
      clauses.push('content_kind=?')
      params.push(query.contentKind)
    }
    if (query.read !== undefined) {
      clauses.push('read=?')
      params.push(query.read ? 1 : 0)
    }
    if (query.minScore !== undefined) {
      clauses.push('total_score>=?')
      params.push(query.minScore)
    }
    if (query.maxScore !== undefined) {
      clauses.push('total_score<=?')
      params.push(query.maxScore)
    }
    if (query.firstInflowFrom) {
      clauses.push('first_inflow_at>=?')
      params.push(query.firstInflowFrom)
    }
    if (query.firstInflowTo) {
      clauses.push('first_inflow_at<=?')
      params.push(query.firstInflowTo)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return this.database
      .prepare(
        `SELECT * FROM contents ${where} ORDER BY first_inflow_at DESC LIMIT ?`
      )
      .all(
        ...params,
        Math.min(Math.max(query.limit ?? 100, 1), 500)
      ) as unknown as ContentRow[]
  }

  modelFailureRows(): ContentRow[] {
    return this.database
      .prepare(
        `SELECT * FROM contents WHERE process_status='failed'
        AND (last_error LIKE '401:%' OR last_error LIKE '402:%'
          OR last_error LIKE '403:%' OR last_error LIKE '%API key%'
          OR last_error LIKE '%model%' OR last_error LIKE '%模型%'
          OR last_error LIKE '%余额不足%' OR last_error LIKE '%额度不足%'
          OR last_error LIKE '%Long content summary is missing%'
          OR last_error LIKE '%"path":["keywords"]%'
          OR last_error LIKE 'Codex error:%')
        AND last_error NOT LIKE 'All providers failed%'
        ORDER BY first_inflow_at ASC`
      )
      .all() as unknown as ContentRow[]
  }

  runtimeOverview(): {
    total: number
    failed: number
    waiting: number
    recent: Array<{
      id: string
      sourceId: string
      status: string
      stage: string
      updatedAt: string
    }>
  } {
    const counts = this.database
      .prepare(
        `SELECT COUNT(*) AS total,
      SUM(CASE WHEN process_status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN process_status='waiting-manual-transcription' THEN 1 ELSE 0 END) AS waiting
      FROM contents`
      )
      .get() as { total: number; failed: number | null; waiting: number | null }
    const recent = this.database
      .prepare(
        `SELECT id, source_account_id AS sourceId,
      process_status AS status, processing_stage AS stage, updated_at AS updatedAt
      FROM contents ORDER BY updated_at DESC LIMIT 30`
      )
      .all() as Array<{
      id: string
      sourceId: string
      status: string
      stage: string
      updatedAt: string
    }>
    return {
      total: counts.total,
      failed: counts.failed ?? 0,
      waiting: counts.waiting ?? 0,
      recent,
    }
  }

  runtimeLogDocuments(): RuntimeLogDocument[] {
    return this.database
      .prepare(
        `SELECT id AS contentId, title, source_account_id AS sourceId,
        source_account_name AS sourceName, execution_log_markdown_path AS logPath
        FROM contents ORDER BY updated_at DESC`
      )
      .all() as unknown as RuntimeLogDocument[]
  }
}
