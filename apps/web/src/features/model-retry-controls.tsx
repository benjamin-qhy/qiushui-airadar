import { useEffect, useState } from 'react'
import { api, post } from '@/lib/api'
import { Button } from '@/components/ui/button'

interface Batch {
  status: 'running' | 'paused' | 'completed' | 'canceled'
  ids: string[]
  cursor: number
  succeeded: number
  failed: number
  message?: string
}

export function ModelRetryControls() {
  const [preview, setPreview] = useState<{
    count: number
    estimatedModelCalls: number
  }>()
  const [batch, setBatch] = useState<Batch | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const refresh = () => {
      void Promise.all([
        api<{ count: number; estimatedModelCalls: number }>(
          '/api/model-retry/preview'
        ),
        api<{ batch: Batch | null }>('/api/model-retry'),
      ])
        .then(([nextPreview, nextBatch]) => {
          setPreview(nextPreview)
          setBatch(nextBatch.batch)
          setError('')
        })
        .catch(() => setError('批量重试状态读取失败。'))
    }
    refresh()
    const timer = setInterval(refresh, 3000)
    return () => clearInterval(timer)
  }, [])
  async function act(action: 'start' | 'pause' | 'resume' | 'cancel') {
    setBusy(true)
    setError('')
    try {
      const result = await post<{ batch: Batch }>(
        `/api/model-retry/${action}`,
        {}
      )
      setBatch(result.batch)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className='border-t pt-5' aria-live='polite'>
      <h2 className='font-semibold'>历史模型失败重试</h2>
      <p className='mt-2 text-sm text-muted-foreground'>
        可重试 {preview?.count ?? '—'} 条，预计约{' '}
        {preview?.estimatedModelCalls ?? '—'} 次模型调用。
        仅处理模型错误；字幕和正文抓取错误不在此列。
      </p>
      {batch && (
        <p className='mt-2 text-sm'>
          任务：
          {batch.status === 'running'
            ? '运行中'
            : batch.status === 'paused'
              ? '已暂停'
              : batch.status === 'completed'
                ? '已完成'
                : '已取消'}
          ；已处理 {batch.cursor}/{batch.ids.length}，成功 {batch.succeeded}
          ，失败 {batch.failed}。{batch.message}
        </p>
      )}
      <div className='mt-3 flex flex-wrap gap-2'>
        {(!batch || ['completed', 'canceled'].includes(batch.status)) && (
          <Button
            disabled={busy || !preview?.count}
            onClick={() => void act('start')}
          >
            开始批量重试
          </Button>
        )}
        {batch?.status === 'running' && (
          <Button
            variant='outline'
            disabled={busy}
            onClick={() => void act('pause')}
          >
            暂停
          </Button>
        )}
        {batch?.status === 'paused' && (
          <Button
            variant='outline'
            disabled={busy}
            onClick={() => void act('resume')}
          >
            验证模型并继续
          </Button>
        )}
        {batch && ['running', 'paused'].includes(batch.status) && (
          <Button
            variant='ghost'
            disabled={busy}
            onClick={() => void act('cancel')}
          >
            取消
          </Button>
        )}
      </div>
      {error && (
        <p role='alert' className='mt-2 text-sm text-destructive'>
          {error}
        </p>
      )}
      <a
        className='mt-3 inline-block text-sm underline'
        href='/?page=exceptions'
      >
        查看异常数据
      </a>
    </section>
  )
}
