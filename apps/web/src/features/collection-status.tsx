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
const phaseLabels = {
  scanning: '正在扫描并入库',
  analyzing: '扫描已完成，后台正在分析评分',
  translating: '评分已完成，正在翻译达标内容',
  finished: '本轮已结束',
}
const duration = (from?: string, to?: string) =>
  from && to
    ? `${Math.max(0, (Date.parse(to) - Date.parse(from)) / 60_000).toFixed(1)} 分钟`
    : '—'

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
              {run
                ? running && run.phase
                  ? phaseLabels[run.phase]
                  : labels[run.status]
                : '暂无采集任务记录'}
            </h2>
            <p className='mt-2 text-sm text-muted-foreground'>
              {current
                ? `${running ? '当前信源' : run?.status === 'paused' ? '暂停在信源' : '最后处理信源'}：${current.name}`
                : run
                  ? '本轮信源处理情况见下方列表'
                  : '执行采集后，将保留每轮进度和历史统计。'}
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
                {run.phase ? '扫描阶段已结束' : '已结束'} {done} / {total}{' '}
                个信源
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
                ...(run.phase
                  ? [
                      [
                        '新增入库',
                        run.sources.reduce(
                          (sum, source) => sum + (source.newlyInflow ?? 0),
                          0
                        ),
                      ] as const,
                    ]
                  : []),
                ...(hasBreakdown
                  ? ([
                      ['本轮新处理成功', totals?.newlyCompleted],
                      ['已处理过的条目', totals?.existingCompleted],
                    ] as const)
                  : ([['处理成功（含已有）', totals?.completed]] as const)),
                ['异常 / 待处理', totals?.failed],
                ['跳过已有或排除项', totals?.skipped],
                ...(run.phase
                  ? ([
                      ['翻译完成', run.translated ?? 0],
                      ['翻译失败', run.translationFailed ?? 0],
                    ] as const)
                  : []),
              ].map(([name, value]) => (
                <div key={name}>
                  <div className='text-sm text-muted-foreground'>{name}</div>
                  <div className='mt-2 text-2xl font-semibold'>{value}</div>
                </div>
              ))}
            </div>
            {hasBreakdown && (
              <p className='text-xs text-muted-foreground'>
                扫描量包含已有内容；新增入库不等于分析完成。整轮评分后，仅翻译达到所设分数的非垃圾外文内容。
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
            : '自动采集已关闭，仅在点击“手工采集”后执行。'}
        </p>
        <p className='mt-1 text-sm text-muted-foreground'>
          执行计划：
          {data.schedule?.expression === 'manual'
            ? '仅手动采集'
            : data.schedule?.timezone === 'Asia/Shanghai' &&
                /^\d+ \d+ \* \* \*$/u.test(data.schedule.expression)
              ? `每天北京时间 ${data.schedule.expression.split(' ')[1]!.padStart(2, '0')}:${data.schedule.expression.split(' ')[0]!.padStart(2, '0')}`
              : (data.schedule?.expression ?? '未配置')}
          {data.schedule?.active ? '。请保持电脑和服务运行。' : '。'}
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
                      {source.discoveryPending
                        ? '扫描待补齐'
                        : source.status === 'pending'
                          ? '等待执行'
                          : source.status === 'running'
                            ? running
                              ? '正在执行'
                              : '未完成'
                            : source.failed
                              ? '已结束，有异常'
                              : '已结束'}
                      {source.discoveryError && (
                        <p className='mt-1 text-xs text-destructive'>
                          {source.discoveryError}
                        </p>
                      )}
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
      {data.history && data.history.length > 0 && (
        <section className='space-y-3 border-t pt-5'>
          <h2 className='font-semibold'>采集历史</h2>
          <p className='text-sm text-muted-foreground'>
            每轮记录永久保存；此处显示最近100轮。费用为已知接口的标价估算，不含AI，未知单价及失败扣费另行核对。
          </p>
          <div className='overflow-x-auto'>
            <table className='w-full text-left text-sm'>
              <caption className='sr-only'>
                按北京时间显示的采集运行历史
              </caption>
              <thead>
                <tr>
                  {[
                    '开始时间',
                    '状态',
                    '扫描',
                    '新增入库',
                    '新处理成功',
                    '翻译完成 / 失败',
                    '扫描耗时',
                    '总耗时',
                    '接口费用估算',
                  ].map((label) => (
                    <th key={label} scope='col' className='p-3'>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.history.map((record) => (
                  <tr
                    key={record.id ?? record.startedAt}
                    className='hover:bg-foreground/[0.025]'
                  >
                    <td className='p-3 whitespace-nowrap'>
                      {time(record.startedAt)}
                    </td>
                    <td className='p-3'>
                      {record.sources.some((source) => source.discoveryPending)
                        ? '待补齐'
                        : labels[record.status]}
                    </td>
                    <td className='p-3'>
                      {record.sources.reduce(
                        (sum, source) => sum + source.discovered,
                        0
                      )}
                    </td>
                    <td className='p-3'>
                      {record.phase
                        ? record.sources.reduce(
                            (sum, source) => sum + (source.newlyInflow ?? 0),
                            0
                          )
                        : '—'}
                    </td>
                    <td className='p-3'>
                      {record.sources.reduce(
                        (sum, source) => sum + (source.newlyCompleted ?? 0),
                        0
                      )}
                    </td>
                    <td className='p-3'>
                      {record.translated ?? 0} / {record.translationFailed ?? 0}
                    </td>
                    <td className='p-3 whitespace-nowrap'>
                      {duration(
                        record.phaseStartedAt?.scanning,
                        record.scanningEndedAt
                      )}
                    </td>
                    <td className='p-3 whitespace-nowrap'>
                      {duration(record.startedAt, record.endedAt)}
                    </td>
                    <td className='p-3'>
                      {record.requests
                        ? `$${record.requests.estimatedCostUsd.toFixed(5)}${record.requests.unknownPriceCount ? '（部分待核价）' : ''}`
                        : '无调用计费记录'}
                    </td>
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
