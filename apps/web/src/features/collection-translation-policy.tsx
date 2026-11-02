import { useEffect, useState } from 'react'
import { api, put } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function CollectionTranslationPolicy() {
  const [score, setScore] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let disposed = false
    void api<{ minimumScore: number }>('/api/collection/translation-policy')
      .then((value) => {
        if (!disposed) {
          setScore(String(value.minimumScore))
          setLoaded(true)
        }
      })
      .catch(() => {
        if (!disposed) setError('翻译设置加载失败，请刷新重试。')
      })
    return () => {
      disposed = true
    }
  }, [])
  return (
    <section className='space-y-4 border-b pb-6 mb-6'>
      <div>
        <h2 className='text-lg font-semibold'>评分后翻译</h2>
        <p
          id='translation-policy-help'
          className='mt-2 text-sm text-muted-foreground'
        >
          整轮扫描和评分完成后，仅自动翻译非垃圾且总分达到门槛的外文内容，不要求属于推荐标签。修改后从下一轮采集生效。
        </p>
      </div>
      <form
        className='flex flex-wrap items-end gap-3'
        onSubmit={(event) => {
          event.preventDefault()
          const value = Number(score)
          if (
            score.trim() === '' ||
            !Number.isInteger(value) ||
            value < 0 ||
            value > 100
          ) {
            setError('请输入0至100之间的整数。')
            return
          }
          setError('')
          setNotice('')
          setBusy(true)
          void put('/api/collection/translation-policy', {
            minimumScore: value,
          })
            .then(() => setNotice('已保存，从下一轮采集生效。'))
            .catch((reason: unknown) =>
              setError(reason instanceof Error ? reason.message : '保存失败')
            )
            .finally(() => setBusy(false))
        }}
      >
        <div className='space-y-2'>
          <label
            htmlFor='translation-minimum-score'
            className='text-sm font-medium'
          >
            自动翻译最低分（含该分）
          </label>
          <Input
            id='translation-minimum-score'
            className='w-40'
            type='number'
            min={0}
            max={100}
            step={1}
            required
            value={score}
            disabled={!loaded || busy}
            aria-invalid={Boolean(error)}
            aria-describedby={`translation-policy-help${error ? ' translation-policy-error' : ''}`}
            onChange={(event) => {
              setScore(event.target.value)
              setError('')
              setNotice('')
            }}
          />
        </div>
        <Button type='submit' disabled={!loaded || busy}>
          {busy ? '正在保存…' : '保存翻译门槛'}
        </Button>
      </form>
      {error && (
        <p
          id='translation-policy-error'
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
