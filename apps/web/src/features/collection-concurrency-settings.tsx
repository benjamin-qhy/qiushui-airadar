import { useEffect, useState } from 'react'
import { api, put } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const fields = [
  ['scan_concurrency', '同时扫描的博主数'],
  ['processing_concurrency', '同时分析的内容数'],
  ['translation_concurrency', '同时翻译的内容数'],
] as const
const rateField = ['requests_per_second', '采集接口每秒请求数'] as const
const allFields = [...fields, rateField] as const
type Field = (typeof allFields)[number][0]
type Settings = Record<Field, number>

export function CollectionConcurrencySettings() {
  const [values, setValues] = useState<Record<Field, string>>({
    scan_concurrency: '',
    processing_concurrency: '',
    translation_concurrency: '',
    requests_per_second: '',
  })
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [invalid, setInvalid] = useState<Field>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let disposed = false
    void api<Settings>('/api/collection/concurrency')
      .then((settings) => {
        if (disposed) return
        setValues({
          scan_concurrency: String(settings.scan_concurrency),
          processing_concurrency: String(settings.processing_concurrency),
          translation_concurrency: String(settings.translation_concurrency),
          requests_per_second: String(settings.requests_per_second),
        })
        setLoaded(true)
      })
      .catch(() => {
        if (!disposed) setError('并发设置加载失败，请刷新重试。')
      })
    return () => {
      disposed = true
    }
  }, [])
  return (
    <section className='mb-6 space-y-4 border-b pb-6'>
      <div>
        <h2 className='text-lg font-semibold'>并发数量</h2>
        <p
          id='collection-concurrency-help'
          className='mt-2 text-sm text-muted-foreground'
        >
          三项并发数分别设置，没有固定上限，仅填写正整数。每秒请求数控制采集接口的发送频率，可填正数。修改从下一轮采集生效；翻译仍在整轮评分结束后执行。
        </p>
      </div>
      <form
        aria-busy={!loaded || busy}
        className='space-y-4'
        onSubmit={(event) => {
          event.preventDefault()
          const settings = {} as Settings
          for (const [key, label] of allFields) {
            const value = Number(values[key])
            if (
              !Number.isFinite(value) ||
              value <= 0 ||
              (key !== 'requests_per_second' && !Number.isSafeInteger(value))
            ) {
              setInvalid(key)
              setError(
                `${label}须为${key === 'requests_per_second' ? '正数' : '正整数'}。`
              )
              setNotice('')
              return
            }
            settings[key] = value
          }
          setInvalid(undefined)
          setError('')
          setNotice('')
          setBusy(true)
          void put('/api/collection/concurrency', settings)
            .then(() => setNotice('已保存，从下一轮采集生效。'))
            .catch((reason: unknown) =>
              setError(reason instanceof Error ? reason.message : '保存失败')
            )
            .finally(() => setBusy(false))
        }}
      >
        <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
          {allFields.map(([key, label]) => (
            <div key={key} className='space-y-2'>
              <label
                htmlFor={`collection-${key}`}
                className='text-sm font-medium'
              >
                {label}
              </label>
              <Input
                id={`collection-${key}`}
                type='number'
                min={key === 'requests_per_second' ? undefined : 1}
                step={key === 'requests_per_second' ? 'any' : 1}
                required
                value={values[key]}
                disabled={!loaded || busy}
                aria-invalid={invalid === key}
                aria-describedby={`collection-concurrency-help${invalid === key ? ' collection-concurrency-error' : ''}`}
                onChange={(event) => {
                  setValues((current) => ({
                    ...current,
                    [key]: event.target.value,
                  }))
                  setInvalid(undefined)
                  setError('')
                  setNotice('')
                }}
              />
            </div>
          ))}
        </div>
        <Button type='submit' disabled={!loaded || busy}>
          {busy ? '正在保存…' : '保存并发设置'}
        </Button>
      </form>
      {!loaded && !error && (
        <p role='status' className='text-sm'>
          正在加载并发设置…
        </p>
      )}
      {error && (
        <p
          id='collection-concurrency-error'
          role='alert'
          className='text-sm text-destructive'
        >
          {error}
        </p>
      )}
      {notice && (
        <p role='status' className='text-sm'>
          {notice}
        </p>
      )}
    </section>
  )
}
