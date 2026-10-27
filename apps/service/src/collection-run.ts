import {
  mkdir,
  open,
  readFile,
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
  sources: Array<
    SourceRunResult & {
      name: string
      status: 'pending' | 'running' | 'completed'
      newlyCompleted?: number
      existingCompleted?: number
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
  const previous = resume ? await readCollectionRun(root) : null
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
  addCollectionRunEvent(run, {
    action:
      previous?.status === 'interrupted'
        ? 'collection-resumed'
        : 'collection-started',
    status: 'running',
    message: '开始执行本轮信源采集',
  })
  let pendingSave = Promise.resolve()
  function save() {
    const currentSave = pendingSave.then(async () => {
      run.updatedAt = new Date().toISOString()
      const temporary = `${file(root)}.${run.id}.tmp`
      await writeFile(temporary, JSON.stringify(run), 'utf8')
      await rename(temporary, file(root))
    })
    pendingSave = currentSave.catch(() => undefined)
    return currentSave
  }
  return { run, save, release: () => unlink(lock) }
}
