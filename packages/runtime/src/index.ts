import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite'

import {
  sourceSchema,
  sourceTypeSchema,
  type Source,
  type SourceType,
} from '@qiushui-airadar/domain'
import { z } from 'zod'

export * from './single-table.js'

const timestampSchema = z.iso.datetime()
const taskTypeSchema = z.enum(['discover', 'enrich', 'analyze'])
const taskStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed'])
const jsonObjectSchema = z.record(z.string(), z.unknown())
const managedSourceSchema = sourceSchema.extend({
  sortOrder: z.number().int().nonnegative().optional(),
})
const utilizationActionSchema = z.enum([
  'favorite',
  'card',
  'video',
  'article',
  'project',
])
const junkReasonSchema = z.enum([
  'advertising',
  'engagement-bait',
  'no-substance',
  'clickbait',
  'low-quality-copy',
  'incorrect',
  'other',
])
const manualJunkSchema = z
  .object({
    isJunk: z.boolean(),
    reason: junkReasonSchema.optional(),
    note: z.string().max(500).optional(),
    updatedAt: timestampSchema,
  })
  .strict()
const contentUserStateSchema = z
  .object({
    contentId: z.string().min(1),
    read: z.boolean(),
    utilizationActions: z.array(utilizationActionSchema),
    manualJunk: manualJunkSchema.optional(),
    junkHistory: z.array(manualJunkSchema),
    updatedAt: timestampSchema,
  })
  .strict()
const junkSampleSchema = z
  .object({
    id: z.string().min(1),
    contentId: z.string().min(1),
    decision: manualJunkSchema,
    stateSnapshot: contentUserStateSchema.optional(),
    contentSnapshot: jsonObjectSchema,
    scoringSnapshot: jsonObjectSchema,
    modelSnapshot: jsonObjectSchema.optional(),
    createdAt: timestampSchema,
  })
  .strict()

const parameterScopeSchema = z.discriminatedUnion('level', [
  z.object({ level: z.literal('global') }).strict(),
  z
    .object({ level: z.literal('sourceType'), sourceType: sourceTypeSchema })
    .strict(),
  z
    .object({ level: z.literal('source'), sourceId: z.string().min(1) })
    .strict(),
])

const taskErrorSchema = z
  .object({
    attempt: z.number().int().positive(),
    at: timestampSchema,
    message: z.string(),
  })
  .strict()

const runtimeTaskSchema = z
  .object({
    id: z.string().min(1),
    type: taskTypeSchema,
    status: taskStatusSchema,
    sourceId: z.string().min(1).optional(),
    sourceType: sourceTypeSchema.optional(),
    idempotencyKey: z.string().min(1),
    payload: jsonObjectSchema,
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().min(1).max(3),
    availableAt: timestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    workerId: z.string().min(1).optional(),
    parameterVersionIds: z.array(z.string().min(1)),
    parameterSnapshot: jsonObjectSchema,
    parametersResolved: z.boolean(),
    errors: z.array(taskErrorSchema),
  })
  .strict()

const parameterVersionSchema = z
  .object({
    id: z.string().min(1),
    scope: parameterScopeSchema,
    values: jsonObjectSchema,
    description: z.string().min(1),
    previousVersionId: z.string().min(1).optional(),
    createdAt: timestampSchema,
  })
  .strict()

const scoringWeightsSchema = z
  .object({
    topicMatch: z.number().min(0).max(100),
    substance: z.number().min(0).max(100),
    credibility: z.number().min(0).max(100),
    novelty: z.number().min(0).max(100),
    actionability: z.number().min(0).max(100),
    workValue: z.number().min(0).max(100),
    clarity: z.number().min(0).max(100),
  })
  .strict()
  .refine(
    (weights) =>
      Math.abs(
        Object.values(weights).reduce((sum, value) => sum + value, 0) - 100
      ) < 0.001,
    'Scoring weights must total 100'
  )

function validCronField(
  value: string,
  minimum: number,
  maximum: number
): boolean {
  const numberInRange = (part: string) => {
    const parsed = Number(part)
    return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
  }
  return value.split(',').every((entry) => {
    const [range, step, ...extra] = entry.split('/')
    if (extra.length || !range) return false
    if (step !== undefined && (!/^\d+$/u.test(step) || Number(step) < 1))
      return false
    if (range === '*') return true
    const boundaries = range.split('-')
    if (boundaries.length === 1) return numberInRange(boundaries[0]!)
    return (
      boundaries.length === 2 &&
      numberInRange(boundaries[0]!) &&
      numberInRange(boundaries[1]!) &&
      Number(boundaries[0]) <= Number(boundaries[1])
    )
  })
}

function validFiveFieldCron(value: string): boolean {
  const fields = value.trim().split(/\s+/u)
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ] as const
  return (
    fields.length === 5 &&
    fields.every((field, index) =>
      validCronField(field, ranges[index]![0], ranges[index]![1])
    )
  )
}

const runtimeParametersSchema = z
  .object({
    collection: z
      .object({
        schedule: z
          .string()
          .min(1)
          .refine(validFiveFieldCron, 'Invalid cron schedule'),
        batchLimit: z.number().int().min(1).max(100),
        initialLookbackDays: z.number().int().min(0).max(3650),
        initialLimit: z.number().int().min(1).max(20),
        retryLimit: z.number().int().min(0).max(3),
        providerCooldownMinutes: z.number().int().min(0).max(1440),
      })
      .strict()
      .optional(),
    transcription: z
      .object({ auto: z.boolean(), maximumMinutes: z.number().min(1).max(120) })
      .strict()
      .optional(),
    storage: z
      .object({ rawResponseRetentionDays: z.number().int().min(1).max(3650) })
      .strict()
      .optional(),
    profile: z
      .object({
        background: z.string().max(5000),
        interests: z.array(z.string().min(1).max(200)).max(100),
        exclusions: z.array(z.string().min(1).max(200)).max(100),
      })
      .strict()
      .optional(),
    scoring: z
      .object({
        weights: scoringWeightsSchema,
        coreThreshold: z.number().min(0).max(100),
        exploreThreshold: z.number().min(0).max(100),
      })
      .strict()
      .refine(
        (scoring) => scoring.coreThreshold >= scoring.exploreThreshold,
        'Core threshold must not be lower than explore threshold'
      )
      .optional(),
  })
  .strict()

export function validateRuntimeParameters(
  values: Record<string, unknown>
): Record<string, unknown> {
  return runtimeParametersSchema.parse(values)
}

const threadPartSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    publishedAt: timestampSchema.optional(),
  })
  .strict()

const contentRecordSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    body: z.string(),
    canonicalUrl: z.url().optional(),
    sourceId: z.string().min(1).optional(),
    externalId: z.string().min(1).optional(),
    publishedAt: timestampSchema.optional(),
    discoveredAt: timestampSchema.optional(),
    enrichmentStatus: z
      .enum(['pending', 'waiting-manual-transcription', 'succeeded', 'failed'])
      .optional(),
    enrichmentError: z.string().optional(),
    threadParts: z.array(threadPartSchema).optional(),
    threadComplete: z.boolean().optional(),
  })
  .passthrough()

const discoveryRecordSchema = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    contentId: z.string().min(1),
    discoveredAt: timestampSchema,
  })
  .passthrough()

const progressSchema = z
  .object({
    sourceId: z.string().min(1),
    cursor: z.string().min(1).optional(),
    baselineExternalIds: z.array(z.string().min(1)).optional(),
    updatedAt: timestampSchema,
  })
  .strict()

const auditSchema = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    providerId: z.string().min(1),
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cursorBefore: z.string().optional(),
    cursorAfter: z.string().optional(),
    retries: z.number().int().nonnegative(),
    error: z.string().optional(),
  })
  .strict()

const providerAttemptSchema = z
  .object({
    id: z.string().min(1),
    providerId: z.string().min(1),
    sourceId: z.string().min(1),
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    durationMs: z.number().int().nonnegative(),
    status: z.enum(['succeeded', 'failed', 'skipped']),
    itemCount: z.number().int().nonnegative(),
    errorClass: z
      .enum([
        'temporary',
        'rate-limit',
        'credential',
        'balance',
        'invalid-request',
        'invalid-response',
      ])
      .optional(),
    error: z.string().optional(),
  })
  .strict()

const providerHealthSchema = z
  .object({
    providerId: z.string().min(1),
    state: z.enum(['healthy', 'cooldown', 'manual-recovery']),
    retryAt: timestampSchema.optional(),
    errorClass: z
      .enum([
        'temporary',
        'rate-limit',
        'credential',
        'balance',
        'invalid-request',
        'invalid-response',
      ])
      .optional(),
    updatedAt: timestampSchema,
  })
  .strict()

const interactionSnapshotSchema = z
  .object({
    id: z.string().min(1),
    contentId: z.string().min(1),
    sourceId: z.string().min(1),
    providerId: z.string().min(1),
    externalId: z.string().min(1).optional(),
    capturedAt: timestampSchema,
    views: z.number().int().nonnegative().nullable(),
    likes: z.number().int().nonnegative().nullable(),
    comments: z.number().int().nonnegative().nullable(),
    shares: z.number().int().nonnegative().nullable(),
    saves: z.number().int().nonnegative().nullable(),
  })
  .strict()

const relatedContentSchema = z
  .object({
    id: z.string().min(1),
    contentIds: z.tuple([z.string().min(1), z.string().min(1)]),
    reason: z.string().min(1),
    createdAt: timestampSchema,
  })
  .strict()

const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  })
  .strict()

const analysisRecordSchema = z
  .object({
    id: z.string().min(1),
    contentId: z.string().min(1),
    fingerprint: z.string().min(1),
    version: z.number().int().positive(),
    manual: z.boolean(),
    provider: z.string().min(1),
    model: z.string().min(1),
    promptVersion: z.string().min(1),
    profileVersionId: z.string().min(1),
    ruleVersion: z.string().min(1),
    createdAt: timestampSchema,
    durationMs: z.number().int().nonnegative(),
    usage: usageSchema,
    result: jsonObjectSchema,
  })
  .strict()

const analysisCallSchema = z
  .object({
    id: z.string().min(1),
    contentId: z.string().min(1),
    analysisId: z.string().min(1).optional(),
    provider: z.string().min(1),
    model: z.string().min(1),
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    durationMs: z.number().int().nonnegative(),
    status: z.enum(['succeeded', 'failed']),
    usage: usageSchema.optional(),
    error: z.string().optional(),
  })
  .strict()

export type RuntimeTask = z.infer<typeof runtimeTaskSchema>
export type ParameterScope = z.infer<typeof parameterScopeSchema>
export type RuntimeParameterVersion = z.infer<typeof parameterVersionSchema>
export type RuntimeAudit = z.infer<typeof auditSchema>
export type ProviderAttempt = z.infer<typeof providerAttemptSchema>
export type ProviderHealthRecord = z.infer<typeof providerHealthSchema>
export type InteractionSnapshot = z.infer<typeof interactionSnapshotSchema>
export type RelatedContent = z.infer<typeof relatedContentSchema>
export type ContentRecord = z.infer<typeof contentRecordSchema>
export type AnalysisRecord = z.infer<typeof analysisRecordSchema>
export type AnalysisCall = z.infer<typeof analysisCallSchema>
export type ManagedSource = z.infer<typeof managedSourceSchema>
export type UtilizationAction = z.infer<typeof utilizationActionSchema>
export type JunkReason = z.infer<typeof junkReasonSchema>
export type ContentUserState = z.infer<typeof contentUserStateSchema>

/** Rebuildable, detail-free row used by the content list. Markdown remains authoritative. */
export interface ContentListRecord {
  id: string
  title: string
  bodyPreview: string
  chinesePreview?: string
  canonicalUrl?: string
  sourceId?: string
  publishedAt?: string
  discoveredAt?: string
  kind?: unknown
  enrichmentStatus?: ContentRecord['enrichmentStatus']
  enrichmentError?: string
  originalStatus?: unknown
  images?: unknown
  video?: unknown
  quotedPost?: unknown
  repostedBy?: unknown
  source?: Pick<ManagedSource, 'id' | 'name' | 'type' | 'language'>
  analysis?: {
    result: Record<string, unknown>
    createdAt: string
    provider: string
    model: string
    profileVersionId: string
    ruleVersion: string
  }
  firstInflowAt?: string
  state?: Pick<ContentUserState, 'read' | 'utilizationActions' | 'manualJunk'>
  interaction?: InteractionSnapshot
  processStatus:
    'processing' | 'completed' | 'failed' | 'waiting-manual-transcription'
}

export interface EnqueueTaskInput {
  id: string
  type: RuntimeTask['type']
  sourceId?: string
  sourceType?: SourceType
  idempotencyKey: string
  payload?: Record<string, unknown>
  availableAt?: string
  maxAttempts?: number
}

export interface SaveParameterVersionInput {
  id: string
  scope: ParameterScope
  values: Record<string, unknown>
  description: string
  createdAt?: string
}

export interface DiscoveryBatchInput {
  sourceId: string
  nextCursor?: string
  baselineExternalIds?: string[]
  contents: Array<
    z.input<typeof contentRecordSchema> & {
      mergePlatformMetadata?: boolean
      mergeThreadParts?: boolean
    }
  >
  discoveries: Array<z.input<typeof discoveryRecordSchema>>
}

export interface AtomicWriteHooks {
  beforeSync?(): void | Promise<void>
  beforeRename?(): void | Promise<void>
}

export interface DiscoveryCommitHooks {
  beforeProgress?(): void | Promise<void>
}

const markdownStart = '<!-- qiushui-airadar-record:start -->\n```json\n'
const markdownEnd = '\n```\n<!-- qiushui-airadar-record:end -->\n'
const sensitiveKey =
  /(?:apikey|accesskey(?:id)?|token|secret|password|passphrase|authorization|auth|cookie|privatekey|credentials?|bearer|signingkey|decodekey)$/iu
const secretReferenceSchema = z
  .object({ secretRef: z.string().regex(/^[A-Z][A-Z0-9_]*$/u) })
  .strict()

function nowIso(): string {
  return new Date().toISOString()
}

function recordMarkdown(kind: string, record: unknown): string {
  return `# qiushui-airadar ${kind}\n\n${markdownStart}${JSON.stringify(record, null, 2)}${markdownEnd}`
}

function parseRecord<T>(source: string, schema: z.ZodType<T>): T {
  const start = source.indexOf(markdownStart)
  const end = source.indexOf(markdownEnd, start + markdownStart.length)
  if (start < 0 || end < 0)
    throw new Error('Invalid qiushui-airadar Markdown record')
  return schema.parse(
    JSON.parse(source.slice(start + markdownStart.length, end)) as unknown
  )
}

function containsSensitiveValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveValue)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(
    ([key, entry]) =>
      (sensitiveKey.test(key.replace(/[^a-z0-9]/giu, '')) &&
        !secretReferenceSchema.safeParse(entry).success) ||
      containsSensitiveValue(entry)
  )
}

function containsSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveKey)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(
    ([key, entry]) =>
      sensitiveKey.test(key.replace(/[^a-z0-9]/giu, '')) ||
      containsSensitiveKey(entry)
  )
}

function redactStructured(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStructured)
  if (typeof value === 'string') return redactText(value)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sensitiveKey.test(key.replace(/[^a-z0-9]/giu, ''))
        ? '[REDACTED]'
        : redactStructured(entry),
    ])
  )
}

function redactText(value: string): string {
  return value
    .replace(
      /((?:authorization|proxy-authorization)\s*:\s*)(?:bearer|basic)\s+[^\s,;]+/giu,
      '$1[REDACTED]'
    )
    .replace(/((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/giu, '$1[REDACTED]')
    .replace(/(bearer\s+)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(
      /((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)[^\s,;]+/giu,
      '$1[REDACTED]'
    )
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const previous = merged[key]
    merged[key] =
      previous &&
      value &&
      typeof previous === 'object' &&
      typeof value === 'object' &&
      !Array.isArray(previous) &&
      !Array.isArray(value)
        ? deepMerge(
            previous as Record<string, unknown>,
            value as Record<string, unknown>
          )
        : value
  }
  return merged
}

function retryAtFor(task: RuntimeTask): string {
  const retry = task.parameterSnapshot.retry
  const configuredDelay =
    retry && typeof retry === 'object' && 'delaySeconds' in retry
      ? Number((retry as { delaySeconds?: unknown }).delaySeconds)
      : 30
  const delaySeconds =
    Number.isFinite(configuredDelay) && configuredDelay >= 0
      ? configuredDelay
      : 30
  return new Date(Date.now() + delaySeconds * 1_000).toISOString()
}

function scopeKey(scope: ParameterScope): string {
  if (scope.level === 'global') return 'global'
  if (scope.level === 'sourceType') return `source-type:${scope.sourceType}`
  return `source:${scope.sourceId}`
}

function storageKey(id: string): string {
  return createHash('sha256').update(id).digest('hex')
}

function rowRecord<T>(row: unknown, schema: z.ZodType<T>): T | undefined {
  if (!row || typeof row !== 'object' || !('record_json' in row))
    return undefined
  const json = (row as { record_json: unknown }).record_json
  return typeof json === 'string'
    ? schema.parse(JSON.parse(json) as unknown)
    : undefined
}

async function markdownFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(directory, entry.name))
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

interface RootLock {
  database: DatabaseSync
}

async function acquireRootLock(indexDirectory: string): Promise<RootLock> {
  const database = new DatabaseSync(
    path.join(indexDirectory, 'runtime-lock.sqlite')
  )
  try {
    database.exec('PRAGMA busy_timeout = 100; BEGIN EXCLUSIVE;')
    return { database }
  } catch (error) {
    database.close()
    throw new Error('qiushui-airadar data root is already in use', {
      cause: error,
    })
  }
}

async function releaseRootLock(lock: RootLock): Promise<void> {
  try {
    lock.database.exec('ROLLBACK')
  } finally {
    lock.database.close()
  }
}

export async function atomicWriteFile(
  target: string,
  content: string | Uint8Array,
  hooks: AtomicWriteHooks = {}
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(
      content,
      typeof content === 'string' ? 'utf8' : undefined
    )
    await hooks.beforeSync?.()
    await handle.sync()
    await handle.close()
    handle = undefined
    await hooks.beforeRename?.()
    await rename(temporary, target)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true })
    throw error
  }
}

export class RuntimeRepository {
  readonly root: string
  readonly databasePath: string
  private readonly database: DatabaseSync
  private readonly rootLock: RootLock
  private mutationTail: Promise<void> = Promise.resolve()
  private closed = false
  private rebuildingIndex = false

  private constructor(
    root: string,
    database: DatabaseSync,
    rootLock: RootLock
  ) {
    this.root = root
    this.databasePath = path.join(root, '.index', 'runtime.sqlite')
    this.database = database
    this.rootLock = rootLock
  }

  static async open(root: string): Promise<RuntimeRepository> {
    const indexDirectory = path.join(root, '.index')
    await mkdir(indexDirectory, { recursive: true })
    const rootLock = await acquireRootLock(indexDirectory)
    const databasePath = path.join(indexDirectory, 'runtime.sqlite')
    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(databasePath)
      const repository = new RuntimeRepository(root, database, rootLock)
      await repository.initialize()
      return repository
    } catch (error) {
      const sqliteError = error as NodeJS.ErrnoException & { errcode?: number }
      const code = sqliteError.code ?? ''
      if (
        !['ERR_SQLITE_CORRUPT', 'ERR_SQLITE_NOTADB'].includes(code) &&
        ![11, 26].includes(sqliteError.errcode ?? -1)
      ) {
        try {
          database?.close()
        } finally {
          await releaseRootLock(rootLock)
        }
        throw error
      }
      try {
        database?.close()
      } catch {
        // SQLite may already have closed a corrupt handle.
      }
      try {
        await Promise.all(
          ['', '-wal', '-shm'].map((suffix) =>
            rm(`${databasePath}${suffix}`, { force: true })
          )
        )
        database = new DatabaseSync(databasePath)
        const repository = new RuntimeRepository(root, database, rootLock)
        await repository.initialize()
        return repository
      } catch (replacementError) {
        try {
          database?.close()
        } finally {
          await releaseRootLock(rootLock)
        }
        throw replacementError
      }
    }
  }

  private async initialize(): Promise<void> {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        source_id TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_locks (
        source_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS parameters (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS contents (
        id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS content_list (
        id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        sort_order INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS content_user_states (
        content_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS junk_samples (
        id TEXT PRIMARY KEY,
        content_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS discoveries (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        content_id TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS progress (
        source_id TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audits (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_attempts (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_health (
        provider_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS interaction_snapshots (
        id TEXT PRIMARY KEY,
        content_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS content_relations (
        id TEXT PRIMARY KEY,
        left_content_id TEXT NOT NULL,
        right_content_id TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id TEXT PRIMARY KEY,
        content_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS analyses_fingerprint
        ON analyses (content_id, fingerprint);
      CREATE UNIQUE INDEX IF NOT EXISTS analyses_version
        ON analyses (content_id, version);
      CREATE TABLE IF NOT EXISTS analysis_calls (
        id TEXT PRIMARY KEY,
        content_id TEXT NOT NULL,
        status TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
    `)
    const taskColumns = this.database
      .prepare('PRAGMA table_info(tasks)')
      .all() as Array<{ name: string }>
    if (!taskColumns.some((column) => column.name === 'content_id')) {
      this.database.exec('ALTER TABLE tasks ADD COLUMN content_id TEXT')
    }
    this.database.exec(
      'CREATE INDEX IF NOT EXISTS tasks_content_type ON tasks (content_id, type, created_at DESC)'
    )
    await this.rebuildIndex()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      this.database.close()
    } finally {
      await releaseRootLock(this.rootLock)
    }
  }

  journalMode(): string {
    const row = this.database.prepare('PRAGMA journal_mode').get() as
      { journal_mode?: unknown } | undefined
    return String(row?.journal_mode ?? '')
  }

  indexedTaskCount(): number {
    return this.count('tasks')
  }

  indexedContentCount(): number {
    return this.count('contents')
  }

  indexedDiscoveryCount(): number {
    return this.count('discoveries')
  }

  hasDiscovery(id: string): boolean {
    return this.hasRecord('discoveries', id)
  }

  getDiscovery(id: string): z.infer<typeof discoveryRecordSchema> | undefined {
    return rowRecord(
      this.database
        .prepare('SELECT record_json FROM discoveries WHERE id = ?')
        .get(id),
      discoveryRecordSchema
    )
  }

  listDiscoveries(
    sourceId?: string
  ): Array<z.infer<typeof discoveryRecordSchema>> {
    const rows = sourceId
      ? this.database
          .prepare(
            'SELECT record_json FROM discoveries WHERE source_id = ? ORDER BY id'
          )
          .all(sourceId)
      : this.database
          .prepare('SELECT record_json FROM discoveries ORDER BY id')
          .all()
    return rows
      .map((row) => rowRecord(row, discoveryRecordSchema))
      .filter((record): record is z.infer<typeof discoveryRecordSchema> =>
        Boolean(record)
      )
  }

  activeSourceLockCount(): number {
    return this.count('source_locks')
  }

  private count(table: string): number {
    const allowed = new Set([
      'tasks',
      'contents',
      'discoveries',
      'source_locks',
    ])
    if (!allowed.has(table)) throw new Error('Unsupported count table')
    const row = this.database
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get() as { count?: unknown } | undefined
    return Number(row?.count ?? 0)
  }

  async rebuildIndex(): Promise<void> {
    this.rebuildingIndex = true
    try {
      this.database.exec(`
      DELETE FROM source_locks;
      DELETE FROM tasks;
      DELETE FROM parameters;
      DELETE FROM contents;
      DELETE FROM content_list;
      DELETE FROM sources;
      DELETE FROM content_user_states;
      DELETE FROM junk_samples;
      DELETE FROM discoveries;
      DELETE FROM progress;
      DELETE FROM audits;
      DELETE FROM provider_attempts;
      DELETE FROM provider_health;
      DELETE FROM interaction_snapshots;
      DELETE FROM content_relations;
      DELETE FROM analyses;
      DELETE FROM analysis_calls;
    `)

      await this.rebuildTasks()
      await this.rebuildFolder(
        'parameters',
        parameterVersionSchema,
        (record) => {
          this.upsertParameter(record)
        }
      )
      await this.rebuildContents()
      await this.rebuildFolder('sources', managedSourceSchema, (record) => {
        this.upsertSource(record)
      })
      await this.rebuildFolder(
        'content-user-states',
        contentUserStateSchema,
        (record) => {
          this.upsertContentUserState(record)
        }
      )
      await this.rebuildFolder('junk-samples', junkSampleSchema, (record) => {
        this.upsertJunkSample(record)
        const snapshot = record.stateSnapshot
        const current = this.getContentUserState(record.contentId)
        if (snapshot && (!current || current.updatedAt <= snapshot.updatedAt)) {
          this.upsertContentUserState(snapshot)
        }
      })
      await this.rebuildFolder(
        'discoveries',
        discoveryRecordSchema,
        (record) => {
          this.upsertDiscovery(record)
        }
      )
      await this.rebuildFolder('progress', progressSchema, (record) => {
        this.upsertProgress(record)
      })
      await this.rebuildFolder('audits', auditSchema, (record) => {
        this.upsertAudit(record)
      })
      await this.rebuildFolder(
        'provider-attempts',
        providerAttemptSchema,
        (record) => {
          this.upsertProviderAttempt(record)
        }
      )
      await this.rebuildFolder(
        'provider-health',
        providerHealthSchema,
        (record) => {
          this.upsertProviderHealth(record)
        }
      )
      await this.rebuildFolder(
        'interaction-snapshots',
        interactionSnapshotSchema,
        (record) => {
          this.upsertInteractionSnapshot(record)
        }
      )
      await this.rebuildFolder(
        'content-relations',
        relatedContentSchema,
        (record) => {
          this.upsertRelatedContent(record)
        }
      )
      await this.rebuildFolder('analyses', analysisRecordSchema, (record) => {
        this.upsertAnalysis(record)
      })
      await this.rebuildFolder(
        'analysis-calls',
        analysisCallSchema,
        (record) => {
          this.upsertAnalysisCall(record)
        }
      )
      this.rebuildingIndex = false
      for (const content of this.listContents())
        this.refreshContentList(content.id)
    } finally {
      this.rebuildingIndex = false
    }
  }

  private async rebuildTasks(): Promise<void> {
    for (const file of await markdownFiles(this.folder('tasks'))) {
      let record = parseRecord(await readFile(file, 'utf8'), runtimeTaskSchema)
      if (record.status === 'running') {
        record = {
          ...record,
          status: 'pending',
          workerId: undefined,
          updatedAt: nowIso(),
        }
        await atomicWriteFile(file, recordMarkdown('task', record))
      }
      this.upsertTask(record)
    }
  }

  private async rebuildFolder<T>(
    name: string,
    schema: z.ZodType<T>,
    insert: (record: T) => void
  ): Promise<void> {
    for (const file of await markdownFiles(this.folder(name))) {
      insert(parseRecord(await readFile(file, 'utf8'), schema))
    }
  }

  private async rebuildContents(): Promise<void> {
    const directory = this.folder('contents')
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const file = path.join(directory, entry.name, 'content.md')
      try {
        this.upsertContent(
          parseRecord(await readFile(file, 'utf8'), contentRecordSchema)
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  async enqueueTask(input: EnqueueTaskInput): Promise<RuntimeTask> {
    return this.serializeMutation(() => this.enqueueTaskLocked(input))
  }

  private async serializeMutation<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await work()
    } finally {
      release()
    }
  }

  private async enqueueTaskLocked(
    input: EnqueueTaskInput
  ): Promise<RuntimeTask> {
    if (containsSensitiveValue(input.payload ?? {})) {
      throw new Error('Task payload cannot contain secret-like fields')
    }
    if (input.type === 'discover' && !input.sourceId) {
      throw new Error('Discover tasks require a source id')
    }
    const duplicate = rowRecord(
      this.database
        .prepare('SELECT record_json FROM tasks WHERE idempotency_key = ?')
        .get(input.idempotencyKey),
      runtimeTaskSchema
    )
    if (duplicate) return duplicate
    if (await this.getTask(input.id)) {
      throw new Error(`Task id already exists: ${input.id}`)
    }

    const time = nowIso()
    const task = runtimeTaskSchema.parse({
      ...input,
      payload: input.payload ?? {},
      status: 'pending',
      attempt: 0,
      maxAttempts: input.maxAttempts ?? 3,
      availableAt: input.availableAt ?? time,
      createdAt: time,
      updatedAt: time,
      parameterVersionIds: [],
      parameterSnapshot: {},
      parametersResolved: false,
      errors: [],
    })
    await this.writeRecord('tasks', task.id, 'task', task)
    this.upsertTask(task)
    return task
  }

  async getTask(id: string): Promise<RuntimeTask | undefined> {
    return rowRecord(
      this.database
        .prepare('SELECT record_json FROM tasks WHERE id = ?')
        .get(id),
      runtimeTaskSchema
    )
  }

  listTasks(): RuntimeTask[] {
    return this.database
      .prepare(
        'SELECT record_json FROM tasks ORDER BY created_at DESC, id DESC'
      )
      .all()
      .map((row) => rowRecord(row, runtimeTaskSchema))
      .filter((task): task is RuntimeTask => Boolean(task))
  }

  async claimNextTask(
    workerId: string,
    at = nowIso()
  ): Promise<RuntimeTask | undefined> {
    return this.serializeMutation(() => this.claimNextTaskLocked(workerId, at))
  }

  private async claimNextTaskLocked(
    workerId: string,
    at: string
  ): Promise<RuntimeTask | undefined> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const rows = this.database
        .prepare(
          `SELECT record_json FROM tasks
           WHERE status = 'pending' AND available_at <= ?
           ORDER BY created_at, id`
        )
        .all(at)
      for (const row of rows) {
        const pending = rowRecord(row, runtimeTaskSchema)
        if (!pending) continue
        if (pending.sourceId && this.isSourceLocked(pending.sourceId)) continue

        const parameters = !pending.parametersResolved
          ? this.resolveParameters(pending.sourceType, pending.sourceId)
          : {
              ids: pending.parameterVersionIds,
              values: pending.parameterSnapshot,
            }
        const collection = parameters.values.collection
        const retryLimit =
          collection &&
          typeof collection === 'object' &&
          'retryLimit' in collection &&
          typeof collection.retryLimit === 'number'
            ? collection.retryLimit
            : pending.maxAttempts
        const running = runtimeTaskSchema.parse({
          ...pending,
          status: 'running',
          attempt: pending.attempt + 1,
          workerId,
          maxAttempts: pending.parametersResolved
            ? pending.maxAttempts
            : pending.payload.providerRouterOwnsBudget === true
              ? 1
              : Math.max(1, Math.min(3, retryLimit)),
          parameterVersionIds: parameters.ids,
          parameterSnapshot: parameters.values,
          parametersResolved: true,
          updatedAt: nowIso(),
        })
        await this.writeRecord('tasks', running.id, 'task', running)
        this.upsertTask(running)
        if (running.sourceId) {
          this.database
            .prepare(
              'INSERT INTO source_locks (source_id, task_id) VALUES (?, ?)'
            )
            .run(running.sourceId, running.id)
        }
        this.database.exec('COMMIT')
        return running
      }
      this.database.exec('COMMIT')
      return undefined
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  async completeTask(id: string): Promise<RuntimeTask> {
    return this.serializeMutation(() => this.completeTaskLocked(id))
  }

  private async completeTaskLocked(id: string): Promise<RuntimeTask> {
    const task = await this.requireRunningTask(id)
    const completed = runtimeTaskSchema.parse({
      ...task,
      status: 'succeeded',
      workerId: undefined,
      updatedAt: nowIso(),
    })
    await this.writeRecord('tasks', id, 'task', completed)
    this.upsertTask(completed)
    this.releaseSourceLock(task)
    return completed
  }

  async failTask(
    id: string,
    message: string,
    options: { retryAt?: string } = {}
  ): Promise<RuntimeTask> {
    return this.serializeMutation(() =>
      this.failTaskLocked(id, message, options)
    )
  }

  private async failTaskLocked(
    id: string,
    message: string,
    options: { retryAt?: string }
  ): Promise<RuntimeTask> {
    const task = await this.requireRunningTask(id)
    const exhausted = task.attempt >= task.maxAttempts
    const failed = runtimeTaskSchema.parse({
      ...task,
      status: exhausted ? 'failed' : 'pending',
      workerId: undefined,
      availableAt: exhausted
        ? task.availableAt
        : (options.retryAt ?? retryAtFor(task)),
      updatedAt: nowIso(),
      errors: [
        ...task.errors,
        { attempt: task.attempt, at: nowIso(), message: redactText(message) },
      ],
    })
    await this.writeRecord('tasks', id, 'task', failed)
    this.upsertTask(failed)
    this.releaseSourceLock(task)
    return failed
  }

  private async requireRunningTask(id: string): Promise<RuntimeTask> {
    const task = await this.getTask(id)
    if (!task || task.status !== 'running') {
      throw new Error(`Task ${id} is not running`)
    }
    return task
  }

  private releaseSourceLock(task: RuntimeTask): void {
    if (task.sourceId) {
      this.database
        .prepare('DELETE FROM source_locks WHERE source_id = ? AND task_id = ?')
        .run(task.sourceId, task.id)
    }
  }

  private isSourceLocked(sourceId: string): boolean {
    return Boolean(
      this.database
        .prepare('SELECT 1 FROM source_locks WHERE source_id = ?')
        .get(sourceId)
    )
  }

  async saveParameterVersion(
    input: SaveParameterVersionInput
  ): Promise<RuntimeParameterVersion> {
    return this.serializeMutation(() => this.saveParameterVersionLocked(input))
  }

  listParameterVersions(scope?: ParameterScope): RuntimeParameterVersion[] {
    const rows = scope
      ? this.database
          .prepare(
            'SELECT record_json FROM parameters WHERE scope_key = ? ORDER BY created_at DESC, id DESC'
          )
          .all(scopeKey(scope))
      : this.database
          .prepare(
            'SELECT record_json FROM parameters ORDER BY created_at DESC, id DESC'
          )
          .all()
    return rows
      .map((row) => rowRecord(row, parameterVersionSchema))
      .filter((version): version is RuntimeParameterVersion => Boolean(version))
  }

  private async saveParameterVersionLocked(
    input: SaveParameterVersionInput
  ): Promise<RuntimeParameterVersion> {
    if (containsSensitiveValue(input.values)) {
      throw new Error('Parameter values cannot contain secret-like fields')
    }
    if (
      this.database
        .prepare('SELECT 1 FROM parameters WHERE id = ?')
        .get(input.id)
    ) {
      throw new Error(`Parameter version ${input.id} is immutable`)
    }
    const previous = rowRecord(
      this.database
        .prepare(
          `SELECT record_json FROM parameters
           WHERE scope_key = ? ORDER BY created_at DESC, id DESC LIMIT 1`
        )
        .get(scopeKey(input.scope)),
      parameterVersionSchema
    )
    const version = parameterVersionSchema.parse({
      ...input,
      previousVersionId: previous?.id,
      createdAt: input.createdAt ?? nowIso(),
    })
    await this.writeRecord(
      'parameters',
      version.id,
      'parameter version',
      version
    )
    this.upsertParameter(version)
    return version
  }

  resolveParameters(
    sourceType?: SourceType,
    sourceId?: string
  ): { ids: string[]; values: Record<string, unknown> } {
    const keys = [
      'global',
      ...(sourceType ? [`source-type:${sourceType}`] : []),
      ...(sourceId ? [`source:${sourceId}`] : []),
    ]
    const versions = keys
      .map((key) =>
        rowRecord(
          this.database
            .prepare(
              `SELECT record_json FROM parameters
               WHERE scope_key = ? ORDER BY created_at DESC, id DESC LIMIT 1`
            )
            .get(key),
          parameterVersionSchema
        )
      )
      .filter((version): version is RuntimeParameterVersion => Boolean(version))
    return {
      ids: versions.map((version) => version.id),
      values: versions.reduce(
        (values, version) => deepMerge(values, version.values),
        {} as Record<string, unknown>
      ),
    }
  }

  async commitDiscoveryBatch(
    input: DiscoveryBatchInput,
    hooks: DiscoveryCommitHooks = {}
  ): Promise<void> {
    await this.serializeMutation(() =>
      this.commitDiscoveryBatchLocked(input, hooks)
    )
  }

  private async commitDiscoveryBatchLocked(
    input: DiscoveryBatchInput,
    hooks: DiscoveryCommitHooks
  ): Promise<void> {
    const contents = input.contents.map((content) => {
      const {
        mergePlatformMetadata = false,
        mergeThreadParts = false,
        ...record
      } = content
      return {
        record: contentRecordSchema.parse(record),
        mergePlatformMetadata,
        mergeThreadParts,
      }
    })
    const discoveries = input.discoveries.map((discovery) =>
      discoveryRecordSchema.parse(discovery)
    )
    if (
      contents.some(({ record }) => containsSensitiveKey(record)) ||
      discoveries.some(containsSensitiveKey)
    ) {
      throw new Error('Content and discovery records cannot contain secrets')
    }
    const batchContentIds = new Set(contents.map(({ record }) => record.id))
    for (const discovery of discoveries) {
      if (discovery.sourceId !== input.sourceId) {
        throw new Error('Discovery source must match the committed source')
      }
      if (
        !batchContentIds.has(discovery.contentId) &&
        !this.hasRecord('contents', discovery.contentId)
      ) {
        throw new Error(
          `Discovery content does not exist: ${discovery.contentId}`
        )
      }
    }
    for (const {
      record: content,
      mergePlatformMetadata,
      mergeThreadParts,
    } of contents) {
      const existing = this.getContent(content.id)
      const hasThreadPartIncrement =
        mergeThreadParts && Boolean(content.threadParts?.length)
      const existingBodyFrozen = Boolean(
        existing?.body.trim() && existing.enrichmentStatus === 'succeeded'
      )
      const canMergeThreadParts = hasThreadPartIncrement && !existingBodyFrozen
      if (existing && !mergePlatformMetadata && !canMergeThreadParts) continue
      const threadParts = canMergeThreadParts
        ? [
            ...new Map(
              [
                ...(existing?.threadParts ?? []),
                ...(content.threadParts ?? []),
              ].map((part) => [part.id, part])
            ).values(),
          ].sort((left, right) =>
            (left.publishedAt ?? '').localeCompare(right.publishedAt ?? '')
          )
        : existing?.threadParts
      const stored = existing
        ? contentRecordSchema.parse({
            ...existing,
            title:
              mergePlatformMetadata ||
              (canMergeThreadParts && content.threadComplete)
                ? content.title
                : existing.title,
            canonicalUrl: content.canonicalUrl ?? existing.canonicalUrl,
            externalId: content.externalId ?? existing.externalId,
            publishedAt: content.publishedAt ?? existing.publishedAt,
            kind: content.kind ?? existing.kind,
            body:
              canMergeThreadParts && content.threadComplete
                ? threadParts?.map((part) => part.text).join('\n\n')
                : existing.body,
            enrichmentStatus:
              canMergeThreadParts && content.threadComplete
                ? 'succeeded'
                : existing.enrichmentStatus,
            threadParts,
            threadComplete:
              existing.threadComplete || content.threadComplete || undefined,
            evidence: {
              ...(typeof existing.evidence === 'object'
                ? existing.evidence
                : {}),
              ...(typeof content.evidence === 'object' ? content.evidence : {}),
            },
            video: {
              ...(typeof existing.video === 'object' ? existing.video : {}),
              ...(typeof content.video === 'object' ? content.video : {}),
            },
            images:
              Array.isArray(content.images) && content.images.length
                ? content.images
                : existing.images,
            quotedPost: content.quotedPost ?? existing.quotedPost,
            repostedBy: content.repostedBy ?? existing.repostedBy,
            sourceText: content.sourceText ?? existing.sourceText,
          })
        : content
      await atomicWriteFile(
        this.contentMarkdownPath(stored.id),
        recordMarkdown('content', stored)
      )
      this.upsertContent(stored)
    }
    for (const discovery of discoveries) {
      if (this.hasRecord('discoveries', discovery.id)) continue
      await this.writeRecord(
        'discoveries',
        discovery.id,
        'discovery',
        discovery
      )
      this.upsertDiscovery(discovery)
    }
    if (input.nextCursor || input.baselineExternalIds) {
      await hooks.beforeProgress?.()
      await this.writeProgress(
        input.sourceId,
        input.nextCursor,
        input.baselineExternalIds
      )
    }
  }

  async advanceProgress(
    sourceId: string,
    cursor: string | undefined,
    options: { baselineExternalIds?: string[]; clearCursor?: boolean } = {}
  ): Promise<void> {
    await this.serializeMutation(() =>
      this.writeProgress(
        sourceId,
        cursor,
        options.baselineExternalIds,
        options.clearCursor
      )
    )
  }

  private async writeProgress(
    sourceId: string,
    cursor: string | undefined,
    baselineExternalIds?: string[],
    clearCursor = false
  ): Promise<void> {
    const previous = this.getProgress(sourceId)
    const progress = progressSchema.parse({
      sourceId,
      cursor: clearCursor ? undefined : (cursor ?? previous?.cursor),
      baselineExternalIds: baselineExternalIds ?? previous?.baselineExternalIds,
      updatedAt: nowIso(),
    })
    await this.writeRecord('progress', sourceId, 'source progress', progress)
    this.upsertProgress(progress)
  }

  getContent(id: string): z.infer<typeof contentRecordSchema> | undefined {
    return rowRecord(
      this.database
        .prepare('SELECT record_json FROM contents WHERE id = ?')
        .get(id),
      contentRecordSchema
    )
  }

  listContents(): ContentRecord[] {
    return this.database
      .prepare('SELECT record_json FROM contents ORDER BY id')
      .all()
      .map((row) => rowRecord(row, contentRecordSchema))
      .filter((record): record is ContentRecord => Boolean(record))
  }

  listContentList(): ContentListRecord[] {
    return this.database
      .prepare('SELECT record_json FROM content_list ORDER BY id')
      .all()
      .map(
        (row) =>
          JSON.parse(
            (row as { record_json: string }).record_json
          ) as ContentListRecord
      )
  }

  getContentList(id: string): ContentListRecord | undefined {
    const row = this.database
      .prepare('SELECT record_json FROM content_list WHERE id = ?')
      .get(id) as { record_json: string } | undefined
    return row ? (JSON.parse(row.record_json) as ContentListRecord) : undefined
  }

  async readContentMarkdown(id: string): Promise<ContentRecord | undefined> {
    if (!this.getContentList(id)) return undefined
    return parseRecord(
      await readFile(this.contentMarkdownPath(id), 'utf8'),
      contentRecordSchema
    )
  }

  private refreshContentList(id: string): void {
    if (this.rebuildingIndex) return
    const content = this.getContent(id)
    if (!content) {
      this.database.prepare('DELETE FROM content_list WHERE id = ?').run(id)
      return
    }
    const analyses = this.listAnalyses(id)
    const latest = analyses[0]
    const result = (latest?.result ?? {}) as Record<string, unknown>
    const state = this.getContentUserState(id)
    const sourceAlias: Record<string, string> = {
      'accept-x-openai': 'x_openai',
      'accept-x-ycombinator': 'x_ycombinator',
      'accept-youtube-openai': 'yt_openai',
      'accept-youtube-ycombinator': 'yt_ycombinator',
    }
    const source = content.sourceId
      ? this.getSource(sourceAlias[content.sourceId] ?? content.sourceId)
      : undefined
    const latestInteraction = this.listInteractionSnapshots(id).at(-1)
    const taskStatus = (type: string) =>
      (
        this.database
          .prepare(
            'SELECT status FROM tasks WHERE content_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1'
          )
          .get(id, type) as { status?: string } | undefined
      )?.status
    const processStatus: ContentListRecord['processStatus'] =
      content.enrichmentStatus === 'failed'
        ? 'failed'
        : content.enrichmentStatus === 'waiting-manual-transcription'
          ? 'waiting-manual-transcription'
          : content.enrichmentStatus !== 'succeeded'
            ? taskStatus('enrich') === 'failed'
              ? 'failed'
              : 'processing'
            : analyses.length > 0
              ? 'completed'
              : taskStatus('analyze') === 'failed'
                ? 'failed'
                : 'processing'
    const firstInflowAt = analyses
      .filter((analysis) =>
        ['core', 'explore'].includes(
          String((analysis.result as Record<string, unknown>).recommendation)
        )
      )
      .map((analysis) => analysis.createdAt)
      .sort()[0]
    const row: ContentListRecord = {
      id,
      title: content.title,
      bodyPreview: content.body.trim().slice(0, 240),
      chinesePreview:
        typeof result.chineseTranslation === 'string'
          ? result.chineseTranslation.trim().slice(0, 240)
          : undefined,
      canonicalUrl: content.canonicalUrl,
      sourceId: content.sourceId,
      publishedAt: content.publishedAt,
      discoveredAt: content.discoveredAt,
      kind: content.kind,
      enrichmentStatus: content.enrichmentStatus,
      enrichmentError: content.enrichmentError,
      originalStatus: content.originalStatus,
      images: Array.isArray(content.images)
        ? content.images.slice(0, 1)
        : undefined,
      video: content.video,
      quotedPost: content.quotedPost,
      repostedBy: content.repostedBy,
      source: source
        ? {
            id: source.id,
            name: source.name,
            type: source.type,
            language: source.language,
          }
        : undefined,
      analysis: latest
        ? {
            result: {
              summary:
                typeof result.summary === 'string'
                  ? result.summary.slice(0, 500)
                  : undefined,
              topics: result.topics,
              scores: result.scores,
              totalScore: result.totalScore,
              recommendation: result.recommendation,
              spam: result.spam,
              chineseTitle: result.chineseTitle,
            },
            createdAt: latest.createdAt,
            provider: latest.provider,
            model: latest.model,
            profileVersionId: latest.profileVersionId,
            ruleVersion: latest.ruleVersion,
          }
        : undefined,
      firstInflowAt,
      state: state
        ? {
            read: state.read,
            utilizationActions: state.utilizationActions,
            manualJunk: state.manualJunk,
          }
        : undefined,
      interaction: latestInteraction,
      processStatus,
    }
    this.database
      .prepare(
        'INSERT INTO content_list (id, record_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json'
      )
      .run(id, JSON.stringify(row))
  }

  async importSources(
    sources: Array<Source & { sortOrder?: number }>
  ): Promise<void> {
    await this.serializeMutation(async () => {
      for (const source of sources) {
        const parsed = managedSourceSchema.parse(source)
        const existing = this.getSource(parsed.id)
        if (existing) {
          const row = this.database
            .prepare('SELECT record_json FROM sources WHERE id = ?')
            .get(parsed.id) as { record_json?: string } | undefined
          const stored = row?.record_json
            ? (JSON.parse(row.record_json) as Record<string, unknown>)
            : {}
          if (stored.language === undefined) {
            const upgraded = managedSourceSchema.parse({
              ...existing,
              language: parsed.language,
            })
            await this.writeRecord('sources', upgraded.id, 'source', upgraded)
            this.upsertSource(upgraded)
          }
          continue
        }
        await this.writeRecord('sources', parsed.id, 'source', parsed)
        this.upsertSource(parsed)
      }
    })
  }

  async retireSourceConfigs(ids: readonly string[]): Promise<void> {
    await this.serializeMutation(async () => {
      const retiredDirectory = this.folder('retired-sources')
      for (const id of ids) {
        if (!this.getSource(id)) continue
        await mkdir(retiredDirectory, { recursive: true })
        await rename(
          path.join(this.folder('sources'), `${storageKey(id)}.md`),
          path.join(retiredDirectory, `${storageKey(id)}-${randomUUID()}.md`)
        )
        this.database.prepare('DELETE FROM sources WHERE id = ?').run(id)
      }
    })
  }

  getSource(id: string): ManagedSource | undefined {
    return rowRecord(
      this.database
        .prepare('SELECT record_json FROM sources WHERE id = ?')
        .get(id),
      managedSourceSchema
    )
  }

  listSources(): ManagedSource[] {
    return this.database
      .prepare(
        'SELECT record_json FROM sources ORDER BY sort_order ASC, id ASC'
      )
      .all()
      .map((row) => rowRecord(row, managedSourceSchema))
      .filter((source): source is ManagedSource => Boolean(source))
  }

  async updateSourceStatus(
    id: string,
    status: ManagedSource['status']
  ): Promise<ManagedSource> {
    return this.serializeMutation(async () => {
      const source = this.getSource(id)
      if (!source) throw new Error(`Source does not exist: ${id}`)
      const updated = managedSourceSchema.parse({ ...source, status })
      await this.writeRecord('sources', id, 'source', updated)
      this.upsertSource(updated)
      return updated
    })
  }

  getContentUserState(contentId: string): ContentUserState | undefined {
    if (!this.getContent(contentId)) return undefined
    return (
      rowRecord(
        this.database
          .prepare(
            'SELECT record_json FROM content_user_states WHERE content_id = ?'
          )
          .get(contentId),
        contentUserStateSchema
      ) ??
      contentUserStateSchema.parse({
        contentId,
        read: false,
        utilizationActions: [],
        junkHistory: [],
        updatedAt: nowIso(),
      })
    )
  }

  listContentUserStates(): ContentUserState[] {
    return this.database
      .prepare(
        'SELECT record_json FROM content_user_states ORDER BY content_id'
      )
      .all()
      .map((row) => rowRecord(row, contentUserStateSchema))
      .filter((state): state is ContentUserState => Boolean(state))
  }

  async setContentRead(
    contentId: string,
    read: boolean
  ): Promise<ContentUserState> {
    return this.updateContentUserState(contentId, (state) => ({
      ...state,
      read,
      updatedAt: nowIso(),
    }))
  }

  async setUtilizationActions(
    contentId: string,
    actions: UtilizationAction[]
  ): Promise<ContentUserState> {
    const unique = [...new Set(actions)]
    return this.updateContentUserState(contentId, (state) => {
      if (state.manualJunk?.isJunk && unique.length) {
        throw new Error('Junk content cannot have utilization actions')
      }
      return { ...state, utilizationActions: unique, updatedAt: nowIso() }
    })
  }

  async setManualJunk(
    contentId: string,
    input: { isJunk: boolean; reason?: JunkReason; note?: string }
  ): Promise<ContentUserState> {
    if (input.isJunk && !input.reason) {
      throw new Error('A junk reason is required')
    }
    return this.serializeMutation(async () => {
      const current = this.getContentUserState(contentId)
      if (!current) throw new Error(`Content does not exist: ${contentId}`)
      const decision = manualJunkSchema.parse({ ...input, updatedAt: nowIso() })
      const state = contentUserStateSchema.parse({
        ...current,
        utilizationActions: decision.isJunk ? [] : current.utilizationActions,
        manualJunk: decision,
        junkHistory: [...current.junkHistory, decision],
        updatedAt: decision.updatedAt,
      })
      const content = this.getContent(contentId)
      if (!content) throw new Error(`Content does not exist: ${contentId}`)
      const analysis = this.listAnalyses(contentId)[0]
      const sample = junkSampleSchema.parse({
        id: randomUUID(),
        contentId,
        decision: state.manualJunk,
        stateSnapshot: state,
        contentSnapshot: { ...content },
        scoringSnapshot: analysis
          ? {
              result: analysis.result,
              rule: {
                version: analysis.ruleVersion,
                promptVersion: analysis.promptVersion,
                configuredRule: (analysis.result as Record<string, unknown>)
                  .scoringRule ?? {
                  weights: {
                    topicMatch: 20,
                    substance: 15,
                    credibility: 15,
                    novelty: 10,
                    actionability: 15,
                    workValue: 15,
                    clarity: 10,
                  },
                  coreThreshold: 80,
                  exploreThreshold: 60,
                },
                scale: [0, 25, 50, 75, 100],
                gates: {
                  core: { topicMatch: 5, substance: 3, credibility: 3 },
                  explore: {
                    topicMatch: 4,
                    substance: 3,
                    credibility: 3,
                  },
                },
                exclusions: ['profile-exclusion', 'effective-junk'],
              },
            }
          : {},
        modelSnapshot: analysis
          ? {
              provider: analysis.provider,
              model: analysis.model,
              durationMs: analysis.durationMs,
              usage: analysis.usage,
            }
          : undefined,
        createdAt: state.updatedAt,
      })
      // The immutable sample is the single durable commit record for the feedback.
      // Its state snapshot rebuilds the query index after an interrupted write.
      await this.writeRecord('junk-samples', sample.id, 'junk sample', sample)
      this.database.exec('BEGIN IMMEDIATE')
      try {
        this.upsertJunkSample(sample)
        this.upsertContentUserState(state)
        this.database.exec('COMMIT')
      } catch (error) {
        this.database.exec('ROLLBACK')
        throw error
      }
      return state
    })
  }

  listJunkSamples(contentId?: string): Array<z.infer<typeof junkSampleSchema>> {
    const rows = contentId
      ? this.database
          .prepare(
            'SELECT record_json FROM junk_samples WHERE content_id = ? ORDER BY created_at, id'
          )
          .all(contentId)
      : this.database
          .prepare(
            'SELECT record_json FROM junk_samples ORDER BY created_at, id'
          )
          .all()
    return rows
      .map((row) => rowRecord(row, junkSampleSchema))
      .filter((sample): sample is z.infer<typeof junkSampleSchema> =>
        Boolean(sample)
      )
  }

  private async updateContentUserState(
    contentId: string,
    update: (state: ContentUserState) => ContentUserState
  ): Promise<ContentUserState> {
    return this.serializeMutation(async () => {
      const current = this.getContentUserState(contentId)
      if (!current) throw new Error(`Content does not exist: ${contentId}`)
      const state = contentUserStateSchema.parse(update(current))
      await this.writeRecord(
        'content-user-states',
        contentId,
        'content user state',
        state
      )
      this.upsertContentUserState(state)
      return state
    })
  }

  async linkRelatedContents(
    input: z.input<typeof relatedContentSchema>
  ): Promise<RelatedContent> {
    return this.serializeMutation(async () => {
      const relation = relatedContentSchema.parse(input)
      const [left, right] = relation.contentIds
      if (left === right) throw new Error('Related contents must be distinct')
      if (!this.getContent(left) || !this.getContent(right)) {
        throw new Error('Related contents must both exist')
      }
      if (left.split(':', 1)[0] === right.split(':', 1)[0]) {
        throw new Error('Related contents must use distinct platforms')
      }
      if (this.hasRecord('content_relations', relation.id)) {
        throw new Error(`Content relation ${relation.id} is immutable`)
      }
      await this.writeRecord(
        'content-relations',
        relation.id,
        'content relation',
        relation
      )
      this.upsertRelatedContent(relation)
      return relation
    })
  }

  listRelatedContents(contentId?: string): RelatedContent[] {
    const rows = contentId
      ? this.database
          .prepare(
            `SELECT record_json FROM content_relations
             WHERE left_content_id = ? OR right_content_id = ?
             ORDER BY id`
          )
          .all(contentId, contentId)
      : this.database
          .prepare('SELECT record_json FROM content_relations ORDER BY id')
          .all()
    return rows
      .map((row) => rowRecord(row, relatedContentSchema))
      .filter((record): record is RelatedContent => Boolean(record))
  }

  async completeContentEnrichment(
    id: string,
    input: {
      body: string
      canonicalUrl?: string
      media?: Record<string, unknown>
      images?: Array<{ order: number; url: string }>
      sourceText?: string
    }
  ): Promise<ContentRecord> {
    return this.serializeMutation(async () => {
      const content = this.getContent(id)
      if (!content) throw new Error(`Content does not exist: ${id}`)
      if (content.body.trim() && content.enrichmentStatus === 'succeeded') {
        return content
      }
      if (!input.body.trim()) throw new Error('Completed content body is empty')
      const completed = contentRecordSchema.parse({
        ...content,
        body: input.body,
        canonicalUrl: input.canonicalUrl ?? content.canonicalUrl,
        media: input.media ?? content.media,
        images: input.images ?? content.images,
        sourceText: input.sourceText ?? content.sourceText,
        enrichmentStatus: 'succeeded',
        enrichmentError: undefined,
      })
      await atomicWriteFile(
        this.contentMarkdownPath(id),
        recordMarkdown('content', completed)
      )
      this.upsertContent(completed)
      return completed
    })
  }

  async waitForManualTranscription(id: string): Promise<ContentRecord> {
    return this.serializeMutation(async () => {
      const content = this.getContent(id)
      if (!content) throw new Error(`Content does not exist: ${id}`)
      if (content.body.trim() && content.enrichmentStatus === 'succeeded') {
        return content
      }
      const waiting = contentRecordSchema.parse({
        ...content,
        enrichmentStatus: 'waiting-manual-transcription',
        enrichmentError: undefined,
      })
      await atomicWriteFile(
        this.contentMarkdownPath(id),
        recordMarkdown('content', waiting)
      )
      this.upsertContent(waiting)
      return waiting
    })
  }

  async mergeContentIdentity(
    fromId: string,
    canonicalId: string,
    input: {
      body: string
      canonicalUrl: string
      images?: Array<{ order: number; url: string }>
    }
  ): Promise<ContentRecord> {
    return this.serializeMutation(async () => {
      if (fromId === canonicalId) {
        const content = this.getContent(fromId)
        if (!content) throw new Error(`Content does not exist: ${fromId}`)
        if (content.body.trim() && content.enrichmentStatus === 'succeeded') {
          return content
        }
        if (!input.body.trim())
          throw new Error('Completed content body is empty')
        const completed = contentRecordSchema.parse({
          ...content,
          ...input,
          enrichmentStatus: 'succeeded',
          enrichmentError: undefined,
        })
        await atomicWriteFile(
          this.contentMarkdownPath(fromId),
          recordMarkdown('content', completed)
        )
        this.upsertContent(completed)
        return completed
      }

      const source = this.getContent(fromId)
      if (!source) throw new Error(`Content does not exist: ${fromId}`)
      if (!input.body.trim()) throw new Error('Completed content body is empty')
      if (
        this.database
          .prepare('SELECT 1 FROM analyses WHERE content_id = ?')
          .get(fromId)
      ) {
        throw new Error('Cannot merge content identity after analysis')
      }
      const existing = this.getContent(canonicalId)
      const canonical = contentRecordSchema.parse(
        existing?.body.trim() && existing.enrichmentStatus === 'succeeded'
          ? existing
          : {
              ...source,
              ...existing,
              ...input,
              id: canonicalId,
              enrichmentStatus: 'succeeded',
              enrichmentError: undefined,
            }
      )
      await atomicWriteFile(
        this.contentMarkdownPath(canonicalId),
        recordMarkdown('content', canonical)
      )
      this.upsertContent(canonical)

      const discoveries = this.database
        .prepare('SELECT record_json FROM discoveries WHERE content_id = ?')
        .all(fromId)
        .map((row) => rowRecord(row, discoveryRecordSchema))
        .filter((record): record is z.infer<typeof discoveryRecordSchema> =>
          Boolean(record)
        )
      for (const discovery of discoveries) {
        const migrated = discoveryRecordSchema.parse({
          ...discovery,
          contentId: canonicalId,
        })
        await this.writeRecord(
          'discoveries',
          migrated.id,
          'discovery',
          migrated
        )
        this.upsertDiscovery(migrated)
      }
      await rm(path.dirname(this.contentMarkdownPath(fromId)), {
        recursive: true,
        force: true,
      })
      this.database.prepare('DELETE FROM contents WHERE id = ?').run(fromId)
      return canonical
    })
  }

  async failContentEnrichment(
    id: string,
    error: string
  ): Promise<ContentRecord> {
    return this.serializeMutation(async () => {
      const content = this.getContent(id)
      if (!content) throw new Error(`Content does not exist: ${id}`)
      const failed = contentRecordSchema.parse({
        ...content,
        enrichmentStatus: 'failed',
        enrichmentError: redactText(error),
      })
      await atomicWriteFile(
        this.contentMarkdownPath(id),
        recordMarkdown('content', failed)
      )
      this.upsertContent(failed)
      return failed
    })
  }

  getAnalysisByFingerprint(
    contentId: string,
    fingerprint: string
  ): AnalysisRecord | undefined {
    return rowRecord(
      this.database
        .prepare(
          `SELECT record_json FROM analyses
           WHERE content_id = ? AND fingerprint = ?
           ORDER BY version DESC LIMIT 1`
        )
        .get(contentId, fingerprint),
      analysisRecordSchema
    )
  }

  listAnalyses(contentId?: string): AnalysisRecord[] {
    const rows = contentId
      ? this.database
          .prepare(
            'SELECT record_json FROM analyses WHERE content_id = ? ORDER BY version DESC'
          )
          .all(contentId)
      : this.database
          .prepare('SELECT record_json FROM analyses ORDER BY created_at DESC')
          .all()
    return rows
      .map((row) => rowRecord(row, analysisRecordSchema))
      .filter((record): record is AnalysisRecord => Boolean(record))
  }

  nextAnalysisVersion(contentId: string): number {
    const row = this.database
      .prepare(
        'SELECT COALESCE(MAX(version), 0) AS version FROM analyses WHERE content_id = ?'
      )
      .get(contentId) as { version?: unknown } | undefined
    return Number(row?.version ?? 0) + 1
  }

  async saveAnalysis(
    input: z.input<typeof analysisRecordSchema>
  ): Promise<AnalysisRecord> {
    return this.serializeMutation(async () => {
      const analysis = analysisRecordSchema.parse(input)
      if (containsSensitiveKey(analysis.result)) {
        throw new Error('Analysis result cannot contain secrets')
      }
      if (this.hasRecord('analyses', analysis.id)) {
        throw new Error(`Analysis ${analysis.id} is immutable`)
      }
      if (!analysis.manual) {
        const existing = this.getAnalysisByFingerprint(
          analysis.contentId,
          analysis.fingerprint
        )
        if (existing) return existing
      }
      const content = this.getContent(analysis.contentId)
      if (!content?.body.trim() || content.enrichmentStatus !== 'succeeded') {
        throw new Error('Only completely enriched content can be analyzed')
      }
      await this.writeRecord('analyses', analysis.id, 'analysis', analysis)
      this.upsertAnalysis(analysis)
      return analysis
    })
  }

  async saveAnalysisCall(
    input: z.input<typeof analysisCallSchema>
  ): Promise<AnalysisCall> {
    return this.serializeMutation(async () => {
      const call = analysisCallSchema.parse({
        ...input,
        error: input.error ? redactText(input.error) : undefined,
      })
      if (this.hasRecord('analysis_calls', call.id)) {
        throw new Error(`Analysis call ${call.id} is immutable`)
      }
      await this.writeRecord('analysis-calls', call.id, 'analysis call', call)
      this.upsertAnalysisCall(call)
      return call
    })
  }

  listAnalysisCalls(contentId?: string): AnalysisCall[] {
    const rows = contentId
      ? this.database
          .prepare(
            'SELECT record_json FROM analysis_calls WHERE content_id = ? ORDER BY id DESC'
          )
          .all(contentId)
      : this.database
          .prepare('SELECT record_json FROM analysis_calls ORDER BY id DESC')
          .all()
    return rows
      .map((row) => rowRecord(row, analysisCallSchema))
      .filter((record): record is AnalysisCall => Boolean(record))
  }

  contentMarkdownPath(contentId: string): string {
    return path.join(
      this.folder('contents'),
      storageKey(contentId),
      'content.md'
    )
  }

  async saveContentMedia(
    contentId: string,
    filename: string,
    bytes: Uint8Array
  ): Promise<string> {
    this.assertSafeMediaFilename(filename)
    const target = path.join(
      this.folder('contents'),
      storageKey(contentId),
      filename
    )
    await atomicWriteFile(target, bytes)
    return target
  }

  getProgress(sourceId: string): z.infer<typeof progressSchema> | undefined {
    return rowRecord(
      this.database
        .prepare('SELECT record_json FROM progress WHERE source_id = ?')
        .get(sourceId),
      progressSchema
    )
  }

  async saveAudit(input: z.input<typeof auditSchema>): Promise<RuntimeAudit> {
    return this.serializeMutation(() => this.saveAuditLocked(input))
  }

  private async saveAuditLocked(
    input: z.input<typeof auditSchema>
  ): Promise<RuntimeAudit> {
    const audit = auditSchema.parse({
      ...input,
      error: input.error ? redactText(input.error) : undefined,
    })
    if (this.hasRecord('audits', audit.id)) {
      throw new Error(`Audit ${audit.id} is immutable`)
    }
    await this.writeRecord('audits', audit.id, 'collection audit', audit)
    this.upsertAudit(audit)
    return audit
  }

  async getAudit(id: string): Promise<RuntimeAudit | undefined> {
    return rowRecord(
      this.database
        .prepare('SELECT record_json FROM audits WHERE id = ?')
        .get(id),
      auditSchema
    )
  }

  listAudits(): RuntimeAudit[] {
    return this.database
      .prepare('SELECT record_json FROM audits ORDER BY id DESC')
      .all()
      .map((row) => rowRecord(row, auditSchema))
      .filter((audit): audit is RuntimeAudit => Boolean(audit))
  }

  async saveProviderAttempt(
    input: z.input<typeof providerAttemptSchema>
  ): Promise<ProviderAttempt> {
    return this.serializeMutation(async () => {
      const attempt = providerAttemptSchema.parse({
        ...input,
        error: input.error ? redactText(input.error) : undefined,
      })
      if (
        this.database
          .prepare('SELECT 1 FROM provider_attempts WHERE id = ?')
          .get(attempt.id)
      ) {
        throw new Error(`Provider attempt ${attempt.id} is immutable`)
      }
      await this.writeRecord(
        'provider-attempts',
        attempt.id,
        'provider attempt',
        attempt
      )
      this.upsertProviderAttempt(attempt)
      return attempt
    })
  }

  listProviderAttempts(sourceId?: string): ProviderAttempt[] {
    const rows = sourceId
      ? this.database
          .prepare(
            'SELECT record_json FROM provider_attempts WHERE source_id = ? ORDER BY id'
          )
          .all(sourceId)
      : this.database
          .prepare('SELECT record_json FROM provider_attempts ORDER BY id')
          .all()
    return rows
      .map((row) => rowRecord(row, providerAttemptSchema))
      .filter((value): value is ProviderAttempt => Boolean(value))
  }

  async saveProviderHealth(
    input: Omit<z.input<typeof providerHealthSchema>, 'updatedAt'> & {
      updatedAt?: string
    }
  ): Promise<ProviderHealthRecord> {
    return this.serializeMutation(async () => {
      const state = providerHealthSchema.parse({
        ...input,
        updatedAt: input.updatedAt ?? nowIso(),
      })
      await this.writeRecord(
        'provider-health',
        state.providerId,
        'provider health',
        state
      )
      this.upsertProviderHealth(state)
      return state
    })
  }

  getProviderHealth(providerId: string): ProviderHealthRecord | undefined {
    return rowRecord(
      this.database
        .prepare(
          'SELECT record_json FROM provider_health WHERE provider_id = ?'
        )
        .get(providerId),
      providerHealthSchema
    )
  }

  async saveInteractionSnapshot(
    input: z.input<typeof interactionSnapshotSchema>
  ): Promise<InteractionSnapshot> {
    return this.serializeMutation(async () => {
      const snapshot = interactionSnapshotSchema.parse(input)
      if (
        this.database
          .prepare('SELECT 1 FROM interaction_snapshots WHERE id = ?')
          .get(snapshot.id)
      ) {
        throw new Error(`Interaction snapshot ${snapshot.id} is immutable`)
      }
      await this.writeRecord(
        'interaction-snapshots',
        snapshot.id,
        'interaction snapshot',
        snapshot
      )
      this.upsertInteractionSnapshot(snapshot)
      return snapshot
    })
  }

  listInteractionSnapshots(contentId?: string): InteractionSnapshot[] {
    const rows = contentId
      ? this.database
          .prepare(
            'SELECT record_json FROM interaction_snapshots WHERE content_id = ? ORDER BY captured_at, id'
          )
          .all(contentId)
      : this.database
          .prepare(
            'SELECT record_json FROM interaction_snapshots ORDER BY captured_at, id'
          )
          .all()
    return rows
      .map((row) => rowRecord(row, interactionSnapshotSchema))
      .filter((value): value is InteractionSnapshot => Boolean(value))
  }

  async saveRawResponse(input: {
    id: string
    providerId: string
    receivedAt: string
    expiresAt?: string
    retentionDays?: number
    payload: unknown
  }): Promise<string> {
    timestampSchema.parse(input.receivedAt)
    const retentionDays = input.retentionDays ?? 30
    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
      throw new Error('Raw response retention must be a positive day count')
    }
    const expiresAt =
      input.expiresAt ??
      new Date(
        Date.parse(input.receivedAt) + retentionDays * 24 * 60 * 60 * 1000
      ).toISOString()
    timestampSchema.parse(expiresAt)
    const target = path.join(
      this.root,
      '.raw-responses',
      `${storageKey(input.id)}.json`
    )
    await atomicWriteFile(
      target,
      `${JSON.stringify(
        {
          id: input.id,
          providerId: input.providerId,
          receivedAt: input.receivedAt,
          expiresAt,
          payload: redactStructured(input.payload),
        },
        null,
        2
      )}\n`
    )
    return target
  }

  async purgeExpiredRawResponses(at = nowIso()): Promise<number> {
    let purged = 0
    const directory = path.join(this.root, '.raw-responses')
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const target = path.join(directory, entry.name)
      const record = JSON.parse(await readFile(target, 'utf8')) as {
        expiresAt?: unknown
      }
      if (typeof record.expiresAt === 'string' && record.expiresAt <= at) {
        await rm(target)
        purged += 1
      }
    }
    return purged
  }

  private folder(name: string): string {
    return path.join(this.root, name)
  }

  private hasRecord(
    table:
      | 'analyses'
      | 'analysis_calls'
      | 'audits'
      | 'content_relations'
      | 'contents'
      | 'discoveries',
    id: string
  ): boolean {
    return Boolean(
      this.database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)
    )
  }

  private async writeRecord(
    folder: string,
    id: string,
    kind: string,
    record: unknown
  ): Promise<void> {
    await atomicWriteFile(
      path.join(this.folder(folder), `${storageKey(id)}.md`),
      recordMarkdown(kind, record)
    )
  }

  private assertSafeMediaFilename(value: string): void {
    const stem = value.split('.')[0]?.toUpperCase()
    const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u
    if (
      !/^[a-z0-9][a-z0-9._-]*$/u.test(value) ||
      value.endsWith('.') ||
      value.includes('..') ||
      (stem && reserved.test(stem))
    ) {
      throw new Error(`Unsafe media filename: ${value}`)
    }
  }

  private upsertTask(task: RuntimeTask): StatementResultingChanges {
    const change = this.database
      .prepare(
        `INSERT INTO tasks
          (id, idempotency_key, source_id, type, status, available_at, created_at, payload_json, record_json, content_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          idempotency_key = excluded.idempotency_key,
          source_id = excluded.source_id,
          type = excluded.type,
          status = excluded.status,
          available_at = excluded.available_at,
          created_at = excluded.created_at,
          payload_json = excluded.payload_json,
          record_json = excluded.record_json,
          content_id = excluded.content_id`
      )
      .run(
        task.id,
        task.idempotencyKey,
        task.sourceId ?? null,
        task.type,
        task.status,
        task.availableAt,
        task.createdAt,
        JSON.stringify(task.payload),
        JSON.stringify(task),
        typeof task.payload.contentId === 'string'
          ? task.payload.contentId
          : null
      )
    if (typeof task.payload.contentId === 'string')
      this.refreshContentList(task.payload.contentId)
    return change
  }

  private upsertParameter(version: RuntimeParameterVersion): void {
    this.database
      .prepare(
        `INSERT INTO parameters (id, scope_key, created_at, record_json)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        version.id,
        scopeKey(version.scope),
        version.createdAt,
        JSON.stringify(version)
      )
  }

  private upsertContent(content: z.infer<typeof contentRecordSchema>): void {
    this.database
      .prepare(
        `INSERT INTO contents (id, record_json) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json`
      )
      .run(content.id, JSON.stringify(content))
    this.refreshContentList(content.id)
  }

  private upsertSource(source: ManagedSource): void {
    this.database
      .prepare(
        `INSERT INTO sources (id, sort_order, record_json) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          sort_order = excluded.sort_order,
          record_json = excluded.record_json`
      )
      .run(source.id, source.sortOrder ?? 999_999, JSON.stringify(source))
    if (!this.rebuildingIndex) {
      for (const row of this.database
        .prepare(
          "SELECT id FROM contents WHERE json_extract(record_json, '$.sourceId') = ?"
        )
        .all(source.id)) {
        this.refreshContentList((row as { id: string }).id)
      }
    }
  }

  private upsertContentUserState(state: ContentUserState): void {
    this.database
      .prepare(
        `INSERT INTO content_user_states (content_id, record_json) VALUES (?, ?)
         ON CONFLICT(content_id) DO UPDATE SET record_json = excluded.record_json`
      )
      .run(state.contentId, JSON.stringify(state))
    this.refreshContentList(state.contentId)
  }

  private upsertJunkSample(sample: z.infer<typeof junkSampleSchema>): void {
    this.database
      .prepare(
        'INSERT INTO junk_samples (id, content_id, created_at, record_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING'
      )
      .run(
        sample.id,
        sample.contentId,
        sample.createdAt,
        JSON.stringify(sample)
      )
  }

  private upsertDiscovery(
    discovery: z.infer<typeof discoveryRecordSchema>
  ): void {
    this.database
      .prepare(
        `INSERT INTO discoveries (id, source_id, content_id, record_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          source_id = excluded.source_id,
          content_id = excluded.content_id,
          record_json = excluded.record_json`
      )
      .run(
        discovery.id,
        discovery.sourceId,
        discovery.contentId,
        JSON.stringify(discovery)
      )
  }

  private upsertProgress(progress: z.infer<typeof progressSchema>): void {
    this.database
      .prepare(
        `INSERT INTO progress (source_id, cursor, record_json) VALUES (?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
          cursor = excluded.cursor,
          record_json = excluded.record_json`
      )
      .run(progress.sourceId, progress.cursor ?? '', JSON.stringify(progress))
  }

  private upsertAudit(audit: RuntimeAudit): void {
    this.database
      .prepare(
        `INSERT INTO audits (id, source_id, record_json) VALUES (?, ?, ?)`
      )
      .run(audit.id, audit.sourceId, JSON.stringify(audit))
  }

  private upsertProviderAttempt(attempt: ProviderAttempt): void {
    this.database
      .prepare(
        `INSERT INTO provider_attempts
          (id, source_id, provider_id, record_json) VALUES (?, ?, ?, ?)`
      )
      .run(
        attempt.id,
        attempt.sourceId,
        attempt.providerId,
        JSON.stringify(attempt)
      )
  }

  private upsertProviderHealth(state: ProviderHealthRecord): void {
    this.database
      .prepare(
        `INSERT INTO provider_health (provider_id, record_json) VALUES (?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET record_json = excluded.record_json`
      )
      .run(state.providerId, JSON.stringify(state))
  }

  private upsertInteractionSnapshot(snapshot: InteractionSnapshot): void {
    this.database
      .prepare(
        `INSERT INTO interaction_snapshots
          (id, content_id, source_id, captured_at, record_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.id,
        snapshot.contentId,
        snapshot.sourceId,
        snapshot.capturedAt,
        JSON.stringify(snapshot)
      )
    this.refreshContentList(snapshot.contentId)
  }

  private upsertRelatedContent(relation: RelatedContent): void {
    this.database
      .prepare(
        `INSERT INTO content_relations
          (id, left_content_id, right_content_id, record_json)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        relation.id,
        relation.contentIds[0],
        relation.contentIds[1],
        JSON.stringify(relation)
      )
  }

  private upsertAnalysis(analysis: AnalysisRecord): void {
    this.database
      .prepare(
        `INSERT INTO analyses
          (id, content_id, fingerprint, version, created_at, record_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        analysis.id,
        analysis.contentId,
        analysis.fingerprint,
        analysis.version,
        analysis.createdAt,
        JSON.stringify(analysis)
      )
    this.refreshContentList(analysis.contentId)
  }

  private upsertAnalysisCall(call: AnalysisCall): void {
    this.database
      .prepare(
        `INSERT INTO analysis_calls (id, content_id, status, record_json)
         VALUES (?, ?, ?, ?)`
      )
      .run(call.id, call.contentId, call.status, JSON.stringify(call))
  }
}

export async function runPendingTasks(
  repository: RuntimeRepository,
  options: {
    concurrency: number
    workerIdPrefix: string
    handler(task: RuntimeTask): Promise<void>
  }
): Promise<void> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('Concurrency must be a positive integer')
  }
  await Promise.all(
    Array.from({ length: options.concurrency }, async (_, index) => {
      const workerId = `${options.workerIdPrefix}-${index + 1}`
      for (;;) {
        const task = await repository.claimNextTask(workerId)
        if (!task) return
        try {
          await options.handler(task)
          await repository.completeTask(task.id)
        } catch (error) {
          await repository.failTask(
            task.id,
            error instanceof Error ? error.message : String(error)
          )
        }
      }
    })
  )
}
