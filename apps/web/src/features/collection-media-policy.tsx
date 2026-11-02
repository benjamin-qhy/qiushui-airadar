import { useEffect, useState } from 'react'
import { api, put } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

export function CollectionMediaPolicy() {
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let disposed = false
    void api<{ enabled: boolean }>('/api/collection/media-policy')
      .then((value) => {
        if (!disposed) {
          setEnabled(value.enabled)
          setLoaded(true)
        }
      })
      .catch(() => {
        if (!disposed) setError('视频与语音设置加载失败，请刷新重试。')
      })
    return () => {
      disposed = true
    }
  }, [])
  return (
    <section className='mb-6 space-y-4 border-b pb-6'>
      <div>
        <h2 className='text-lg font-semibold'>视频与语音</h2>
        <p
          id='media-policy-help'
          className='mt-2 text-sm text-muted-foreground'
        >
          默认不处理视频和语音。关闭时，视频、语音及对应整条帖子归入“未处理”，保留原始信息和跳过原因，不抓正文、字幕，不分析或翻译。已有分析结果保留；开启后不会自动重新处理历史记录。
        </p>
      </div>
      <form
        className='flex flex-wrap items-center gap-3'
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          setError('')
          setNotice('')
          void put<{ excluded: number }>('/api/collection/media-policy', {
            enabled,
          })
            .then((result) =>
              setNotice(
                `已保存${result.excluded ? `，已归类 ${result.excluded} 条内容到未处理` : ''}。`
              )
            )
            .catch((reason) =>
              setError(reason instanceof Error ? reason.message : '保存失败')
            )
            .finally(() => setBusy(false))
        }}
      >
        <Switch
          id='process-media'
          checked={enabled}
          disabled={!loaded || busy}
          onCheckedChange={(value) => {
            setEnabled(value)
            setNotice('')
          }}
          aria-describedby='media-policy-help'
        />
        <label htmlFor='process-media' className='text-sm font-medium'>
          处理视频、语音及对应帖子
        </label>
        <Button type='submit' disabled={!loaded || busy}>
          {busy ? '正在保存…' : '保存视频与语音设置'}
        </Button>
      </form>
      {error && (
        <p role='alert' className='text-sm text-destructive'>
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
