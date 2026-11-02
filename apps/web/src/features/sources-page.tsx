import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  FlaskConical,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, post, put, remove } from '@/lib/api'
import type { ProviderItem, SourceItem } from '@/types'

const typeLabels: Record<string, string> = {
  x: 'X',
  youtube: 'YouTube',
  rss: 'RSS',
  douyin: '抖音',
  wechat_channels: '微信视频号',
  xiaohongshu: '小红书',
}
const healthLabels: Record<string, string> = {
  healthy: '健康',
  warning: '有告警',
  unavailable: '不可用',
  disabled: '已停用',
}

interface SourceDraft {
  id: string
  type: 'x' | 'youtube' | 'rss'
  name: string
  externalIdentity: string
  language: 'zh' | 'en'
  enabled: boolean
}

const emptySource: SourceDraft = {
  id: '',
  type: 'rss',
  name: '',
  externalIdentity: '',
  language: 'zh',
  enabled: true,
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function SourcesPage() {
  const [sources, setSources] = useState<SourceItem[]>()
  const [providers, setProviders] = useState<ProviderItem[]>()
  const [selected, setSelected] = useState<string>()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [message, setMessage] = useState('')
  const [messageKind, setMessageKind] = useState<'info' | 'error'>('info')
  const [sourceAction, setSourceAction] = useState<
    'testing' | 'status' | 'deleting' | ''
  >('')
  const [sourceDialog, setSourceDialog] = useState(false)
  const [dialogSaving, setDialogSaving] = useState(false)
  const [dialogError, setDialogError] = useState('')
  const [editingId, setEditingId] = useState<string>()
  const [draft, setDraft] = useState<SourceDraft>(emptySource)
  const load = () =>
    Promise.all([
      api<{ items: SourceItem[] }>('/api/sources'),
      api<{ items: ProviderItem[] }>('/api/providers'),
    ]).then(([a, b]) => {
      setSources(a.items)
      setProviders(b.items)
      setSelected((current) => current ?? a.items[0]?.id)
    })
  useEffect(() => {
    void load()
  }, [])
  const visible = useMemo(
    () =>
      (sources ?? []).filter(
        (source) =>
          (status === 'all' || source.status === status) &&
          `${source.name} ${source.externalIdentity}`
            .toLowerCase()
            .includes(query.toLowerCase())
      ),
    [sources, status, query]
  )
  const source = sources?.find((item) => item.id === selected)
  function openCreate() {
    setEditingId(undefined)
    setDraft(emptySource)
    setDialogError('')
    setSourceDialog(true)
  }
  function openEdit() {
    if (!source) return
    setEditingId(source.id)
    setDraft({
      id: source.id,
      type: source.type as SourceDraft['type'],
      name: source.name,
      externalIdentity: source.externalIdentity,
      language: source.language,
      enabled: source.status === 'enabled',
    })
    setDialogError('')
    setSourceDialog(true)
  }
  async function saveSource() {
    if (
      !draft.id.trim() ||
      !draft.name.trim() ||
      !draft.externalIdentity.trim()
    ) {
      setDialogError('请填写信源 ID、显示名称和账号或订阅地址。')
      return
    }
    setDialogSaving(true)
    setDialogError('')
    try {
      const body = draft
      const result = editingId
        ? await put<{ source: SourceItem }>(
            `/api/sources/${encodeURIComponent(editingId)}`,
            body
          )
        : await post<{ source: SourceItem }>('/api/sources', body)
      setSourceDialog(false)
      setSelected(result.source.id)
      setMessageKind('info')
      setMessage(editingId ? '信源已更新。' : '信源已新增。')
      await load()
    } catch (error) {
      setDialogError(errorMessage(error))
    } finally {
      setDialogSaving(false)
    }
  }
  async function deleteSource() {
    if (!source || !window.confirm(`确定删除信源「${source.name}」？`)) return
    setSourceAction('deleting')
    setMessageKind('info')
    setMessage('正在删除信源定义，已有内容不会被删除…')
    try {
      await remove(`/api/sources/${encodeURIComponent(source.id)}`)
      setSelected(undefined)
      setMessage('信源定义已删除，已有内容仍然保留。')
      await load()
    } catch (error) {
      setMessageKind('error')
      setMessage(errorMessage(error))
    } finally {
      setSourceAction('')
    }
  }
  async function changeStatus(next: SourceItem['status']) {
    if (!source) return
    setSourceAction('status')
    setMessageKind('info')
    setMessage(`正在${next === 'enabled' ? '启用' : '停用'}「${source.name}」…`)
    try {
      await post(`/api/sources/${encodeURIComponent(source.id)}/status`, {
        status: next,
      })
      setMessage(
        `已将「${source.name}」设为${next === 'enabled' ? '启用' : next === 'disabled' ? '停用' : '归档'}`
      )
      await load()
    } catch (error) {
      setMessageKind('error')
      setMessage(errorMessage(error))
    } finally {
      setSourceAction('')
    }
  }
  async function testFetch() {
    if (!source) return
    setSourceAction('testing')
    setMessageKind('info')
    setMessage('正在抓取少量预览，不会保存内容…')
    try {
      const data = await post<{
        providerId: string
        items: Array<{ title?: string }>
      }>(`/api/sources/${encodeURIComponent(source.id)}/test-fetch`, {
        execute: true,
      })
      const titles = data.items
        .map((item) => item.title)
        .filter(Boolean)
        .join('；')
      setMessage(
        `试抓成功（${data.providerId}，${data.items.length} 条）${titles ? `：${titles}` : ''}`
      )
    } catch (error) {
      setMessageKind('error')
      setMessage(errorMessage(error))
    } finally {
      setSourceAction('')
    }
  }
  return (
    <div className='flex h-full min-h-0 flex-col'>
      <PageHeader
        title='信源管理'
        description='管理采集信源、有效参数与运行状态'
      />
      <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-24 md:p-6 lg:pb-6'>
        <div className='mx-auto max-w-[1500px]'>
          <div className='grid w-full min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden rounded-sm border bg-card lg:min-h-[calc(100svh-9rem)] lg:grid-cols-[380px_minmax(0,1fr)]'>
            <section className='min-w-0 border-r'>
              <div className='space-y-3 border-b p-4'>
                <div className='flex items-start justify-between gap-3'>
                  <div>
                    <h2 className='font-semibold'>全部信源</h2>
                    <p className='text-xs text-muted-foreground'>
                      已配置 {sources?.length ?? 0} 个信源
                    </p>
                  </div>
                  <Button
                    size='sm'
                    disabled={Boolean(sourceAction)}
                    onClick={openCreate}
                  >
                    <Plus />
                    新增
                  </Button>
                </div>
                <div className='relative'>
                  <Search className='absolute left-3 top-2.5 size-4 text-muted-foreground' />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder='搜索信源'
                    className='pl-9'
                  />
                </div>
                <select
                  aria-label='信源状态'
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                  className='h-9 w-full rounded-md border px-3 text-sm'
                >
                  <option value='all'>全部状态</option>
                  <option value='enabled'>已启用</option>
                  <option value='disabled'>已停用</option>
                </select>
              </div>
              <div className='max-h-[calc(100svh-20rem)] overflow-y-auto'>
                {visible.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setSelected(item.id)
                      setMessage('')
                    }}
                    className={`w-full p-4 text-left hover:bg-foreground/[0.025] ${selected === item.id ? 'bg-foreground/[0.05]' : ''}`}
                  >
                    <div className='flex justify-between gap-2'>
                      <span className='font-medium'>
                        {item.name}
                        {item.metadata?.official && (
                          <Badge variant='outline' className='ml-2'>
                            官方账号
                          </Badge>
                        )}
                      </span>
                      <Badge
                        variant={
                          item.health === 'healthy' ? 'secondary' : 'outline'
                        }
                      >
                        {healthLabels[item.health]}
                      </Badge>
                    </div>
                    <p className='mt-1 truncate text-xs text-muted-foreground'>
                      {typeLabels[item.type] ?? item.type} ·{' '}
                      {item.externalIdentity}
                    </p>
                  </button>
                ))}
              </div>
            </section>
            <section className='min-w-0 border-t p-5 md:p-7 lg:border-t-0'>
              {source ? (
                <>
                  <div className='flex flex-wrap items-start justify-between gap-4'>
                    <div>
                      <Badge variant='outline'>
                        {typeLabels[source.type] ?? source.type}
                      </Badge>
                      <h2 className='mt-3 text-2xl font-semibold'>
                        {source.name}
                      </h2>
                      <p className='mt-1 text-sm text-muted-foreground'>
                        {source.externalIdentity}
                      </p>
                      <p className='mt-1 text-sm text-muted-foreground'>
                        内容语言：
                        {source.language === 'en' ? '英文' : '中文'}
                      </p>
                      {source.metadata && (
                        <div className='mt-3 space-y-2 text-sm text-muted-foreground'>
                          {source.metadata.official && (
                            <Badge variant='outline'>官方账号</Badge>
                          )}
                          <p>
                            分类：{source.metadata.category} ·{' '}
                            {source.metadata.secondaryCategory}
                          </p>
                          <p>账号类型：{source.metadata.accountType}</p>
                          <p>
                            面向受众：{source.metadata.audiences.join('、')}
                          </p>
                          <div className='flex flex-wrap gap-1'>
                            {source.metadata.tags.map((tag) => (
                              <Badge key={tag} variant='secondary'>
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    <div className='flex flex-wrap gap-2'>
                      <Button
                        variant='outline'
                        disabled={Boolean(sourceAction)}
                        onClick={() => void testFetch()}
                      >
                        {sourceAction === 'testing' ? (
                          <LoaderCircle className='animate-spin' />
                        ) : (
                          <FlaskConical />
                        )}
                        {sourceAction === 'testing' ? '正在试抓…' : '试抓预览'}
                      </Button>
                      <Button
                        variant='outline'
                        disabled={Boolean(sourceAction)}
                        onClick={openEdit}
                      >
                        <Pencil />
                        编辑
                      </Button>
                      <Button
                        variant='outline'
                        disabled={Boolean(sourceAction)}
                        onClick={() => void deleteSource()}
                      >
                        <Trash2 />
                        {sourceAction === 'deleting' ? '删除中…' : '删除'}
                      </Button>
                      <select
                        aria-label='修改信源状态'
                        value={source.status}
                        disabled={Boolean(sourceAction)}
                        onChange={(event) =>
                          void changeStatus(
                            event.target.value as SourceItem['status']
                          )
                        }
                        className='h-9 rounded-md border px-3 text-sm'
                      >
                        <option value='enabled'>启用</option>
                        <option value='disabled'>停用</option>
                      </select>
                    </div>
                  </div>
                  {message && (
                    <p
                      role={messageKind === 'error' ? 'alert' : 'status'}
                      aria-live='polite'
                      className={`mt-4 border-l-2 p-3 text-sm ${messageKind === 'error' ? 'border-destructive/60 text-destructive' : 'border-foreground/30 bg-foreground/[0.025]'}`}
                    >
                      {message}
                    </p>
                  )}
                  <Tabs defaultValue='overview' className='mt-6'>
                    <TabsList>
                      <TabsTrigger value='overview'>概览</TabsTrigger>
                      <TabsTrigger value='parameters'>有效参数</TabsTrigger>
                      <TabsTrigger value='provider'>供应商</TabsTrigger>
                      <TabsTrigger value='history'>版本记录</TabsTrigger>
                    </TabsList>
                    <TabsContent
                      value='overview'
                      className='mt-5 grid gap-0 border-y sm:grid-cols-3 sm:divide-x'
                    >
                      <Card className='gap-3 rounded-none border-0 bg-transparent py-5'>
                        <CardHeader className='px-4'>
                          <CardTitle className='text-sm'>运行健康</CardTitle>
                        </CardHeader>
                        <CardContent className='px-4'>
                          <div className='flex items-center gap-2 text-lg font-semibold'>
                            <Activity className='size-5 text-foreground' />
                            {healthLabels[source.health]}
                          </div>
                        </CardContent>
                      </Card>
                      <Card className='gap-3 rounded-none border-0 border-t bg-transparent py-5 sm:border-t-0'>
                        <CardHeader className='px-4'>
                          <CardTitle className='text-sm'>最近发现</CardTitle>
                        </CardHeader>
                        <CardContent className='px-4 text-2xl font-semibold'>
                          {source.latestAudit?.discovered ?? 0}
                        </CardContent>
                      </Card>
                      <Card className='gap-3 rounded-none border-0 border-t bg-transparent py-5 sm:border-t-0'>
                        <CardHeader className='px-4'>
                          <CardTitle className='text-sm'>成功 / 失败</CardTitle>
                        </CardHeader>
                        <CardContent className='px-4 text-2xl font-semibold'>
                          {source.latestAudit?.succeeded ?? 0} /{' '}
                          {source.latestAudit?.failed ?? 0}
                        </CardContent>
                      </Card>
                    </TabsContent>
                    <TabsContent value='parameters' className='mt-5'>
                      <p className='mb-3 text-sm text-muted-foreground'>
                        按 全局 → 平台类型 → 当前信源 三层合并后的实际参数。
                      </p>
                      <pre className='overflow-auto rounded-sm bg-code-surface p-5 text-xs text-code-foreground'>
                        {JSON.stringify(source.effectiveParameters, null, 2)}
                      </pre>
                    </TabsContent>
                    <TabsContent value='provider' className='mt-5'>
                      {(providers ?? [])
                        .filter((item) => item.sourceType === source.type)
                        .map((item) => (
                          <div
                            key={item.id}
                            className='mb-3 flex items-center justify-between border-l p-4'
                          >
                            <div>
                              <div className='font-medium'>{item.name}</div>
                              <div className='text-xs text-muted-foreground'>
                                优先级 {item.priority}
                              </div>
                            </div>
                            <Badge variant='outline'>
                              {item.secretStatus?.configured === false
                                ? '凭据未配置'
                                : '可用'}
                            </Badge>
                          </div>
                        ))}
                    </TabsContent>
                    <TabsContent
                      value='history'
                      className='mt-5 text-sm text-muted-foreground'
                    >
                      参数版本由“系统配置”统一保存与回退，信源身份和固定规则不可修改。
                    </TabsContent>
                  </Tabs>
                </>
              ) : (
                <div className='grid h-full place-items-center text-muted-foreground'>
                  选择一个信源查看详情
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
      <Dialog
        open={sourceDialog}
        onOpenChange={(open) => {
          if (!dialogSaving) setSourceDialog(open)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? '编辑信源' : '新增信源'}</DialogTitle>
          </DialogHeader>
          <div className='grid gap-4'>
            <label className='text-sm'>
              信源 ID
              <Input
                value={draft.id}
                disabled={Boolean(editingId) || dialogSaving}
                onChange={(event) =>
                  setDraft({ ...draft, id: event.target.value })
                }
                placeholder='例如 rss_example'
              />
            </label>
            <label className='text-sm'>
              平台
              <select
                value={draft.type}
                disabled={dialogSaving}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    type: event.target.value as SourceDraft['type'],
                  })
                }
                className='mt-1 h-9 w-full rounded-md border px-3'
              >
                <option value='x'>X</option>
                <option value='youtube'>YouTube</option>
                <option value='rss'>RSS</option>
              </select>
            </label>
            <label className='text-sm'>
              显示名称
              <Input
                value={draft.name}
                disabled={dialogSaving}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
                placeholder='例如 OpenAI News'
              />
            </label>
            <label className='text-sm'>
              账号或订阅地址
              <Input
                value={draft.externalIdentity}
                disabled={dialogSaving}
                onChange={(event) =>
                  setDraft({ ...draft, externalIdentity: event.target.value })
                }
                placeholder={
                  draft.type === 'rss'
                    ? 'https://example.com/feed.xml'
                    : '账号名或频道地址'
                }
              />
            </label>
            <div>
              <label className='text-sm'>
                内容语言
                <select
                  value={draft.language}
                  disabled={dialogSaving}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      language: event.target.value as 'zh' | 'en',
                    })
                  }
                  className='mt-1 h-9 w-full rounded-md border px-3'
                >
                  <option value='zh'>中文</option>
                  <option value='en'>英文</option>
                </select>
              </label>
            </div>
            <label className='flex items-center gap-2 text-sm'>
              <input
                type='checkbox'
                checked={draft.enabled}
                disabled={dialogSaving}
                onChange={(event) =>
                  setDraft({ ...draft, enabled: event.target.checked })
                }
              />
              保存后立即启用
            </label>
          </div>
          {dialogError && (
            <p role='alert' className='text-sm text-destructive'>
              {dialogError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant='outline'
              disabled={dialogSaving}
              onClick={() => setSourceDialog(false)}
            >
              取消
            </Button>
            <Button disabled={dialogSaving} onClick={() => void saveSource()}>
              {dialogSaving && <LoaderCircle className='animate-spin' />}
              {dialogSaving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
