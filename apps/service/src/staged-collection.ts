import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  collectSourcesSerially,
  translateSingleTableContent,
  type CollectSourcesOptions,
  type ConfiguredSource,
  type DiscoveredContent,
  type DiscoveryWindow,
  type SinglePageDiscovery,
} from '@qiushui-airadar/pipeline'
import { contentIdentity, type OriginalContent } from '@qiushui-airadar/runtime'
import { classifyUnprocessedContent } from '@qiushui-airadar/source-adapters'
import {
  loadSourceState,
  saveSourceState,
  type CollectionSettings,
} from '@qiushui-airadar/config'
import {
  addCollectionRunEvent,
  type beginCollectionRun,
} from './collection-run.js'

type Tracker = Awaited<ReturnType<typeof beginCollectionRun>>
type Settings = CollectionSettings
interface Job {
  key: string
  source: ConfiguredSource
  item: DiscoveredContent
  rowId: string
  pageFile: string
  status: 'pending' | 'analyzed' | 'failed' | 'done'
}
interface Work {
  version: 1
  processMedia?: boolean
  processTwitterVideos?: boolean
  minimumScore: number
  concurrency?: Pick<
    Settings,
    | 'scan_concurrency'
    | 'processing_concurrency'
    | 'translation_concurrency'
    | 'requests_per_second'
  >
  jobs: Job[]
  scannedSources: string[]
}

export async function concurrentEach<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>
) {
  let index = 0
  let failure: unknown
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length && !failure) {
        const item = items[index++]!
        try {
          await task(item)
        } catch (error) {
          failure = error
        }
      }
    })
  )
  if (failure) throw failure
}

// Durable jobs never contain authentication headers, including injected providers.
function safe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safe)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /authorization|api.?key|cookie|secret|token/iu.test(key)
          ? '[REDACTED]'
          : safe(item),
      ])
    )
  return value
}

function originalInput(
  source: ConfiguredSource,
  item: DiscoveredContent
): Omit<OriginalContent, 'body'> {
  return {
    platform: source.platform,
    sourceType: source.platform,
    sourceAccountId: source.id,
    sourceAccountName: source.account_name,
    externalContentId: item.externalId,
    canonicalUrl: item.url,
    title: item.title ?? item.externalId,
    originalTitle: item.title,
    kind: item.kind,
    format: item.format ?? 'plain_text',
    language: source.language,
    publishedAt: item.publishedAt,
  }
}

export async function collectInStages(
  options: CollectSourcesOptions & {
    tracker: Tracker
    configRoot: string
    settings: Settings
  }
) {
  const { tracker, repository } = options
  const root = path.join(repository.dataRoot, 'collection-work', tracker.run.id)
  await mkdir(root, { recursive: true })
  const stateFile = path.join(root, 'work.json')
  let work: Work
  try {
    work = JSON.parse(await readFile(stateFile, 'utf8')) as Work
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    work = {
      version: 1,
      processMedia: options.settings.process_media,
      minimumScore: options.translationMinimumTotalScore,
      concurrency: {
        scan_concurrency: options.settings.scan_concurrency,
        processing_concurrency: options.settings.processing_concurrency,
        translation_concurrency: options.settings.translation_concurrency,
        requests_per_second: options.settings.requests_per_second,
      },
      jobs: [],
      scannedSources: [],
    }
  }
  const settings = { ...options.settings, ...work.concurrency }
  options = {
    ...options,
    processMedia:
      work.processMedia ??
      work.processTwitterVideos ??
      options.settings.process_media,
    translationMinimumTotalScore:
      work.minimumScore ?? options.translationMinimumTotalScore,
  }
  const sourceState = await loadSourceState(options.configRoot)
  // Serialize durable writes and identity claims; model and network waits stay parallel.
  let writing = Promise.resolve()
  function exclusively<T>(task: () => Promise<T>): Promise<T> {
    const result = writing.then(task)
    writing = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  async function atomic(file: string, value: unknown) {
    const temporary = `${file}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(safe(value)), { mode: 0o600 })
    await rename(temporary, file)
  }
  const saveWork = () => atomic(stateFile, work)
  async function phase(value: 'scanning' | 'analyzing' | 'translating') {
    tracker.run.phase = value
    tracker.run.phaseStartedAt ??= {}
    tracker.run.phaseStartedAt[value] ??= new Date().toISOString()
    await tracker.save()
  }
  const entryFor = (sourceId: string) =>
    tracker.run.sources.find((row) => row.sourceId === sourceId)!
  async function saveProgress(sourceId: string) {
    const latest = await loadSourceState(options.configRoot)
    const progress = sourceState.sources[sourceId]!
    latest.sources[sourceId] = {
      ...latest.sources[sourceId],
      discovered_until: progress.discovered_until,
      last_collected_at: progress.last_collected_at,
      next_reconcile_at: progress.next_reconcile_at,
      pending_window: progress.pending_window,
    }
    await saveSourceState(options.configRoot, latest)
  }
  const until = tracker.run.startedAt
  const untilMs = Date.parse(until)
  const day = 86_400_000
  await phase('scanning')
  await concurrentEach(
    options.sources.filter((source) => source.enabled),
    settings.scan_concurrency,
    async (source) => {
      await options.waitUntilRunnable?.()
      const entry = entryFor(source.id)
      const progress = (sourceState.sources[source.id] ??= {})
      if (work.scannedSources.includes(source.id)) return
      addCollectionRunEvent(tracker.run, {
        action: 'source-started',
        status: 'running',
        sourceId: source.id,
        sourceName: source.account_name,
        message: `开始扫描信源「${source.account_name}」`,
      })
      entry.status = 'running'
      entry.discoveryPending = false
      let window: DiscoveryWindow = progress.pending_window ?? {
        mode: settings.mode === 'incremental' ? 'search' : 'timeline',
        since: new Date(
          progress.discovered_until
            ? Date.parse(progress.discovered_until) -
                settings.overlap_hours * 3_600_000
            : untilMs - 7 * day
        ).toISOString(),
        until,
      }
      if (source.platform !== 'x') window = { ...window, mode: 'timeline' }
      let pages = 0
      let received = 0
      const batchLimit =
        progress.last_collected_at ||
        progress.discovered_until ||
        progress.pending_window
          ? 100
          : 20
      try {
        while (pages++ < settings.maximum_pages_per_source) {
          await options.waitUntilRunnable?.()
          const page = await options.provider.discover(
            source,
            undefined,
            window
          )
          received += page.rawCount ?? page.items.length
          // A repeated cursor is a provider failure, never proof that the window is complete.
          if (page.nextCursor && page.nextCursor === window.cursor)
            throw new Error('分页游标未前进，保留窗口待补齐')
          const pageFile = `${source.id}-${randomUUID()}.json`
          await exclusively(async () => {
            const serializedResponse = JSON.stringify(safe(page.response)) ?? ''
            await atomic(path.join(root, pageFile), {
              ...page,
              items: undefined,
              response:
                serializedResponse.length > 32768
                  ? {
                      truncated: true,
                      prefix: serializedResponse.slice(0, 32768),
                    }
                  : page.response,
            })
            entry.discovered += page.rawCount ?? page.items.length
            for (const item of page.items) {
              const input = originalInput(source, item)
              const key = contentIdentity({ ...input, body: '' }).key
              const existing = repository.get(key)
              const excludedReason = classifyUnprocessedContent({
                platform: source.platform,
                kind: item.mediaType ?? item.kind,
                url: item.url,
                processMedia: options.processMedia,
              })
              if (excludedReason) {
                const row = existing ?? (await repository.saveDiscovery(input))
                await repository.setUnprocessed(row.id, excludedReason)
                if (!existing) entry.newlyInflow = (entry.newlyInflow ?? 0) + 1
                entry.skipped++
                continue
              }
              if (existing || work.jobs.some((job) => job.key === key)) {
                entry.duplicates = (entry.duplicates ?? 0) + 1
                if (
                  existing?.process_status === 'completed' &&
                  !existing.is_unprocessed
                ) {
                  entry.completed++
                  entry.existingCompleted = (entry.existingCompleted ?? 0) + 1
                } else entry.skipped++
                if (item.interaction)
                  repository.updateInteractionBySourceId(
                    source.id,
                    item.externalId,
                    item.interaction
                  )
                continue
              }
              // Save the replayable job before the searchable placeholder. A crash
              // between these writes is repaired from this job on resume.
              const job: Job = {
                key,
                source,
                item,
                rowId: '',
                pageFile,
                status: 'pending',
              }
              work.jobs.push(job)
              await saveWork()
              job.rowId = (await repository.saveDiscovery(input)).id
              entry.newlyInflow = (entry.newlyInflow ?? 0) + 1
            }
            await saveWork()
            const dates = page.items
              .map((item) => item.publishedAt)
              .filter((date): date is string => Boolean(date))
            const oldPage =
              window.mode === 'timeline' &&
              page.items.length > 0 &&
              dates.length === page.items.length &&
              dates.every((date) => Date.parse(date) < Date.parse(window.since))
            const complete =
              !page.nextCursor || oldPage || source.platform !== 'x'
            if (!complete) {
              window = { ...window, cursor: page.nextCursor }
              progress.pending_window = window
            } else {
              progress.pending_window = undefined
              if (
                window.mode === 'search' ||
                settings.mode === 'timeline' ||
                source.platform !== 'x'
              )
                progress.discovered_until = window.until
              progress.last_collected_at = new Date().toISOString()
              if (window.mode === 'timeline')
                progress.next_reconcile_at = new Date(
                  untilMs + settings.reconciliation_days * day
                ).toISOString()
              const reconciliationDue =
                source.platform === 'x' &&
                settings.mode === 'incremental' &&
                window.mode === 'search' &&
                progress.next_reconcile_at &&
                Date.parse(progress.next_reconcile_at) <= untilMs
              if (
                source.platform === 'x' &&
                settings.mode === 'incremental' &&
                window.until < until
              ) {
                window = {
                  mode: 'search',
                  since: new Date(
                    Date.parse(window.until) -
                      settings.overlap_hours * 3_600_000
                  ).toISOString(),
                  until,
                }
                progress.pending_window = window
              } else if (reconciliationDue) {
                window = {
                  mode: 'timeline',
                  since: new Date(
                    untilMs - settings.reconciliation_days * day
                  ).toISOString(),
                  until,
                }
                progress.pending_window = window
              } else {
                if (!progress.next_reconcile_at || window.mode === 'timeline')
                  progress.next_reconcile_at = new Date(
                    untilMs + settings.reconciliation_days * day
                  ).toISOString()
                work.scannedSources.push(source.id)
              }
            }
            await saveWork()
            await saveProgress(source.id)
            await tracker.save()
          })
          if (work.scannedSources.includes(source.id)) break
          if (received >= batchLimit) break
        }
        if (!work.scannedSources.includes(source.id)) {
          entry.discoveryPending = true
          entry.discoveryError =
            '达到本轮分页上限，后续继续补齐；采集位置未跳过积压。'
        }
      } catch (error) {
        if (String(error).includes('COLLECTION_INTERRUPTED')) throw error
        entry.failed++
        entry.discoveryPending = true
        entry.discoveryError =
          error instanceof Error ? error.message : '扫描失败'
        await exclusively(async () => {
          progress.pending_window = window
          await saveProgress(source.id)
        })
        options.onError?.(source, undefined, error)
      }
      addCollectionRunEvent(tracker.run, {
        action: 'source-completed',
        status: entry.discoveryPending ? 'failed' : 'succeeded',
        sourceId: source.id,
        sourceName: source.account_name,
        message: entry.discoveryPending
          ? `信源「${source.account_name}」扫描待补齐`
          : `信源「${source.account_name}」扫描完成，内容等待后台处理`,
      })
      entry.status = 'completed'
      await tracker.save()
    }
  )
  tracker.run.scanningEndedAt = new Date().toISOString()
  await phase('analyzing')
  const processingIdentities = new Map<string, Promise<void>>()
  await concurrentEach(
    work.jobs.filter((job) => job.status === 'pending'),
    settings.processing_concurrency,
    async (job) => {
      await options.waitUntilRunnable?.()
      job.rowId = (
        await repository.saveDiscovery(originalInput(job.source, job.item))
      ).id
      const page = JSON.parse(
        await readFile(path.join(root, job.pageFile), 'utf8')
      ) as SinglePageDiscovery
      let releaseIdentity: (() => void) | undefined
      let resolvedExisting = false
      const [result] = await collectSourcesSerially({
        ...options,
        sources: [job.source],
        resumeIncomplete: true,
        resumeStartedAt: tracker.run.startedAt,
        runStartedAt: tracker.run.startedAt,
        deferTranslation: true,
        provider: {
          discover: async () => ({ ...page, items: [job.item] }),
          async resolve(source, item) {
            const resolved = await options.provider.resolve(source, item)
            const key = contentIdentity(resolved.original).key
            while (processingIdentities.has(key))
              await processingIdentities.get(key)
            processingIdentities.set(
              key,
              new Promise<void>((resolve) => {
                releaseIdentity = () => {
                  processingIdentities.delete(key)
                  resolve()
                }
              })
            )
            const before = repository.get(key)
            resolvedExisting = before?.process_status === 'completed'
            const row = repository.reconcileDiscovery(
              job.rowId,
              resolved.original
            )
            if (row) job.rowId = row.id
            return resolved
          },
        },
        onProgress: undefined,
        afterSource: undefined,
      }).finally(() => {
        releaseIdentity?.()
      })
      const entry = entryFor(job.source.id)
      entry.completed += result!.completed
      if (resolvedExisting) {
        entry.existingCompleted =
          (entry.existingCompleted ?? 0) + result!.completed
        entry.newlyInflow = Math.max(0, (entry.newlyInflow ?? 0) - 1)
      } else
        entry.newlyCompleted = (entry.newlyCompleted ?? 0) + result!.completed
      entry.failed += result!.failed
      entry.skipped += result!.skipped
      job.status = result!.failed ? 'failed' : 'analyzed'
      await exclusively(saveWork)
      await tracker.save()
    }
  )
  await phase('translating')
  const translationIds = new Set<string>()
  await concurrentEach(
    work.jobs.filter((job) => job.status === 'analyzed'),
    settings.translation_concurrency,
    async (job) => {
      await options.waitUntilRunnable?.()
      if (translationIds.has(job.rowId)) {
        job.status = 'done'
        return
      }
      translationIds.add(job.rowId)
      const row = repository.getById(job.rowId)
      if (
        row &&
        row.process_status === 'completed' &&
        row.original_language === 'en' &&
        !row.is_junk &&
        !row.is_unprocessed &&
        row.total_score !== null &&
        row.total_score >= options.translationMinimumTotalScore &&
        ['pending', 'running'].includes(row.translation_status)
      ) {
        const body = await repository.readBody(row.id, 'en')
        if (!body) throw new Error('待翻译内容原文缺失')
        try {
          await translateSingleTableContent({
            ...options,
            row,
            manual: false,
            original: {
              ...originalInput(job.source, job.item),
              body,
              title: row.title,
              originalTitle: row.original_title ?? undefined,
              format: row.original_format,
              kind: row.content_kind,
              canonicalUrl: row.canonical_url ?? undefined,
              videoDurationSeconds: row.video_duration_seconds ?? undefined,
            },
          })
          tracker.run.translated = (tracker.run.translated ?? 0) + 1
        } catch (error) {
          if (String(error).includes('COLLECTION_INTERRUPTED')) throw error
          tracker.run.translationFailed =
            (tracker.run.translationFailed ?? 0) + 1
          options.onError?.(job.source, job.item, error)
        }
      }
      job.status = 'done'
      await exclusively(saveWork)
      await tracker.save()
    }
  )
  for (const entry of tracker.run.sources) entry.status = 'completed'
  tracker.run.phase = 'finished'
  await tracker.save()
  return tracker.run.sources
}
