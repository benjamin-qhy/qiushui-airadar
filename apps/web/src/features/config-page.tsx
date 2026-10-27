import { useCallback, useEffect, useState } from 'react'
import { History, LockKeyhole, Save } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api, post, put } from '@/lib/api'
import type { SourceItem } from '@/types'

interface ConfigData {
  own: Record<string, unknown>
  effective: { ids: string[]; values: Record<string, unknown> }
  versions: {
    id: string
    description: string
    createdAt: string
    scope: unknown
    values: Record<string, unknown>
  }[]
  fixedRules: string[]
}
interface FileConfigData {
  mode: 'file'
  files: Array<{ name: string; content: string }>
}

export function ConfigPage() {
  const [data, setData] = useState<ConfigData>()
  const [fileData, setFileData] = useState<FileConfigData>()
  const [fileDrafts, setFileDrafts] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState('')
  const [preview, setPreview] = useState<{
    before: unknown
    after: unknown
    affectedSources: number
  }>()
  const [message, setMessage] = useState('')
  const [transcriptionEnabled, setTranscriptionEnabled] = useState(false)
  const [transcriptionBusy, setTranscriptionBusy] = useState(false)
  const [sources, setSources] = useState<SourceItem[]>([])
  const [scopeLevel, setScopeLevel] = useState<
    'global' | 'sourceType' | 'source'
  >('global')
  const [sourceType, setSourceType] = useState('x')
  const [sourceId, setSourceId] = useState('')
  const scope =
    scopeLevel === 'sourceType'
      ? { level: 'sourceType', sourceType }
      : scopeLevel === 'source'
        ? { level: 'source', sourceId: sourceId || sources[0]?.id }
        : { level: 'global' }
  const load = useCallback(() => {
    const query = new URLSearchParams({ level: scopeLevel })
    if (scopeLevel === 'sourceType') query.set('sourceType', sourceType)
    if (scopeLevel === 'source' && sourceId) query.set('sourceId', sourceId)
    return api<ConfigData | FileConfigData>(`/api/config?${query}`).then(
      (value) => {
        if ('files' in value) {
          setFileData(value)
          setFileDrafts(
            Object.fromEntries(
              value.files.map((file) => [file.name, file.content])
            )
          )
          return
        }
        setData(value)
        setDraft(JSON.stringify(value.own, null, 2))
      }
    )
  }, [scopeLevel, sourceId, sourceType])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    void api<{ enabled: boolean }>('/api/transcription')
      .then(({ enabled }) => setTranscriptionEnabled(enabled))
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    void api<{ items: SourceItem[] }>('/api/sources').then((value) => {
      setSources(value.items)
      setSourceId(value.items[0]?.id ?? '')
    })
  }, [])
  async function showPreview() {
    try {
      const values = JSON.parse(draft) as Record<string, unknown>
      setPreview(await post('/api/config/preview', { scope, values }))
    } catch {
      setMessage('配置不是有效的 JSON，请先检查格式。')
    }
  }
  async function save() {
    const values = JSON.parse(draft) as Record<string, unknown>
    await post('/api/config/versions', {
      scope,
      values,
      description: 'Web 配置变更',
    })
    setPreview(undefined)
    setMessage('新版本已保存并立即生效。')
    await load()
  }
  async function rollback(versionId: string) {
    await post('/api/config/rollback', { versionId })
    setMessage('已生成回退版本并立即生效。')
    await load()
  }
  if (fileData) {
    return (
      <div className='flex h-full min-h-0 flex-col'>
        <PageHeader
          title='系统配置'
          description='当前配置保存在新数据目录的 YAML 文件中；修改文件后重新运行采集即可生效'
        />
        <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-24 md:p-6 lg:pb-6'>
          <div className='mx-auto max-w-4xl space-y-6'>
            <section className='border-t pt-4'>
              <div className='flex items-center justify-between gap-4'>
                <div>
                  <label
                    htmlFor='auto-transcription'
                    className='text-sm font-medium'
                  >
                    自动音频转写
                  </label>
                  <p className='mt-1 text-sm text-muted-foreground'>
                    默认关闭。开启后，新采集的无字幕 X
                    视频会尝试在本机转写；失败时仍保留待处理状态。
                  </p>
                </div>
                <Switch
                  id='auto-transcription'
                  checked={transcriptionEnabled}
                  disabled={transcriptionBusy}
                  onCheckedChange={(enabled) => {
                    setTranscriptionBusy(true)
                    void put<{ enabled: boolean }>('/api/transcription', {
                      enabled,
                    })
                      .then((result) => {
                        setTranscriptionEnabled(result.enabled)
                        setMessage(
                          result.enabled
                            ? '自动音频转写已开启，从下次采集开始生效。'
                            : '自动音频转写已关闭。'
                        )
                        void load()
                      })
                      .catch((error) => setMessage(String(error)))
                      .finally(() => setTranscriptionBusy(false))
                  }}
                />
              </div>
            </section>
            {fileData.files.map((file) => (
              <section key={file.name} className='border-t pt-4'>
                <div className='flex items-center justify-between gap-3'>
                  <h2 className='font-mono text-sm font-medium'>{file.name}</h2>
                  <Button
                    size='sm'
                    onClick={() =>
                      void put<{ saved: string }>(
                        `/api/config/files/${encodeURIComponent(file.name)}`,
                        { content: fileDrafts[file.name] ?? '' }
                      )
                        .then(async () => {
                          setMessage(`${file.name} 已校验、保存并立即生效。`)
                          await load()
                        })
                        .catch((error) => setMessage(String(error)))
                    }
                  >
                    <Save />
                    校验并保存
                  </Button>
                </div>
                <Textarea
                  aria-label={`编辑 ${file.name}`}
                  value={fileDrafts[file.name] ?? ''}
                  onChange={(event) =>
                    setFileDrafts((current) => ({
                      ...current,
                      [file.name]: event.target.value,
                    }))
                  }
                  className='mt-3 min-h-72 font-mono text-xs leading-5'
                />
              </section>
            ))}
            {message && (
              <p className='border-l-2 border-foreground/30 bg-foreground/[0.025] p-3 text-sm'>
                {message}
              </p>
            )}
            <p className='text-sm text-muted-foreground'>
              保存前会检查 YAML 格式和字段规则；密钥请在“模型管理”中配置。
            </p>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className='flex h-full min-h-0 flex-col'>
      <PageHeader
        title='系统配置'
        description='先预览影响，再保存版本；敏感凭据不在这里显示'
      />
      <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-24 md:p-6 lg:pb-6'>
        <div className='mx-auto max-w-6xl'>
          {message && (
            <p className='mb-4 border-l-2 border-foreground/30 bg-foreground/[0.025] p-3 text-sm'>
              {message}
            </p>
          )}
          <Tabs defaultValue='parameters'>
            <TabsList>
              <TabsTrigger value='parameters'>参数配置</TabsTrigger>
              <TabsTrigger value='versions'>版本与回退</TabsTrigger>
              <TabsTrigger value='rules'>固定规则</TabsTrigger>
            </TabsList>
            <TabsContent value='parameters' className='mt-4'>
              <Card>
                <CardHeader>
                  <div className='flex flex-wrap items-center justify-between gap-3'>
                    <div>
                      <CardTitle>三层参数治理</CardTitle>
                      <p className='mt-1 text-sm text-muted-foreground'>
                        信源还可叠加平台类型、单个信源两层参数。
                      </p>
                    </div>
                    <Button onClick={() => void showPreview()}>
                      <Save />
                      预览并保存
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className='mb-4 grid gap-3 sm:grid-cols-3'>
                    <label className='text-sm'>
                      配置层级
                      <select
                        aria-label='配置层级'
                        value={scopeLevel}
                        onChange={(event) =>
                          setScopeLevel(event.target.value as typeof scopeLevel)
                        }
                        className='mt-1 h-9 w-full rounded-md border px-3'
                      >
                        <option value='global'>全局</option>
                        <option value='sourceType'>平台类型</option>
                        <option value='source'>单个信源</option>
                      </select>
                    </label>
                    {scopeLevel === 'sourceType' && (
                      <label className='text-sm'>
                        平台类型
                        <select
                          aria-label='平台类型'
                          value={sourceType}
                          onChange={(event) =>
                            setSourceType(event.target.value)
                          }
                          className='mt-1 h-9 w-full rounded-md border px-3'
                        >
                          <option value='x'>X</option>
                          <option value='youtube'>YouTube</option>
                          <option value='rss'>RSS</option>
                          <option value='douyin'>抖音</option>
                          <option value='wechat_channels'>微信视频号</option>
                          <option value='xiaohongshu'>小红书</option>
                        </select>
                      </label>
                    )}
                    {scopeLevel === 'source' && (
                      <label className='text-sm sm:col-span-2'>
                        具体信源
                        <select
                          aria-label='具体信源'
                          value={sourceId}
                          onChange={(event) => setSourceId(event.target.value)}
                          className='mt-1 h-9 w-full rounded-md border px-3'
                        >
                          {sources.map((source) => (
                            <option key={source.id} value={source.id}>
                              {source.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                  <Textarea
                    aria-label='全局参数 JSON'
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    className='min-h-[430px] font-mono text-xs'
                  />
                  <details className='mt-4 rounded-sm bg-foreground/[0.025] p-3'>
                    <summary className='cursor-pointer text-sm font-medium'>
                      查看三级合并后的当前生效值
                    </summary>
                    <pre className='mt-3 max-h-72 overflow-auto rounded-sm bg-code-surface p-4 text-xs text-code-foreground'>
                      {JSON.stringify(data?.effective.values ?? {}, null, 2)}
                    </pre>
                  </details>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value='versions' className='mt-4'>
              <div className='overflow-hidden rounded-sm border bg-card'>
                {data?.versions.map((version, index) => (
                  <div
                    key={version.id}
                    className='flex flex-wrap items-center justify-between gap-3 border-b p-4'
                  >
                    <div className='flex gap-3'>
                      <History className='mt-1 size-4 text-muted-foreground' />
                      <div>
                        <div className='font-medium'>{version.description}</div>
                        <div className='text-xs text-muted-foreground'>
                          {new Date(version.createdAt).toLocaleString('zh-CN')}{' '}
                          · {version.id.slice(0, 8)}
                        </div>
                      </div>
                    </div>
                    {index === 0 ? (
                      <Badge>当前版本</Badge>
                    ) : (
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => void rollback(version.id)}
                      >
                        回退到此版本
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </TabsContent>
            <TabsContent value='rules' className='mt-4'>
              <Card>
                <CardHeader>
                  <CardTitle className='flex items-center gap-2'>
                    <LockKeyhole />
                    不可修改的固定规则
                  </CardTitle>
                </CardHeader>
                <CardContent className='space-y-3'>
                  {data?.fixedRules.map((rule, index) => (
                    <div
                      key={rule}
                      className='flex items-center gap-3 border-l bg-foreground/[0.025] p-3 text-sm'
                    >
                      <Badge variant='outline'>{index + 1}</Badge>
                      {rule}
                      <LockKeyhole className='ml-auto size-4 text-muted-foreground' />
                    </div>
                  ))}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(open) => !open && setPreview(undefined)}
      >
        <DialogContent className='sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>确认配置变更</DialogTitle>
            <DialogDescription>
              该版本将影响 {preview?.affectedSources ?? 0}{' '}
              个信源，保存后仍可回退。
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-3 sm:grid-cols-2'>
            <div>
              <div className='mb-1 text-xs text-muted-foreground'>变更前</div>
              <pre className='max-h-64 overflow-auto rounded-sm bg-foreground/[0.04] p-3 text-xs'>
                {JSON.stringify(preview?.before, null, 2)}
              </pre>
            </div>
            <div>
              <div className='mb-1 text-xs text-muted-foreground'>变更后</div>
              <pre className='max-h-64 overflow-auto rounded-sm bg-code-surface p-3 text-xs text-code-foreground'>
                {JSON.stringify(preview?.after, null, 2)}
              </pre>
            </div>
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setPreview(undefined)}>
              取消
            </Button>
            <Button onClick={() => void save()}>确认保存版本</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
