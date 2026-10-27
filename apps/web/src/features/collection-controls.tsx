import { useState } from 'react'
import { Pause, Play, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api, post } from '@/lib/api'

export interface CollectionRun {
  status: 'running' | 'paused' | 'completed' | 'failed' | 'interrupted'
  startedAt: string
  updatedAt: string
  endedAt?: string
  message?: string
  sources: Array<{
    sourceId: string
    name: string
    status: string
    discovered: number
    completed: number
    newlyCompleted?: number
    existingCompleted?: number
    failed: number
    skipped: number
  }>
}

export interface CollectionData {
  collection?: CollectionRun | null
  schedule?: {
    expression: string
    timezone?: string
    active: boolean
    error?: string
    lastAttempt?: { at: string; status: string; message?: string }
  }
  total?: number
  failed?: number
  waiting?: number
}

export function CollectionControls({
  data,
  onChanged,
}: {
  data: CollectionData
  onChanged: (data: CollectionData) => void
}) {
  const [pending, setPending] = useState<'start' | 'pause' | 'resume'>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const status = data.collection?.status

  async function run(action: 'start' | 'pause' | 'resume') {
    setPending(action)
    setError('')
    setNotice('')
    try {
      const result = await post<{ message: string }>(
        `/api/collection/${action}`,
        {}
      )
      setNotice(result.message)
      onChanged(await api<CollectionData>('/api/runtime'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败，请重试。')
    } finally {
      setPending(undefined)
    }
  }

  return (
    <div className='space-y-2' aria-live='polite'>
      <div className='flex flex-wrap gap-2'>
        <Button
          disabled={
            status === 'running' ||
            status === 'paused' ||
            status === 'interrupted' ||
            !!pending
          }
          onClick={() => void run('start')}
        >
          <Play className='size-4' />
          {pending === 'start' ? '正在启动…' : '手工采集'}
        </Button>
        {status === 'paused' || status === 'interrupted' ? (
          <Button
            variant='outline'
            disabled={!!pending}
            onClick={() => void run('resume')}
          >
            <RotateCcw className='size-4' />
            {pending === 'resume'
              ? '正在恢复…'
              : status === 'interrupted'
                ? '继续上轮采集'
                : '恢复采集'}
          </Button>
        ) : (
          <Button
            variant='outline'
            disabled={status !== 'running' || !!pending}
            onClick={() => void run('pause')}
          >
            <Pause className='size-4' />
            {pending === 'pause' ? '正在暂停…' : '暂停采集'}
          </Button>
        )}
      </div>
      {error && (
        <p role='alert' className='text-sm text-destructive'>
          {error}
        </p>
      )}
      {notice && <p className='text-sm'>{notice}</p>}
    </div>
  )
}
