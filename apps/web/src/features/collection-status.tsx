import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { CollectionControls, type CollectionData } from './collection-controls'
import { ModelRetryControls } from './model-retry-controls'

export type { CollectionData } from './collection-controls'
const time = (value?: string) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      })
    : '—'
const labels = {
  running: '正在采集',
  paused: '采集已暂停',
  completed: '本轮已结束',
  failed: '本轮执行失败',
  interrupted: '本轮采集中断',
}

export function CollectionStatus({ initial }: { initial: CollectionData }) {
  const [data, setData] = useState(initial)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    let busy = false
    const timer = setInterval(() => {
      if (busy) return
      busy = true
      void api<CollectionData>('/api/runtime')
        .then((value) => {
          if (!disposed) {
            setData(value)
            setError('')
          }
        })
        .catch(() => {
          if (!disposed)
            setError('状态更新失败，显示的是上次结果，请检查服务连接。')
        })
        .finally(() => {
          busy = false
        })
    }, 3000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [])
  const run = data.collection
  const running = run?.status === 'running'
  const done =
    run?.sources.filter((source) => source.status === 'completed').length ?? 0
  const total = run?.sources.length ?? 0
  const current = run?.sources.find((source) => source.status === 'running')
  const totals = run?.sources.reduce(
    (sum, source) => ({
      discovered: sum.discovered + source.discovered,
      completed: sum.completed + source.completed,
      newlyCompleted: sum.newlyCompleted + (source.newlyCompleted ?? 0),
      existingCompleted:
        sum.existingCompleted + (source.existingCompleted ?? 0),
      failed: sum.failed + source.failed,
      skipped: sum.skipped + source.skipped,
    }),
    {
      discovered: 0,
      completed: 0,
      newlyCompleted: 0,
      existingCompleted: 0,
      failed: 0,
      skipped: 0,
    }
  )
  const hasBreakdown = run?.sources.every(
    (source) =>
      source.newlyCompleted !== undefined &&
      source.existingCompleted !== undefined
  )
  return (
    <div className='mx-auto max-w-6xl space-y-8'>
      <section className='space-y-4' aria-live='polite'>
        <div className='flex flex-wrap items-start justify-between gap-4'>
          <div>
            <h2 className='text-2xl font-semibold'>
              {run ? labels[run.status] : '暂无采集任务记录'}
            </h2>
            <p className='mt-2 text-sm text-muted-foreground'>
              {current
                ? `${running ? '当前信源' : run?.status === 'paused' ? '暂停在信源' : '最后处理信源'}：${current.name}`
                : run
                  ? '本轮信源处理情况见下方列表'
                  : '手工执行后，将记录本轮进度；历史任务无法还原。'}
            </p>
          </div>
          <CollectionControls data={data} onChanged={setData} />
        </div>
        <p className='text-sm text-muted-foreground'>
          执行所有已启用信源；已有内容不会重复分析。关闭页面后继续运行，电脑和服务需要保持运行。
        </p>
        {error && (
          <p role='alert' className='text-sm text-destructive'>
            {error}
          </p>
        )}
        {run?.message && (
          <div
            role={
              ['paused', 'interrupted'].includes(run.status) &&
              run.message.includes('模型调用失败')
                ? 'alert'
                : undefined
            }
            className={
              ['paused', 'interrupted'].includes(run.status) &&
              run.message.includes('模型调用失败')
                ? 'border border-destructive/40 bg-destructive/5 p-4 text-sm'
                : 'text-sm'
            }
          >
            <p>{run.message}</p>
            {['paused', 'interrupted'].includes(run.status) &&
              run.message.includes('模型调用失败') && (
                <a className='mt-2 inline-block underline' href='/?page=models'>
                  检查模型配置与连接测试
                </a>
              )}
          </div>
        )}
        {run && (
          <>
            <div className='flex justify-between text-sm'>
              <span>
                已结束 {done} / {total} 个信源
              </span>
              <span>剩余 {total - done} 个</span>
            </div>
            <progress
              className='h-2 w-full accent-primary'
              aria-label='信源处理进度'
              value={done}
              max={Math.max(total, 1)}
            />
            <p className='text-sm text-muted-foreground'>
              开始：{time(run.startedAt)} ·{' '}
              {run.endedAt
                ? `结束：${time(run.endedAt)}`
                : `最近进度：${time(run.updatedAt)}`}
              （北京时间）
            </p>
            <div className='grid grid-cols-2 gap-4 border-t pt-4 sm:grid-cols-5'>
              {[
                ['本轮扫描到（含已有）', totals?.discovered],
                ...(hasBreakdown
                  ? ([
                      ['本轮新处理成功', totals?.newlyCompleted],
                      ['已处理过的条目', totals?.existingCompleted],
                    ] as const)
                  : ([['处理成功（含已有）', totals?.completed]] as const)),
                ['异常 / 待处理', totals?.failed],
                ['跳过已有或排除项', totals?.skipped],
              ].map(([name, value]) => (
                <div key={name}>
                  <div className='text-sm text-muted-foreground'>{name}</div>
                  <div className='mt-2 text-2xl font-semibold'>{value}</div>
                </div>
              ))}
            </div>
            {hasBreakdown && (
              <p className='text-xs text-muted-foreground'>
                扫描到的是信源返回的条目数，包含以前采集的内容；本轮真正新增并处理成功的数量请看“本轮新处理成功”。
              </p>
            )}
            {!hasBreakdown && (
              <p className='text-xs text-muted-foreground'>
                这轮采集发生在升级前，无法拆分新处理和已有内容。
              </p>
            )}
          </>
        )}
      </section>
      <section className='border-t pt-5'>
        <h2 className='font-semibold'>自动执行</h2>
        <p className='mt-2 text-sm'>
          {data.schedule?.active
            ? '定时采集已启用，将自动执行所有已启用信源。'
            : '当前服务尚未启用定时调度，请使用“手工采集”。'}
        </p>
        <p className='mt-1 text-sm text-muted-foreground'>
          执行计划：
          {data.schedule?.timezone === 'Asia/Shanghai' &&
          /^\d+ \d+ \* \* \*$/u.test(data.schedule.expression)
            ? `每天北京时间 ${data.schedule.expression.split(' ')[1]!.padStart(2, '0')}:${data.schedule.expression.split(' ')[0]!.padStart(2, '0')}`
            : (data.schedule?.expression ?? '未配置')}
          。请保持电脑和服务运行。
        </p>
        {data.schedule?.error && (
          <p role='alert' className='mt-2 text-sm text-destructive'>
            {data.schedule.error}
          </p>
        )}
        {data.schedule?.lastAttempt && (
          <p className='mt-2 text-sm'>
            上次定时启动：
            {data.schedule.lastAttempt.status === 'started'
              ? '已启动'
              : data.schedule.lastAttempt.status === 'starting'
                ? '正在启动'
                : '启动失败'}
            。{data.schedule.lastAttempt.message}
          </p>
        )}
      </section>
      {run && (
        <section className='border-t pt-5'>
          <h2 className='mb-3 font-semibold'>本轮信源进度</h2>
          <div className='overflow-x-auto'>
            <table className='w-full text-left text-sm'>
              <thead className='text-muted-foreground'>
                <tr>
                  {['信源', '执行情况', '发现', '成功', '异常', '跳过'].map(
                    (label) => (
                      <th key={label} className='p-3'>
                        {label}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {run.sources.map((source) => (
                  <tr
                    key={source.sourceId}
                    className='hover:bg-foreground/[0.025]'
                  >
                    <td className='p-3'>{source.name}</td>
                    <td className='p-3'>
                      {source.status === 'pending'
                        ? '等待执行'
                        : source.status === 'running'
                          ? running
                            ? '正在执行'
                            : '未完成'
                          : source.failed
                            ? '已结束，有异常'
                            : '已结束'}
                    </td>
                    {[
                      source.discovered,
                      source.completed,
                      source.failed,
                      source.skipped,
                    ].map((value, index) => (
                      <td key={index} className='p-3'>
                        {value}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section className='border-t pt-5'>
        <h2 className='font-semibold'>累计内容概况</h2>
        <p className='mt-2 text-sm'>
          累计入库 {data.total ?? '—'} 条 · 失败 {data.failed ?? '—'} 条 ·
          等待人工转写 {data.waiting ?? '—'} 条
        </p>
        <p className='mt-1 text-sm text-muted-foreground'>
          查看正文请前往“全部内容”；处理失败和转写请前往“异常数据”。
        </p>
      </section>
      <ModelRetryControls />
    </div>
  )
}
