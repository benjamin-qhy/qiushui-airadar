import path from 'node:path'
import { appendFile, readFile } from 'node:fs/promises'

import {
  createFileSecretReader,
  initializeSingleTableConfig,
  loadSingleTableConfig,
  loadSourceState,
} from '@qiushui-airadar/config'
import {
  createFileModelCredentialStore,
  createSingleTableModelGateway,
} from '@qiushui-airadar/pipeline'
import { SingleTableRepository } from '@qiushui-airadar/runtime'
import { createSingleTableSourceProvider } from './single-table-provider.js'
import { transcribeXVideo } from './x-video-transcriber.js'
import { addCollectionRunEvent, beginCollectionRun } from './collection-run.js'
import { collectInStages } from './staged-collection.js'

export interface CollectionControl {
  modelFailureMessage?: string
  bind(onPausedChange: (paused: boolean) => Promise<void>): void
  pause(): Promise<void>
  pauseForModelFailure(message: string): Promise<void>
  interrupt(): void
  resume(): Promise<void>
  waitUntilRunnable(): Promise<void>
}

export function createCollectionControl(): CollectionControl {
  let paused = false
  let interrupted = false
  let onPausedChange: ((paused: boolean) => Promise<void>) | undefined
  const resumeWaiters = new Set<() => void>()
  function wake() {
    for (const waiter of resumeWaiters) waiter()
    resumeWaiters.clear()
  }
  return {
    bind(callback) {
      onPausedChange = callback
    },
    async pause() {
      if (paused) return
      paused = true
      await onPausedChange?.(true)
    },
    async pauseForModelFailure(message) {
      this.modelFailureMessage = message
      if (paused) return
      paused = true
      await onPausedChange?.(true)
    },
    interrupt() {
      interrupted = true
      paused = false
      wake()
    },
    async resume() {
      if (!paused) return
      paused = false
      this.modelFailureMessage = undefined
      await onPausedChange?.(false)
      wake()
    },
    async waitUntilRunnable() {
      if (paused)
        await new Promise<void>((resolve) => {
          resumeWaiters.add(resolve)
        })
      if (interrupted) throw new Error('COLLECTION_INTERRUPTED')
    },
  }
}

export async function collectSingleTable(options: {
  dataRoot: string
  templateRoot: string
  promptsRoot: string
  secretFile?: string
  repository?: SingleTableRepository
  gateway?: import('@qiushui-airadar/pipeline').SingleTableModelGateway
  provider?: import('@qiushui-airadar/pipeline').SingleTableSourceProvider
  onStarted?: () => void
  control?: CollectionControl
  resume?: boolean
}) {
  const tracker = await beginCollectionRun(options.dataRoot, options.resume)
  try {
    options.control?.bind(async (paused) => {
      tracker.run.status = paused ? 'paused' : 'running'
      tracker.run.message = paused
        ? (options.control?.modelFailureMessage ??
          '采集已暂停，恢复后将从当前位置继续。')
        : '采集已恢复，正在从暂停位置继续。'
      addCollectionRunEvent(tracker.run, {
        action: paused ? 'collection-paused' : 'collection-resumed',
        status: paused ? 'paused' : 'running',
        message: tracker.run.message,
      })
      await tracker.save()
    })
    await tracker.save()
    options.onStarted?.()
    const results = await executeCollection(options, tracker)
    tracker.run.status = 'completed'
    tracker.run.endedAt = new Date().toISOString()
    const pending = tracker.run.sources.filter(
      (source) => source.discoveryPending
    ).length
    tracker.run.message = pending
      ? `本轮处理已结束，${pending} 个信源待补齐，已保留采集位置。`
      : `本轮扫描、评分和翻译已结束${tracker.run.translationFailed ? `，${tracker.run.translationFailed} 条翻译失败，可单独重试` : ''}。`
    addCollectionRunEvent(tracker.run, {
      action: 'collection-completed',
      status: 'succeeded',
      message: '本轮采集已完成',
    })
    await tracker.save()
    return results
  } catch (error) {
    const interrupted =
      error instanceof Error && error.message === 'COLLECTION_INTERRUPTED'
    const resumable =
      interrupted ||
      Boolean(tracker.run.phase && tracker.run.phase !== 'finished')
    tracker.run.status = resumable ? 'interrupted' : 'failed'
    tracker.run.endedAt = new Date().toISOString()
    tracker.run.message = interrupted
      ? '服务已停止，本轮进度已保存。重新启动后点击“继续上轮采集”。'
      : resumable
        ? '执行异常，已保留本轮进度；排查后点击“继续上轮采集”。'
        : '采集任务异常退出，请检查信源和模型配置后重新执行。'
    const code = (error as NodeJS.ErrnoException)?.code
    if (!interrupted && code && /^[A-Z_0-9]{1,40}$/u.test(code))
      tracker.run.message += ` 错误代码：${code}。`
    addCollectionRunEvent(tracker.run, {
      action: resumable ? 'collection-interrupted' : 'collection-failed',
      status: resumable ? 'paused' : 'failed',
      message: tracker.run.message,
    })
    await tracker.save()
    throw error
  } finally {
    await tracker.release()
  }
}

async function executeCollection(
  options: Parameters<typeof collectSingleTable>[0],
  tracker: Awaited<ReturnType<typeof beginCollectionRun>>
) {
  const dataRoot = options.dataRoot
  const configRoot = await initializeSingleTableConfig(
    options.templateRoot,
    dataRoot
  )
  const config = await loadSingleTableConfig(configRoot)
  const collectionSettings = { ...config.runtime.collection }
  if (options.resume) {
    try {
      const work = JSON.parse(
        await readFile(
          path.join(dataRoot, 'collection-work', tracker.run.id, 'work.json'),
          'utf8'
        )
      ) as { concurrency?: Partial<typeof collectionSettings> }
      Object.assign(collectionSettings, work.concurrency)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const sourceState = await loadSourceState(configRoot)
  const secretReader = createFileSecretReader(
    options.secretFile ?? path.join(dataRoot, '.env')
  )
  async function secret(name: string): Promise<string | undefined> {
    return secretReader.get(name).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
  }
  const [tikHubToken, twitterApiKey, youtubeApiKey] = await Promise.all([
    secret('TIKHUB_API_KEY'),
    secret('TWITTERAPI_IO_KEY'),
    secret('YOUTUBE_API_KEY'),
  ])
  const credentialFile = path.join(dataRoot, 'model-auth.json')
  const credentialStore = createFileModelCredentialStore(credentialFile)
  let baseGateway =
    options.gateway ??
    createSingleTableModelGateway(
      credentialStore,
      config.analysis.model.provider,
      config.analysis.model
    )
  let consecutiveModelFailures = 0
  const gateway: typeof baseGateway = options.control
    ? {
        getCapacity: baseGateway.getCapacity?.bind(baseGateway),
        async complete(input) {
          for (let attempt = 0; ; attempt++) {
            try {
              const result = await baseGateway.complete(input)
              consecutiveModelFailures = 0
              return result
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error)
              const permanent =
                /\b(?:401|402|403)\b|unauthori[sz]ed|invalid.api.key|insufficient|余额不足|额度不足|permission|forbidden/iu.test(
                  message
                )
              consecutiveModelFailures++
              if (!permanent && attempt < 2) continue
              if (!permanent && consecutiveModelFailures < 3) throw error
              const route = baseGateway.getCapacity?.(input.stage)
              const cause = /\b401\b|unauthori[sz]ed|invalid.api.key/iu.test(
                message
              )
                ? '认证失败'
                : /\b402\b|insufficient|余额不足|额度不足/iu.test(message)
                  ? '额度不足'
                  : /\b403\b|permission|forbidden/iu.test(message)
                    ? '权限不足'
                    : '超时或网络错误'
              const stageName = {
                classify: '内容判定与摘要',
                score: '价值评分',
                translate: '英文翻译',
              }[input.stage]
              await options.control!.pauseForModelFailure(
                `模型调用失败，采集已暂停。原因：${cause}；环节：${stageName}；模型：${route?.provider ?? '未知'} / ${route?.model ?? '未知'}。请检查模型配置，测试成功后点击“恢复采集”。`
              )
              await options.control!.waitUntilRunnable()
              if (!options.gateway) {
                const latest = await loadSingleTableConfig(configRoot)
                baseGateway = createSingleTableModelGateway(
                  credentialStore,
                  latest.analysis.model.provider,
                  latest.analysis.model
                )
              }
              consecutiveModelFailures = 0
              attempt = -1
            }
          }
        },
      }
    : baseGateway
  const provider =
    options.provider ??
    createSingleTableSourceProvider({
      tikHubToken,
      twitterApiKey,
      youtubeApiKey,
      providerRoutes: config.providers.routes,
      userIdCacheFile: path.join(configRoot, 'local', 'x-user-ids.json'),
      maxRetries: config.runtime.collection.max_retries,
      requestsPerSecond: collectionSettings.requests_per_second,
      xVideoTranscriber: config.analysis.transcription.auto
        ? (url) => transcribeXVideo(options.dataRoot, url)
        : undefined,
      async onRequest(metric) {
        const totals = (tracker.run.requests ??= {
          count: 0,
          durationMs: 0,
          estimatedCostUsd: 0,
          unknownPriceCount: 0,
        })
        totals.count++
        totals.durationMs += metric.durationMs
        totals.estimatedCostUsd += metric.estimatedCostUsd ?? 0
        if (metric.estimatedCostUsd === undefined) totals.unknownPriceCount++
        await appendFile(
          path.join(
            dataRoot,
            'collection-runs',
            `${tracker.run.id}-requests.jsonl`
          ),
          JSON.stringify(metric) + '\n',
          { mode: 0o600 }
        )
      },
    })
  const sources = config.sources.sources.map((source) => ({
    ...source,
    enabled: sourceState.sources[source.id]?.enabled_override ?? source.enabled,
  }))
  if (!options.resume || tracker.run.sources.length === 0)
    tracker.run.sources = sources
      .filter((source) => source.enabled)
      .map(
        (source) =>
          (options.resume &&
            tracker.run.sources.find(
              (entry) => entry.sourceId === source.id
            )) || {
            sourceId: source.id,
            name: source.account_name,
            status: 'pending',
            discovered: 0,
            completed: 0,
            newlyCompleted: 0,
            existingCompleted: 0,
            failed: 0,
            skipped: 0,
          }
      )
  await tracker.save()
  const repository =
    options.repository ?? (await SingleTableRepository.open(dataRoot))
  try {
    const results = await collectInStages({
      tracker,
      configRoot,
      settings: collectionSettings,
      resumeIncomplete: options.resume,
      resumeStartedAt: tracker.run.startedAt,
      runStartedAt: tracker.run.startedAt,
      repository,
      provider,
      gateway,
      sources,
      waitUntilRunnable: options.control
        ? () => options.control!.waitUntilRunnable()
        : undefined,
      promptsRoot: options.promptsRoot,
      profile: config.profile,
      profileVersion: String(config.profile.version),
      scoring: {
        weights: config.analysis.scoring.weights,
        coreThreshold: config.analysis.scoring.core_threshold,
        exploreThreshold: config.analysis.scoring.explore_threshold,
        coreMinLevels: config.analysis.scoring.core_min_levels,
        exploreMinLevels: config.analysis.scoring.explore_min_levels,
      },
      longContentMinChars: config.analysis.summarization.long_content_min_chars,
      translationMinimumTotalScore:
        config.analysis.translation.minimum_total_score,
      automaticTranslationLimits: {
        maximumVideoDurationSeconds:
          config.analysis.translation.automatic_video_max_duration_seconds,
        maximumSourceCharacters:
          config.analysis.translation.automatic_max_source_characters,
      },
      onError(source, item) {
        process.stderr.write(
          `Source ${source.id}, item ${item?.externalId ?? 'list'} failed; see content log if created.\n`
        )
      },
    })
    return results
  } finally {
    if (!options.repository) repository.close()
  }
}
