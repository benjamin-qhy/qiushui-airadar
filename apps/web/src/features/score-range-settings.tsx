import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, put } from '@/lib/api'
import type { ScoreRange } from '@/types'

export function ScoreRangeSettings({ onSaved }: { onSaved?: () => void }) {
  const [ranges, setRanges] = useState<ScoreRange[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void api<{ ranges: ScoreRange[] }>('/api/config/score-ranges')
      .then((data) => {
        if (!active) return
        setRanges(data.ranges)
        setLoaded(true)
      })
      .catch((reason) => {
        if (active) setError(`读取失败：${String(reason)}`)
      })
    return () => {
      active = false
    }
  }, [])

  function update(id: string, key: 'min' | 'max', value: string) {
    setRanges((current) =>
      current.map((range) =>
        range.id === id
          ? { ...range, [key]: value === '' ? NaN : Number(value) }
          : range
      )
    )
    setMessage('')
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await put<{ ranges: ScoreRange[] }>(
        '/api/config/score-ranges',
        { ranges }
      )
      setRanges(result.ranges)
      setMessage('分数区间已保存，返回列表即可选择。')
      onSaved?.()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby='score-range-heading' className='border-t pt-4'>
      <h2 id='score-range-heading' className='text-sm font-medium'>
        分数筛选区间
      </h2>
      <p className='mt-1 text-sm text-muted-foreground'>
        列表默认显示全部分数。可配置 0–100
        分的整数区间，包含两端，区间不能重叠；未评分内容可单独筛选。
      </p>
      <form onSubmit={(event) => void save(event)} className='mt-4 space-y-3'>
        <fieldset disabled={!loaded || busy} className='space-y-3'>
          {ranges.map((range, index) => (
            <div key={range.id} className='flex flex-wrap items-end gap-3'>
              <label className='space-y-1 text-xs'>
                <span>区间 {index + 1} 最低分</span>
                <Input
                  type='number'
                  required
                  min={0}
                  max={100}
                  step={1}
                  value={Number.isNaN(range.min) ? '' : range.min}
                  onChange={(event) =>
                    update(range.id, 'min', event.target.value)
                  }
                  className='w-28'
                />
              </label>
              <label className='space-y-1 text-xs'>
                <span>区间 {index + 1} 最高分</span>
                <Input
                  type='number'
                  required
                  min={range.min || 0}
                  max={100}
                  step={1}
                  value={Number.isNaN(range.max) ? '' : range.max}
                  onChange={(event) =>
                    update(range.id, 'max', event.target.value)
                  }
                  className='w-28'
                />
              </label>
              <Button
                type='button'
                variant='ghost'
                aria-label={`删除区间 ${index + 1}`}
                onClick={() => {
                  setRanges((current) =>
                    current.filter((item) => item.id !== range.id)
                  )
                  setMessage('')
                }}
              >
                删除
              </Button>
            </div>
          ))}
          <div className='flex gap-2'>
            <Button
              type='button'
              variant='outline'
              disabled={ranges.length >= 30}
              onClick={() => {
                setRanges((current) => [
                  ...current,
                  { id: crypto.randomUUID(), min: 0, max: 100 },
                ])
                setMessage('')
              }}
            >
              新增区间
            </Button>
            <Button type='submit'>{busy ? '正在保存…' : '保存分数区间'}</Button>
          </div>
        </fieldset>
        {!loaded && !error && (
          <p role='status' className='text-sm text-muted-foreground'>
            正在读取分数区间…
          </p>
        )}
        {message && (
          <p role='status' className='text-sm'>
            {message}
          </p>
        )}
        {error && (
          <p role='alert' className='text-sm text-destructive'>
            {error}
          </p>
        )}
      </form>
    </section>
  )
}
