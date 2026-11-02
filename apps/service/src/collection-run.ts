import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SourceRunResult } from '@qiushui-airadar/pipeline'

export interface CollectionRun {
  id: string
  pid: number
  status: 'running' | 'paused' | 'completed' | 'failed' | 'interrupted'
  startedAt: string
  updatedAt: string
  endedAt?: string
  phase?: 'scanning' | 'analyzing' | 'translating' | 'finished'
  phaseStartedAt?: Partial<
    Record<'scanning' | 'analyzing' | 'translating', string>
  >
  scanningEndedAt?: string
  translated?: number
  translationFailed?: number
  requests?: {
    count: number
    durationMs: number
    estimatedCostUsd: number
    unknownPriceCount: number
  }
  sources: Array<
    SourceRunResult & {
      name: string
      status: 'pending' | 'running' | 'completed'
      newlyCompleted?: number
      existingCompleted?: number
      newlyInflow?: number
      duplicates?: number
      discoveryPending?: boolean
      discoveryError?: string
    }
  >
  message?: string
  events: CollectionRunEvent[]
}

export interface CollectionRunEvent {
  id: string
  timestamp: string
  action:
    | 'collection-started'
    | 'collection-paused'
    | 'collection-resumed'
    | 'source-started'
    | 'source-completed'
    | 'collection-completed'
    | 'collection-failed'
    | 'collection-interrupted'
  status: 'running' | 'paused' | 'succeeded' | 'failed'
  sourceId?: string
  sourceName?: string
  message: string
}

export function addCollectionRunEvent(
  run: CollectionRun,
  event: Omit<CollectionRunEvent, 'id' | 'timestamp'>
) {
  run.events ??= []
  run.events.push({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...event,
  })
}

const file = (root: string) => path.join(root, 'collection-run.json')
export async function readCollectionHistory(
  root: string
): Promise<CollectionRun[]> {
  const directory = path.join(root, 'collection-runs')
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const runs = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(
        async (name) =>
          JSON.parse(
            await readFile(path.join(directory, name), 'utf8')
          ) as CollectionRun
      )
  )
  return runs
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 100)
}

export function collectionHistorySummary(run: CollectionRun): CollectionRun {
  const sources = run.sources
  return {
    ...run,
    events: [],
    sources: [
      {
        sourceId: 'all',
        name: '全部信源',
        status: 'completed',
        discovered: sources.reduce((sum, source) => sum + source.discovered, 0),
        completed: sources.reduce((sum, source) => sum + source.completed, 0),
        failed: sources.reduce((sum, source) => sum + source.failed, 0),
        skipped: sources.reduce((sum, source) => sum + source.skipped, 0),
        newlyCompleted: sources.reduce(
          (sum, source) => sum + (source.newlyCompleted ?? 0),
          0
        ),
        newlyInflow: sources.reduce(
          (sum, source) => sum + (source.newlyInflow ?? 0),
          0
        ),
        discoveryPending: sources.some((source) => source.discoveryPending),
      },
    ],
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
export async function readCollectionRun(
  root: string
): Promise<CollectionRun | null> {
  try {
    const run = JSON.parse(await readFile(file(root), 'utf8')) as CollectionRun
    if (
      (run.status === 'running' || run.status === 'paused') &&
      !alive(run.pid)
    ) {
      run.status = 'interrupted'
      run.message = run.message?.includes('模型调用失败')
        ? `${run.message} 服务已重启，验证模型后点击“继续上轮采集”。`
        : '采集进程已退出，本轮未完成。点击“继续上轮采集”；已成功内容不会重复分析。'
    }
    return run
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function beginCollectionRun(root: string, resume = false) {
  await mkdir(root, { recursive: true })
  const lock = path.join(root, 'collection.lock')
  try {
    const pid = Number(await readFile(lock, 'utf8'))
    if (!Number.isInteger(pid) || pid < 1 || alive(pid))
      throw new Error('已有采集任务正在执行，请勿重复启动。')
    await unlink(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const handle = await open(lock, 'wx')
  await handle.writeFile(String(process.pid))
  await handle.close()
  const lastRun = await readCollectionRun(root)
  await mkdir(path.join(root, 'collection-runs'), { recursive: true })
  if (lastRun) {
    const archive = path.join(root, 'collection-runs', `${lastRun.id}.json`)
    const temporary = `${archive}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(lastRun), { mode: 0o600 })
    await rename(temporary, archive)
  }
  const previous = resume ? lastRun : null
  const run: CollectionRun =
    previous?.status === 'interrupted'
      ? {
          ...previous,
          pid: process.pid,
          status: 'running',
          endedAt: undefined,
          message: '服务已恢复，继续处理未完成的内容。',
        }
      : {
          id: randomUUID(),
          pid: process.pid,
          status: 'running',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sources: [],
          events: [],
        }
  if (resume) {
    try {
      const text = await readFile(
        path.join(root, 'collection-runs', `${run.id}-requests.jsonl`),
        'utf8'
      )
      if (text && !text.endsWith('\n'))
        await appendFile(
          path.join(root, 'collection-runs', `${run.id}-requests.jsonl`),
          '\n'
        )
      const totals = {
        count: 0,
        durationMs: 0,
        estimatedCostUsd: 0,
        unknownPriceCount: 0,
      }
      for (const line of text.split('\n').filter(Boolean)) {
        totals.count++
        try {
          const metric = JSON.parse(line) as {
            durationMs?: number
            estimatedCostUsd?: number
          }
          totals.durationMs += metric.durationMs ?? 0
          if (typeof metric.estimatedCostUsd === 'number')
            totals.estimatedCostUsd += metric.estimatedCostUsd
          else totals.unknownPriceCount++
        } catch {
          totals.unknownPriceCount++
        }
      }
      run.requests = totals
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  addCollectionRunEvent(run, {
    action:
      previous?.status === 'interrupted'
        ? 'collection-resumed'
        : 'collection-started',
    status: 'running',
    message: '开始执行本轮信源采集',
  })
  let pendingSave = Promise.resolve()
  await mkdir(path.join(root, 'collection-runs'), { recursive: true })
  function save() {
    const currentSave = pendingSave.then(async () => {
      run.updatedAt = new Date().toISOString()
      const temporary = `${file(root)}.${run.id}.tmp`
      await writeFile(temporary, JSON.stringify(run), 'utf8')
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temporary, file(root))
          break
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? ''
          if (
            process.platform !== 'win32' ||
            !['EPERM', 'EACCES', 'EBUSY'].includes(code) ||
            attempt >= 5
          )
            throw error
          await new Promise((resolve) =>
            setTimeout(resolve, 20 * (attempt + 1))
          )
        }
      }
      const archive = path.join(root, 'collection-runs', `${run.id}.json`)
      const archiveTemporary = `${archive}.tmp`
      await writeFile(archiveTemporary, JSON.stringify(run), { mode: 0o600 })
      await rename(archiveTemporary, archive)
    })
    pendingSave = currentSave.catch(() => undefined)
    return currentSave
  }
  return { run, save, release: () => unlink(lock) }
}
