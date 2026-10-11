import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react'
import ReactMarkdown from 'react-markdown'
import Masonry from 'react-responsive-masonry'
import remarkGfm from 'remark-gfm'
import {
  ArrowDownWideNarrow,
  Bookmark,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  Eye,
  ExternalLink,
  FileText,
  Heart,
  Image as ImageIcon,
  LayoutGrid,
  Languages,
  MessageCircle,
  PlayCircle,
  RotateCcw,
  Search,
  Share2,
  SlidersHorizontal,
  Star,
  TableProperties,
  Trash2,
  X,
} from 'lucide-react'
import type { DateRange } from 'react-day-picker'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Calendar } from '@/components/ui/calendar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { Sidebar, SidebarContent, SidebarHeader } from '@/components/ui/sidebar'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api, post } from '@/lib/api'
import {
  filterContentItems,
  filterContentScope,
  type ContentFilters,
  type ContentScope,
} from '@/lib/content-filters'
import type { FeedItem, UtilizationAction } from '@/types'

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Continue with the browser fallback when clipboard permission is denied.
    }
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

function CopyButton({
  text,
  label,
  className = '',
}: {
  text: string
  label: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  async function copy(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation()
    await copyText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return (
    <Button
      type='button'
      variant='ghost'
      size='icon'
      className={`size-8 ${className}`}
      aria-label={copied ? '已复制' : label}
      title={copied ? '已复制' : label}
      onClick={(event) => void copy(event)}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  )
}

function listTitle(item: FeedItem): string {
  if (item.chineseTitle) return item.chineseTitle
  return item.kind === 'short_post' &&
    item.source?.type === 'x' &&
    item.chineseTranslation
    ? item.chineseTranslation
    : item.title
}
const kindLabels: Record<NonNullable<FeedItem['kind']>, string> = {
  short_post: '短文',
  video: '视频',
  image_post: '图文',
  article: '文章',
}
const statusLabels: Record<FeedItem['processStatus'], string> = {
  processing: '处理中',
  completed: '已完成',
  failed: '失败',
  'waiting-manual-transcription': '待人工转写',
}
const formatLabels: Record<string, string> = {
  plain_text: '纯文本',
  markdown_article: 'Markdown 文章',
  subtitle: '视频字幕',
}
const stageLabels: Record<string, string> = {
  discovered: '已发现',
  enriching: '获取正文',
  classifying: '总结与判定',
  scoring: '分析与评分',
  translating: '中文意译',
  completed: '已完成',
  failed: '失败',
  'waiting-manual-transcription': '待人工转写',
}
const sourceTypeLabels: Record<string, string> = {
  x: 'X',
  youtube: 'YouTube',
  rss: 'RSS',
  douyin: '抖音',
  wechat_channels: '视频号',
  xiaohongshu: '小红书',
}

type ContentViewMode = 'masonry' | 'table'
type ContentCardWidth = 'small' | 'medium' | 'large'

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return ''
  return new Intl.NumberFormat('zh-CN', {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value)
}

function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

function contentCover(item: FeedItem): string | undefined {
  return item.images?.[0]?.url ?? item.video?.thumbnailUrl
}

function cardContent(item: FeedItem): string {
  if (item.kind === 'short_post' || item.kind === 'image_post')
    return item.chineseTranslation || item.body || item.summary || '暂无正文'
  return item.summary || '暂无 AI 总结'
}

function CardBody({ item }: { item: FeedItem }) {
  const content = cardContent(item)
  if (item.kind === 'short_post' || item.kind === 'image_post' || !item.summary)
    return <p className='whitespace-pre-wrap'>{content}</p>
  return (
    <div className='space-y-1 break-words [&_a]:underline [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_ul]:list-disc'>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
}

function KindIcon({ kind }: { kind: FeedItem['kind'] }) {
  return kind === 'video' ? (
    <PlayCircle aria-hidden='true' />
  ) : kind === 'image_post' ? (
    <ImageIcon aria-hidden='true' />
  ) : (
    <FileText aria-hidden='true' />
  )
}

function Metric({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: number | null | undefined
  icon: typeof Eye
}) {
  if (value === null || value === undefined || value <= 0) return null
  return (
    <span className='inline-flex items-center gap-1' title={label}>
      <Icon className='size-3.5' aria-hidden='true' />
      <span>{formatCount(value)}</span>
      <span className='sr-only'>{label}</span>
    </span>
  )
}

function scoreParts(value: unknown): { level: string; reason?: string } {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    return {
      level:
        typeof record.level === 'number'
          ? `${record.level} / 5`
          : String(record.level ?? '-'),
      reason: typeof record.reason === 'string' ? record.reason : undefined,
    }
  }
  return { level: String(value) }
}

const scoreLabels: Record<string, string> = {
  interestFit: '兴趣匹配',
  concreteGain: '具体收获',
  substance: '内容扎实度',
  newInformation: '新信息',
}

function scoreLabel(item: FeedItem): string {
  if (item.totalScore !== null) return `${item.totalScore} 分`
  if (item.junk.isJunk) return '不参与评分'
  if (item.processStatus !== 'completed')
    return statusLabels[item.processStatus]
  return '评分缺失'
}

interface ContentLogEntry {
  index: number
  timestamp: string
  action: string
  status: string
  stage?: string
  trigger?: string
  duration?: string
  retryCount?: string
  processor?: string
  prompt?: string
  error?: string
  request?: string
  response?: string
}

function LogEntry({
  contentId,
  entry,
}: {
  contentId: string
  entry: ContentLogEntry
}) {
  const [detail, setDetail] = useState<ContentLogEntry>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  async function loadDetail() {
    if (detail || loading) return
    setLoading(true)
    try {
      const result = await api<{ item: ContentLogEntry }>(
        `/api/contents/${encodeURIComponent(contentId)}/logs?entry=${entry.index}`
      )
      setDetail(result.item)
    } catch (reason) {
      setError(String(reason))
    } finally {
      setLoading(false)
    }
  }
  return (
    <details
      className='border-t py-3'
      onToggle={(event) => {
        if (event.currentTarget.open) void loadDetail()
      }}
    >
      <summary className='cursor-pointer text-sm'>
        <span className='font-medium'>{entry.action}</span>
        <span className='ml-2 text-muted-foreground'>
          {entry.status === 'succeeded' ? '成功' : '失败'} ·{' '}
          {new Date(entry.timestamp).toLocaleString('zh-CN')}
        </span>
        {entry.error && (
          <span className='mt-1 block text-destructive'>{entry.error}</span>
        )}
      </summary>
      <dl className='mt-3 grid gap-2 text-xs sm:grid-cols-2'>
        <div>阶段：{entry.stage ?? '—'}</div>
        <div>触发：{entry.trigger ?? '—'}</div>
        <div>耗时：{entry.duration ?? '—'}</div>
        <div>重试：{entry.retryCount ?? '—'}</div>
        {entry.processor && <div>处理器：{entry.processor}</div>}
        {entry.prompt && <div>提示词：{entry.prompt}</div>}
      </dl>
      {loading && (
        <p className='mt-3 text-xs text-muted-foreground'>
          正在读取请求与响应…
        </p>
      )}
      {error && (
        <p className='mt-3 text-xs text-destructive'>读取失败：{error}</p>
      )}
      {detail && (
        <div className='mt-3 space-y-2'>
          <details>
            <summary className='cursor-pointer text-xs'>request</summary>
            <pre className='mt-2 max-h-80 overflow-auto rounded-sm bg-foreground/[0.025] p-3 text-xs whitespace-pre-wrap break-all'>
              {detail.request ?? '无'}
            </pre>
          </details>
          <details>
            <summary className='cursor-pointer text-xs'>response</summary>
            <pre className='mt-2 max-h-80 overflow-auto rounded-sm bg-foreground/[0.025] p-3 text-xs whitespace-pre-wrap break-all'>
              {detail.response ?? '无'}
            </pre>
          </details>
        </div>
      )}
    </details>
  )
}

function LogPanel({ contentId }: { contentId: string }) {
  const [entries, setEntries] = useState<ContentLogEntry[]>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void api<{ items: ContentLogEntry[] }>(
      `/api/contents/${encodeURIComponent(contentId)}/logs`
    )
      .then((result) => {
        if (active) setEntries(result.items)
      })
      .catch((reason) => {
        if (active) setError(String(reason))
      })
    return () => {
      active = false
    }
  }, [contentId])
  if (error)
    return <p className='text-sm text-destructive'>日志读取失败：{error}</p>
  if (!entries)
    return <p className='text-sm text-muted-foreground'>正在读取日志…</p>
  if (!entries.length)
    return <p className='text-sm text-muted-foreground'>暂无执行日志</p>
  return (
    <div>
      {entries.map((entry) => (
        <LogEntry key={entry.index} contentId={contentId} entry={entry} />
      ))}
    </div>
  )
}

function useMobile() {
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    const media = matchMedia('(max-width: 1023px)')
    const update = () => setMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return mobile
}

function FilterDropdown({
  value,
  onChange,
  options,
  label,
  icon: Icon,
}: {
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
  label: string
  icon?: typeof CalendarDays
}) {
  const selectedLabel =
    options.find((option) => option.value === value)?.label ?? label
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant='outline'
          size='sm'
          className='h-8 max-w-28 gap-1.5 px-2.5 text-xs font-normal shadow-none'
          aria-label={label}
        >
          {Icon && <Icon className='size-3.5 shrink-0' />}
          <span className='truncate'>{selectedLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start' className='min-w-36'>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              className='text-xs'
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function parseLocalDate(value: string): Date | undefined {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return undefined
  return new Date(year, month - 1, day)
}

function formatLocalDate(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

export function ContentCard({
  item,
  selected,
  onOpen,
  onFavorite,
  compact = false,
}: {
  item: FeedItem
  selected?: boolean
  onOpen?: () => void
  onFavorite?: () => void
  compact?: boolean
}) {
  const cover = contentCover(item)
  const duration = formatDuration(item.video?.durationSeconds)
  const metrics = item.interaction
  return (
    <HoverCard openDelay={350} closeDelay={150}>
      <HoverCardTrigger asChild>
        <article
          tabIndex={0}
          className={`group relative flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-sm border bg-card p-3 outline-none transition-colors hover:bg-foreground/[0.025] focus-visible:ring-2 focus-visible:ring-ring ${compact ? 'min-h-28' : ''} ${selected ? 'bg-foreground/[0.045]' : ''}`}
          onClick={onOpen}
          onKeyDown={(event) => {
            if (
              event.target === event.currentTarget &&
              (event.key === 'Enter' || event.key === ' ') &&
              onOpen
            ) {
              event.preventDefault()
              onOpen()
            }
          }}
        >
          <CopyButton
            text={cardContent(item)}
            label='复制内容'
            className='absolute right-2 top-2 z-10 bg-background/90 opacity-100 shadow-none transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100'
          />
          <div className='mb-2 flex min-w-0 shrink-0 items-start gap-2'>
            <div className='min-w-0 flex-1 pr-8'>
              <div className='flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground'>
                {cover ? (
                  <img
                    src={cover}
                    alt=''
                    className='size-6 shrink-0 rounded-sm object-cover'
                  />
                ) : (
                  <span className='flex size-6 shrink-0 items-center justify-center rounded-sm bg-muted [&>svg]:size-3.5'>
                    <KindIcon kind={item.kind} />
                  </span>
                )}
                <span className='truncate'>
                  {item.source?.name ?? '未知信源'}
                </span>
                <span aria-hidden='true'>·</span>
                <span className='shrink-0 font-semibold text-foreground'>
                  {scoreLabel(item)}
                </span>
                {!item.read && (
                  <span
                    className='size-2 shrink-0 rounded-full bg-live'
                    title='未读'
                  />
                )}
              </div>
            </div>
          </div>
          {item.kind !== 'short_post' && item.title && (
            <h2 className='mb-1 line-clamp-2 shrink-0 text-sm font-semibold leading-5 text-foreground'>
              {listTitle(item)}
            </h2>
          )}
          {duration && (
            <span className='mb-1 shrink-0 text-[11px] text-muted-foreground'>
              {duration}
            </span>
          )}
          <div className='max-h-48 overflow-hidden text-xs leading-5 text-foreground/85'>
            <CardBody item={item} />
          </div>
          <div className='mt-auto shrink-0 pt-2'>
            <div className='flex items-center justify-between gap-2 pt-2 text-[11px] text-muted-foreground'>
              <div className='flex min-w-0 items-center gap-2.5'>
                {item.publishedAt && (
                  <span className='shrink-0'>
                    {new Date(item.publishedAt).toLocaleDateString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                    })}
                  </span>
                )}
                {!compact && (
                  <>
                    <Metric label='浏览' value={metrics?.views} icon={Eye} />
                    <Metric label='点赞' value={metrics?.likes} icon={Heart} />
                    <Metric
                      label='评论'
                      value={metrics?.comments}
                      icon={MessageCircle}
                    />
                  </>
                )}
              </div>
              <div className='flex shrink-0 items-center gap-1'>
                {onFavorite && (
                  <Button
                    variant='ghost'
                    size='icon'
                    className='size-8'
                    aria-label={
                      item.utilizationActions.includes('favorite')
                        ? '取消收藏'
                        : '收藏'
                    }
                    title={
                      item.utilizationActions.includes('favorite')
                        ? '取消收藏'
                        : '收藏'
                    }
                    disabled={item.junk.isJunk}
                    onClick={(event) => {
                      event.stopPropagation()
                      onFavorite()
                    }}
                  >
                    <Bookmark
                      className={
                        item.utilizationActions.includes('favorite')
                          ? 'fill-current'
                          : ''
                      }
                    />
                  </Button>
                )}
                {item.url && (
                  <Button
                    asChild
                    variant='ghost'
                    size='icon'
                    className='size-8'
                    onClick={(event) => event.stopPropagation()}
                  >
                    <a
                      href={item.url}
                      target='_blank'
                      rel='noreferrer'
                      aria-label='打开原文'
                      title='打开原文'
                    >
                      <ExternalLink />
                    </a>
                  </Button>
                )}
              </div>
            </div>
            {item.junk.isJunk && (
              <Badge
                variant='destructive'
                className='mt-2 max-w-full whitespace-normal text-left'
              >
                垃圾内容 ·{' '}
                {item.junk.note ??
                  (item.junk.source === 'manual' ? '人工标记' : 'AI 判定')}
              </Badge>
            )}
            {item.processStatus !== 'completed' && (
              <Badge variant='outline' className='mt-2'>
                {statusLabels[item.processStatus]}
              </Badge>
            )}
          </div>
        </article>
      </HoverCardTrigger>
      <HoverCardContent
        side='right'
        align='start'
        className='max-h-[min(70vh,32rem)] overflow-y-auto'
      >
        {item.kind !== 'short_post' && item.title && (
          <h3 className='mb-2 text-sm font-semibold leading-5'>
            {listTitle(item)}
          </h3>
        )}
        <div className='text-sm leading-6'>
          <CardBody item={item} />
        </div>
        <div className='mt-3 flex flex-wrap gap-1.5 border-t pt-3'>
          {item.topics.length ? (
            item.topics.map((topic) => (
              <Badge key={topic} variant='outline' className='font-normal'>
                {topic}
              </Badge>
            ))
          ) : (
            <span className='text-xs text-muted-foreground'>暂无标签</span>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

export function Detail({
  item,
  index,
  count,
  onClose,
  onMove,
  onChanged,
}: {
  item: FeedItem
  index: number
  count: number
  onClose: () => void
  onMove: (delta: number) => void
  onChanged: (item: FeedItem) => void
}) {
  const [junkOpen, setJunkOpen] = useState(false)
  const [reason, setReason] = useState('advertising')
  const [note, setNote] = useState('')
  const [operationMessage, setOperationMessage] = useState('')
  async function toggleAction(action: UtilizationAction) {
    const actions = item.utilizationActions.includes(action)
      ? item.utilizationActions.filter((value) => value !== action)
      : [...item.utilizationActions, action]
    await post(`/api/contents/${encodeURIComponent(item.id)}/actions`, {
      actions,
    })
    onChanged({ ...item, utilizationActions: actions })
  }
  async function markJunk(isJunk: boolean) {
    await post(
      `/api/contents/${encodeURIComponent(item.id)}/junk`,
      isJunk ? { isJunk: true, reason, note } : { isJunk: false }
    )
    onChanged({
      ...item,
      junk: {
        isJunk,
        source: 'manual',
        reason: isJunk ? reason : undefined,
        note: isJunk ? note : undefined,
      },
      utilizationActions: [],
    })
    setJunkOpen(false)
  }
  async function retry() {
    const result = await post<{ taskId: string }>(
      `/api/contents/${encodeURIComponent(item.id)}/retry`,
      {}
    )
    setOperationMessage(`恢复任务已进入队列：${result.taskId.slice(0, 8)}`)
  }
  async function translate() {
    const result = await post<{ taskId: string }>(
      `/api/contents/${encodeURIComponent(item.id)}/translate`,
      {}
    )
    onChanged({
      ...item,
      translationStatus: 'running',
      translationCompletedChunks: 0,
    })
    setOperationMessage(`翻译任务已开始：${result.taskId.slice(0, 8)}`)
  }
  const showHeaderMetadata =
    item.junk.isJunk ||
    item.originalStatus === 'deleted' ||
    item.originalStatus === 'private'
  const chineseBody =
    item.originalLanguage === 'zh' ? item.body : item.chineseTranslation
  const englishBody =
    item.originalLanguage === 'en' && item.hasEnglishBody !== false
      ? item.body
      : undefined
  const hasInteractionMetrics = [
    item.interaction?.views,
    item.interaction?.likes,
    item.interaction?.comments,
    item.interaction?.shares,
    item.interaction?.saves,
  ].some((value) => typeof value === 'number' && value > 0)
  const canTranslate =
    item.processStatus === 'completed' &&
    item.originalLanguage === 'en' &&
    item.hasEnglishBody !== false &&
    !item.translatedToChinese &&
    !item.junk.isJunk
  const translationRunning = item.translationStatus === 'running'
  const translationSkipMessage =
    item.translationSkipReason === 'video_duration_limit'
      ? '视频达到 30 分钟，已跳过自动翻译。'
      : item.translationSkipReason === 'source_character_limit'
        ? '内容字数达到半小时等价值，已跳过自动翻译。'
        : item.translationSkipReason === 'video_duration_unknown'
          ? '视频时长未知，已跳过自动翻译。'
          : item.translationSkipReason === 'below_score_threshold'
            ? '内容评分未达到自动翻译条件。'
            : undefined
  return (
    <Sidebar
      side='right'
      collapsible='none'
      aria-label='内容详情侧栏'
      className='h-full min-h-0 bg-background'
    >
      <Tabs
        key={item.id}
        defaultValue='summary'
        className='h-full min-h-0 gap-0'
      >
        <SidebarHeader className='gap-0 border-b p-0'>
          <div className='flex h-12 min-w-0 items-center gap-1 px-2'>
            <div className='flex shrink-0 items-center gap-1.5 pl-1'>
              <Badge>{scoreLabel(item)}</Badge>
              {item.kind && (
                <Badge variant='secondary'>{kindLabels[item.kind]}</Badge>
              )}
              <span
                className='max-w-32 truncate text-xs text-muted-foreground'
                title={item.source?.name ?? '未知信源'}
              >
                {item.source?.name ?? '未知信源'}
              </span>
            </div>
            <div className='no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto'>
              <Button
                variant={
                  item.utilizationActions.includes('favorite')
                    ? 'secondary'
                    : 'ghost'
                }
                size='icon'
                className='size-8'
                aria-label='收藏'
                aria-pressed={item.utilizationActions.includes('favorite')}
                title='收藏'
                disabled={item.junk.isJunk}
                onClick={() => void toggleAction('favorite')}
              >
                <Star
                  className={
                    item.utilizationActions.includes('favorite')
                      ? 'fill-current'
                      : ''
                  }
                />
              </Button>
              {item.junk.isJunk ? (
                <Button
                  variant='ghost'
                  size='icon'
                  className='size-8'
                  aria-label='撤销垃圾'
                  title='撤销垃圾'
                  onClick={() => void markJunk(false)}
                >
                  <RotateCcw />
                </Button>
              ) : (
                <Button
                  variant='ghost'
                  size='icon'
                  className='size-8 text-destructive hover:text-destructive'
                  aria-label='标记垃圾'
                  title='标记垃圾'
                  onClick={() => setJunkOpen(true)}
                >
                  <Trash2 />
                </Button>
              )}
              {canTranslate && (
                <Button
                  variant='ghost'
                  size='icon'
                  className='size-8'
                  aria-label='生成中文意译'
                  title='生成中文意译'
                  disabled={translationRunning}
                  onClick={() => void translate()}
                >
                  <Languages />
                </Button>
              )}
              {(item.processStatus !== 'completed' ||
                item.originalStatus === 'deleted' ||
                item.originalStatus === 'private') &&
                !canTranslate && (
                  <Button
                    variant='ghost'
                    size='icon'
                    className='size-8'
                    aria-label='单条恢复'
                    title='单条恢复'
                    onClick={() => void retry()}
                  >
                    <RotateCcw />
                  </Button>
                )}
              {item.url && (
                <Button asChild variant='ghost' size='icon' className='size-8'>
                  <a
                    href={item.url}
                    target='_blank'
                    rel='noreferrer'
                    aria-label='打开原文'
                    title='打开原文'
                  >
                    <ExternalLink />
                  </a>
                </Button>
              )}
            </div>
            <div className='ml-auto flex shrink-0 items-center gap-0.5 border-l pl-1'>
              <Button
                aria-label='上一篇'
                title='上一篇'
                variant='ghost'
                size='icon'
                className='size-8'
                disabled={index <= 0}
                onClick={() => onMove(-1)}
              >
                <ChevronLeft />
              </Button>
              <span className='min-w-9 text-center text-xs text-muted-foreground'>
                {index + 1}/{count}
              </span>
              <Button
                aria-label='下一篇'
                title='下一篇'
                variant='ghost'
                size='icon'
                className='size-8'
                disabled={index >= count - 1}
                onClick={() => onMove(1)}
              >
                <ChevronRight />
              </Button>
              <Button
                aria-label='关闭详情'
                title='关闭详情'
                variant='ghost'
                size='icon'
                className='size-8'
                onClick={onClose}
              >
                <X />
              </Button>
            </div>
          </div>
          <div className='px-5 pb-4 pt-4 md:px-6'>
            {showHeaderMetadata && (
              <div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
                <div className='flex flex-wrap items-center gap-2'>
                  {item.junk.isJunk && (
                    <Badge
                      variant='destructive'
                      className='whitespace-normal text-left'
                    >
                      垃圾内容{item.junk.note ? ` · ${item.junk.note}` : ''}
                    </Badge>
                  )}
                  {(item.originalStatus === 'deleted' ||
                    item.originalStatus === 'private') && (
                    <Badge variant='outline'>原文不可用</Badge>
                  )}
                </div>
              </div>
            )}
            <h2 className='line-clamp-2 text-xl font-semibold leading-tight'>
              {listTitle(item)}
            </h2>
            <div
              aria-label='互动与发布时间'
              className='mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground'
            >
              {!hasInteractionMetrics && <span>暂无互动数据</span>}
              <Metric label='浏览' value={item.interaction?.views} icon={Eye} />
              <Metric
                label='点赞'
                value={item.interaction?.likes}
                icon={Heart}
              />
              <Metric
                label='评论'
                value={item.interaction?.comments}
                icon={MessageCircle}
              />
              <Metric
                label='分享'
                value={item.interaction?.shares}
                icon={Share2}
              />
              <Metric
                label='收藏'
                value={item.interaction?.saves}
                icon={Bookmark}
              />
              <span className='whitespace-nowrap'>
                {item.publishedAt
                  ? new Date(item.publishedAt).toLocaleString('zh-CN')
                  : '发布时间未知'}
              </span>
            </div>
            {operationMessage && (
              <p className='mt-3 border-l-2 border-foreground/30 bg-foreground/[0.025] p-2 text-xs'>
                {operationMessage}
              </p>
            )}
          </div>
          <TabsList className='no-scrollbar h-10 w-full justify-start gap-4 overflow-x-auto px-5 md:px-6'>
            <TabsTrigger value='summary'>AI 总结</TabsTrigger>
            <TabsTrigger value='chinese'>中文</TabsTrigger>
            {englishBody && <TabsTrigger value='english'>英文</TabsTrigger>}
            <TabsTrigger value='properties'>属性</TabsTrigger>
            <TabsTrigger value='logs'>日志</TabsTrigger>
          </TabsList>
        </SidebarHeader>
        <SidebarContent className='px-5 py-5 md:px-6'>
          <div className='mx-auto max-w-3xl'>
            <TabsContent value='chinese' className='relative m-0 space-y-5'>
              {chineseBody && (
                <CopyButton
                  text={chineseBody}
                  label='复制中文内容'
                  className='absolute right-0 top-0 z-10 bg-background/90'
                />
              )}
              {item.images && item.images.length > 0 && (
                <div className='grid gap-2 sm:grid-cols-2'>
                  {item.images.map((image, imageIndex) => (
                    <a
                      key={`${image.url}-${imageIndex}`}
                      href={image.url}
                      target='_blank'
                      rel='noreferrer'
                      className={`overflow-hidden rounded-sm border bg-muted ${imageIndex === 0 ? 'sm:col-span-2' : ''}`}
                      title='查看原图'
                    >
                      <img
                        src={image.url}
                        alt={`内容配图 ${imageIndex + 1}`}
                        className={`w-full object-cover ${imageIndex === 0 ? 'max-h-[440px]' : 'aspect-video'}`}
                      />
                    </a>
                  ))}
                </div>
              )}
              {item.video?.thumbnailUrl && (
                <div className='relative overflow-hidden rounded-sm border bg-code-surface'>
                  <img
                    src={item.video.thumbnailUrl}
                    alt='视频封面'
                    className='aspect-video w-full object-cover opacity-90'
                  />
                  <PlayCircle className='absolute left-1/2 top-1/2 size-14 -translate-x-1/2 -translate-y-1/2 text-code-foreground' />
                </div>
              )}
              {chineseBody ? (
                <div className='space-y-3 whitespace-pre-wrap break-words leading-8 [&_a]:underline [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc'>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {chineseBody}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className='space-y-3'>
                  <p className='text-sm text-muted-foreground'>
                    {item.originalLanguage === 'en'
                      ? (translationSkipMessage ??
                        '未生成中文意译；中文 AI 总结可在“AI 总结”中查看。')
                      : '暂无中文正文'}
                  </p>
                  {canTranslate && (
                    <Button
                      variant='outline'
                      disabled={translationRunning}
                      onClick={() => void translate()}
                    >
                      <Languages />
                      {translationRunning
                        ? `正在翻译 ${item.translationCompletedChunks ?? 0}/${item.translationChunkCount ?? '?'}`
                        : item.translationStatus === 'failed'
                          ? '重新生成中文意译'
                          : '生成中文意译'}
                    </Button>
                  )}
                  {item.translationError && (
                    <p className='text-xs text-destructive'>
                      {item.translationError}
                    </p>
                  )}
                </div>
              )}
              {item.repostedBy && (
                <p className='text-sm text-muted-foreground'>
                  由{' '}
                  <a
                    className='underline underline-offset-2'
                    href={item.repostedBy.url}
                    target='_blank'
                    rel='noreferrer'
                  >
                    {item.repostedBy.name}
                  </a>{' '}
                  转发
                </p>
              )}
              {item.quotedPost && (
                <section
                  className='space-y-3 border-l-2 border-foreground/20 bg-foreground/[0.025] p-4'
                  aria-label='引用的帖子'
                >
                  <div className='text-sm'>
                    <span className='font-semibold'>
                      {item.quotedPost.authorName ??
                        item.quotedPost.authorHandle ??
                        'X 用户'}
                    </span>
                    {item.quotedPost.authorHandle && (
                      <span className='ml-2 text-muted-foreground'>
                        @{item.quotedPost.authorHandle}
                      </span>
                    )}
                    <span className='ml-2 text-muted-foreground'>
                      引用的帖子
                    </span>
                  </div>
                  {item.quotedPost.text && (
                    <p className='whitespace-pre-wrap leading-7'>
                      {item.quotedPost.text}
                    </p>
                  )}
                  {item.quotedPost.images.map((image, index) => (
                    <a
                      key={`${image.url}-${index}`}
                      href={image.url}
                      target='_blank'
                      rel='noreferrer'
                      className='block'
                      title='查看引用帖原图'
                    >
                      <img
                        src={image.url}
                        alt={`引用帖配图 ${index + 1}`}
                        className='max-h-[520px] w-full object-contain'
                      />
                    </a>
                  ))}
                  <a
                    href={item.quotedPost.url}
                    target='_blank'
                    rel='noreferrer'
                    className='inline-block text-sm underline underline-offset-2'
                  >
                    查看引用帖原文
                  </a>
                </section>
              )}
            </TabsContent>
            {englishBody && (
              <TabsContent value='english' className='relative m-0'>
                <CopyButton
                  text={englishBody}
                  label='复制英文内容'
                  className='absolute right-0 top-0 z-10 bg-background/90'
                />
                <div className='whitespace-pre-wrap break-words leading-8 [&_a]:underline [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc'>
                  {item.originalFormat === 'markdown_article' ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {englishBody}
                    </ReactMarkdown>
                  ) : (
                    englishBody
                  )}
                </div>
              </TabsContent>
            )}
            <TabsContent value='summary' className='relative m-0 space-y-6'>
              {item.summary && (
                <CopyButton
                  text={item.summary}
                  label='复制 AI 总结'
                  className='absolute right-0 top-0 z-10 bg-background/90'
                />
              )}
              <section>
                <h3 className='mb-2 text-sm font-semibold'>看完能获得什么</h3>
                <p className='leading-7'>
                  {item.valueSummary || '暂无价值分析'}
                </p>
              </section>
              <section aria-label='文章标签'>
                <h3 className='mb-2 text-sm font-semibold'>文章标签</h3>
                <div className='flex flex-wrap gap-1.5'>
                  {item.topics.length ? (
                    item.topics.map((topic) => (
                      <Badge
                        key={topic}
                        variant='outline'
                        className='font-normal'
                      >
                        {topic}
                      </Badge>
                    ))
                  ) : (
                    <span className='text-sm text-muted-foreground'>
                      暂无标签
                    </span>
                  )}
                </div>
              </section>
              <section>
                <h3 className='mb-2 text-sm font-semibold'>
                  {item.kind === 'short_post'
                    ? '帖子内容（未额外总结）'
                    : 'AI 总结'}
                </h3>
                {item.summary ? (
                  <div className='space-y-3 break-words leading-7 [&_a]:underline [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc'>
                    {item.kind === 'short_post' ? (
                      <p className='whitespace-pre-wrap'>{item.summary}</p>
                    ) : (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {item.summary}
                      </ReactMarkdown>
                    )}
                  </div>
                ) : (
                  <p className='text-sm text-muted-foreground'>暂无 AI 总结</p>
                )}
              </section>
              <section>
                <h3 className='mb-2 text-sm font-semibold'>评分</h3>
                <p className='mb-3 text-lg font-semibold'>{scoreLabel(item)}</p>
                <div className='grid gap-3 sm:grid-cols-2'>
                  {Object.entries(item.scores).map(([key, value]) => (
                    <div key={key} className='border-l px-3 py-2'>
                      <div className='text-xs text-muted-foreground'>
                        {scoreLabels[key] ?? key}
                      </div>
                      <div className='mt-1 font-semibold'>
                        {scoreParts(value).level}
                      </div>
                      {scoreParts(value).reason && (
                        <p className='mt-1 text-xs leading-5 text-muted-foreground'>
                          {scoreParts(value).reason}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            </TabsContent>
            <TabsContent value='properties' className='m-0'>
              <dl className='grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 [&_dt]:text-muted-foreground [&_dd]:mt-1 [&_dd]:break-words'>
                <div>
                  <dt>来源平台与账号</dt>
                  <dd>
                    {sourceTypeLabels[item.source?.type ?? ''] ??
                      item.source?.type ??
                      '未知'}{' '}
                    · {item.source?.name ?? '未知信源'}
                  </dd>
                </div>
                <div>
                  <dt>来源账号 ID</dt>
                  <dd className='font-mono text-xs'>
                    {item.source?.id ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt>内容 ID</dt>
                  <dd className='font-mono text-xs'>{item.id}</dd>
                </div>
                {item.externalContentId && (
                  <div>
                    <dt>平台内容 ID</dt>
                    <dd className='font-mono text-xs'>
                      {item.externalContentId}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>原文链接</dt>
                  <dd>
                    {item.url ? (
                      <a
                        href={item.url}
                        target='_blank'
                        rel='noreferrer'
                        className='underline underline-offset-2'
                      >
                        打开原文
                      </a>
                    ) : (
                      '无'
                    )}
                  </dd>
                </div>
                <div>
                  <dt>内容类型与格式</dt>
                  <dd>
                    {item.kind ? kindLabels[item.kind] : '未知'} ·{' '}
                    {formatLabels[item.originalFormat ?? ''] ?? '未知'}
                  </dd>
                </div>
                <div>
                  <dt>原文语言</dt>
                  <dd>
                    {item.originalLanguage === 'zh'
                      ? '中文'
                      : item.originalLanguage === 'en'
                        ? '英文'
                        : '待识别'}
                  </dd>
                </div>
                {(item.originalStatus === 'deleted' ||
                  item.originalStatus === 'private' ||
                  item.originalStatus === 'unavailable') && (
                  <div>
                    <dt>原文状态</dt>
                    <dd>
                      {item.originalStatus === 'deleted'
                        ? '已删除'
                        : item.originalStatus === 'private'
                          ? '不公开'
                          : '无法访问'}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>中文意译</dt>
                  <dd>
                    {item.originalLanguage === 'en'
                      ? item.translatedToChinese
                        ? '已生成'
                        : '未生成'
                      : '不适用'}
                  </dd>
                </div>
                <div>
                  <dt>关键词</dt>
                  <dd>{item.keywordsText || '无'}</dd>
                </div>
                <div>
                  <dt>推荐状态</dt>
                  <dd>
                    {item.recommendation === 'core'
                      ? '核心'
                      : item.recommendation === 'explore'
                        ? '探索'
                        : '不推荐'}
                  </dd>
                </div>
                <div>
                  <dt>垃圾判断</dt>
                  <dd>
                    {item.junk.isJunk
                      ? `是${item.junk.note ? ` · ${item.junk.note}` : item.junk.reason ? ` · ${item.junk.reason}` : ''}`
                      : '否'}
                  </dd>
                </div>
                <div>
                  <dt>处理状态</dt>
                  <dd>
                    {statusLabels[item.processStatus]} ·{' '}
                    {stageLabels[item.processStage ?? ''] ?? '未知阶段'}
                  </dd>
                </div>
                <div>
                  <dt>重试次数</dt>
                  <dd>{item.retryCount ?? 0}</dd>
                </div>
                <div>
                  <dt>发布时间</dt>
                  <dd>
                    {item.publishedAt
                      ? new Date(item.publishedAt).toLocaleString('zh-CN')
                      : '未知'}
                  </dd>
                </div>
                <div>
                  <dt>发现时间</dt>
                  <dd>
                    {item.discoveredAt
                      ? new Date(item.discoveredAt).toLocaleString('zh-CN')
                      : '未知'}
                  </dd>
                </div>
                <div>
                  <dt>首次入库</dt>
                  <dd>
                    {item.firstInflowAt
                      ? new Date(item.firstInflowAt).toLocaleString('zh-CN')
                      : '未知'}
                  </dd>
                </div>
                <div>
                  <dt>最近处理</dt>
                  <dd>
                    {item.lastProcessedAt
                      ? new Date(item.lastProcessedAt).toLocaleString('zh-CN')
                      : '未知'}
                  </dd>
                </div>
                <div>
                  <dt>阅读状态</dt>
                  <dd>{item.read ? '已读' : '未读'}</dd>
                </div>
                <div>
                  <dt>分析模型</dt>
                  <dd>
                    {item.analysis
                      ? `${item.analysis.provider} / ${item.analysis.model}`
                      : '尚未分析'}
                  </dd>
                </div>
                {item.analysis && (
                  <div>
                    <dt>评分规则</dt>
                    <dd>{item.analysis.ruleVersion}</dd>
                  </div>
                )}
                {item.video?.durationSeconds && (
                  <div>
                    <dt>视频时长</dt>
                    <dd>{formatDuration(item.video.durationSeconds)}</dd>
                  </div>
                )}
                {item.interaction?.capturedAt && (
                  <div>
                    <dt>互动数据采集时间</dt>
                    <dd>
                      {new Date(item.interaction.capturedAt).toLocaleString(
                        'zh-CN'
                      )}
                    </dd>
                  </div>
                )}
                {item.lastError && (
                  <div className='sm:col-span-2'>
                    <dt>最近错误</dt>
                    <dd className='text-destructive'>{item.lastError}</dd>
                  </div>
                )}
              </dl>
            </TabsContent>
            <TabsContent value='logs' className='m-0'>
              <LogPanel contentId={item.id} />
            </TabsContent>
          </div>
        </SidebarContent>
      </Tabs>
      <Dialog open={junkOpen} onOpenChange={setJunkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>标记为垃圾内容</DialogTitle>
            <DialogDescription>
              标记后会立即移出每日精选，并清空已有利用动作。
            </DialogDescription>
          </DialogHeader>
          <select
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className='h-10 rounded-md border px-3'
          >
            <option value='advertising'>广告</option>
            <option value='engagement-bait'>互动诱导</option>
            <option value='no-substance'>无实质内容</option>
            <option value='clickbait'>标题党</option>
            <option value='low-quality-copy'>低质搬运</option>
            <option value='incorrect'>信息错误</option>
            <option value='other'>其他</option>
          </select>
          <Textarea
            placeholder='备注（可选）'
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <DialogFooter>
            <Button variant='outline' onClick={() => setJunkOpen(false)}>
              取消
            </Button>
            <Button variant='destructive' onClick={() => void markJunk(true)}>
              确认标记
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sidebar>
  )
}

export function ContentWorkspace({ scope }: { scope: ContentScope }) {
  const storageKey = `qiushuiai-airadar:${scope}:filters`
  const viewStorageKey = 'qiushuiai-airadar:content:view'
  const title =
    scope === 'daily'
      ? '每日精选'
      : scope === 'exceptions'
        ? '异常数据'
        : scope === 'favorites'
          ? '我的收藏'
          : scope === 'junk'
            ? '垃圾内容'
            : '全部内容'
  const initial = () => {
    try {
      return typeof localStorage === 'undefined'
        ? null
        : (JSON.parse(
            localStorage.getItem(storageKey) ?? 'null'
          ) as ContentFilters | null)
    } catch {
      return null
    }
  }
  const [items, setItems] = useState<FeedItem[]>()
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string>()
  const [viewMode, setViewMode] = useState<ContentViewMode>(() => {
    if (typeof localStorage === 'undefined') return 'masonry'
    return localStorage.getItem(`${viewStorageKey}:mode`) === 'table'
      ? 'table'
      : 'masonry'
  })
  const [cardWidth, setCardWidth] = useState<ContentCardWidth>(() => {
    if (typeof localStorage === 'undefined') return 'medium'
    const saved = localStorage.getItem(`${viewStorageKey}:card-width`)
    return saved === 'small' || saved === 'large' ? saved : 'medium'
  })
  const [filters, setFilters] = useState<ContentFilters>(() => {
    const saved = initial()
    return {
      query: '',
      processStatus: 'all',
      recommendation: 'all',
      read: 'all',
      junk: scope === 'junk' ? 'junk' : 'clean',
      dateFrom: saved?.dateFrom ?? '',
      dateTo: saved?.dateTo ?? '',
      datePreset: saved?.datePreset ?? 'all',
      kind: 'all',
      sourceType: 'all',
      sort: scope === 'daily' ? 'score-desc' : 'newest',
      ...(saved ?? {}),
    }
  })
  const [customRange, setCustomRange] = useState<DateRange | undefined>(() => {
    const from = parseLocalDate(filters.dateFrom)
    const to = parseLocalDate(filters.dateTo)
    return from ? { from, to } : undefined
  })
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollPosition = useRef(0)
  const mobile = useMobile()
  const defaultLayout = useMemo(() => {
    try {
      return typeof localStorage === 'undefined'
        ? undefined
        : ((JSON.parse(
            localStorage.getItem('qiushuiai-airadar:content-layout') ?? 'null'
          ) as Record<string, number> | null) ?? undefined)
    } catch {
      return undefined
    }
  }, [])
  const load = useCallback(
    () =>
      api<{ items: FeedItem[] }>(
        filters.query.trim()
          ? `/api/contents?keyword=${encodeURIComponent(filters.query.trim())}`
          : '/api/contents'
      )
        .then((data) => {
          setItems(data.items)
          setError('')
        })
        .catch((reason) => setError(String(reason))),
    [filters.query]
  )
  const visible = useMemo(() => {
    const scoped = filterContentScope(items ?? [], scope)
    const filtered = filterContentItems(scoped, { ...filters, junk: 'all' })
    return [...filtered].sort((left, right) => {
      if (filters.sort === 'score-desc')
        return (right.totalScore ?? -1) - (left.totalScore ?? -1)
      const leftTime =
        Date.parse(left.publishedAt ?? left.discoveredAt ?? '') || 0
      const rightTime =
        Date.parse(right.publishedAt ?? right.discoveredAt ?? '') || 0
      return filters.sort === 'oldest'
        ? leftTime - rightTime
        : rightTime - leftTime
    })
  }, [items, filters, scope])
  const index = visible.findIndex((item) => item.id === selected)
  const selectedItem = visible[index]
  function open(item: FeedItem, rememberScroll = true) {
    if (rememberScroll) {
      scrollPosition.current = scrollRef.current?.scrollTop ?? 0
    }
    setSelected(item.id)
    if (!item.read) {
      void post(`/api/contents/${encodeURIComponent(item.id)}/read`, {
        read: true,
      })
      setItems((current) =>
        current?.map((value) =>
          value.id === item.id ? { ...value, read: true } : value
        )
      )
    }
  }
  function close() {
    setSelected(undefined)
    requestAnimationFrame(() =>
      scrollRef.current?.scrollTo({ top: scrollPosition.current })
    )
  }
  function move(delta: number) {
    const next = visible[index + delta]
    if (next) open(next, false)
  }
  function changed(item: FeedItem) {
    setItems((current) =>
      current?.map((value) => (value.id === item.id ? item : value))
    )
    if (!filterContentScope([item], scope).length) {
      setSelected(undefined)
    }
  }
  async function toggleFavorite(item: FeedItem) {
    const actions = item.utilizationActions.includes('favorite')
      ? item.utilizationActions.filter((value) => value !== 'favorite')
      : [...item.utilizationActions, 'favorite' as const]
    await post(`/api/contents/${encodeURIComponent(item.id)}/actions`, {
      actions,
    })
    changed({ ...item, utilizationActions: actions })
  }
  const setFilter = (key: keyof ContentFilters, value: string) =>
    setFilters((current) => ({ ...current, [key]: value }))
  const setDatePreset = (preset: string, days?: number) => {
    if (!days) {
      setFilters((current) => ({
        ...current,
        datePreset: preset,
        dateFrom: '',
        dateTo: '',
      }))
      setCustomRange(undefined)
      return
    }
    const to = new Date()
    const from = new Date(to)
    from.setDate(from.getDate() - days + 1)
    setFilters((current) => ({
      ...current,
      datePreset: preset,
      dateFrom: formatLocalDate(from),
      dateTo: formatLocalDate(to),
    }))
    setCustomRange({ from, to })
  }
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (typeof localStorage !== 'undefined')
      localStorage.setItem(storageKey, JSON.stringify(filters))
  }, [filters, storageKey])
  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(`${viewStorageKey}:mode`, viewMode)
    localStorage.setItem(`${viewStorageKey}:card-width`, cardWidth)
  }, [cardWidth, viewMode, viewStorageKey])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelected(undefined)
        return
      }
      const delta =
        event.key === 'j' || event.key === 'ArrowDown'
          ? 1
          : event.key === 'k' || event.key === 'ArrowUp'
            ? -1
            : 0
      if (selected && delta) {
        const next = visible[index + delta]
        if (next) open(next)
      }
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [index, selected, visible])
  const renderCard = (item: FeedItem) => (
    <ContentCard
      key={item.id}
      item={item}
      selected={selected === item.id}
      compact={Boolean(selectedItem)}
      onOpen={() => open(item)}
      onFavorite={() => void toggleFavorite(item)}
    />
  )
  const cardWidthOptions: Array<{
    value: ContentCardWidth
    label: string
    pixels: number
  }> = [
    { value: 'small', label: '小卡片', pixels: 132 },
    { value: 'medium', label: '中卡片', pixels: 224 },
    { value: 'large', label: '大卡片', pixels: 288 },
  ]
  const selectedCardWidth =
    cardWidthOptions.find((option) => option.value === cardWidth) ??
    cardWidthOptions[1]
  const [masonryColumns, setMasonryColumns] = useState(3)
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const updateColumns = () => {
      const availableWidth = container.clientWidth - 32 // p-4 on both sides
      const gap = 12 // gap-3
      setMasonryColumns(
        Math.max(
          1,
          Math.floor(
            (availableWidth + gap) / (selectedCardWidth.pixels + gap)
          )
        )
      )
    }
    updateColumns()
    const observer = new ResizeObserver(updateColumns)
    observer.observe(container)
    return () => observer.disconnect()
  }, [selectedCardWidth.pixels])
  const renderMasonry = (group: FeedItem[]) => (
    <div data-view='masonry' className='w-full'>
      <Masonry columnsCount={masonryColumns} gutter='12px' sequential>
        {group.map((item) => (
          <div key={item.id}>{renderCard(item)}</div>
        ))}
      </Masonry>
    </div>
  )
  const renderTable = (group: FeedItem[]) => (
    <div
      data-view='table'
      className='overflow-hidden rounded-sm border bg-card'
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>内容</TableHead>
            <TableHead>平台</TableHead>
            <TableHead>类型</TableHead>
            <TableHead className='text-right'>评分</TableHead>
            <TableHead>推荐</TableHead>
            <TableHead>日期</TableHead>
            <TableHead className='w-20 text-right'>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {group.map((item) => (
            <TableRow
              key={item.id}
              tabIndex={0}
              data-state={selected === item.id ? 'selected' : undefined}
              className='cursor-pointer'
              onClick={() => open(item)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  open(item)
                }
              }}
            >
              <TableCell className='max-w-80 whitespace-normal'>
                <div className='line-clamp-1 font-medium'>
                  {listTitle(item)}
                </div>
                <div className='line-clamp-1 text-xs text-muted-foreground'>
                  {item.junk.isJunk && item.junk.note
                    ? `垃圾原因：${item.junk.note}`
                    : item.chineseTranslation || item.summary || '暂无摘要'}
                </div>
              </TableCell>
              <TableCell>
                {sourceTypeLabels[item.source?.type ?? ''] ??
                  item.source?.type ??
                  '未知'}
              </TableCell>
              <TableCell>
                {item.kind ? kindLabels[item.kind] : '未知'}
              </TableCell>
              <TableCell className='text-right font-medium'>
                {scoreLabel(item)}
              </TableCell>
              <TableCell>
                <Badge
                  variant={
                    item.recommendation === 'core' ? 'default' : 'secondary'
                  }
                >
                  {item.recommendation === 'core'
                    ? '核心'
                    : item.recommendation === 'explore'
                      ? '探索'
                      : '普通'}
                </Badge>
              </TableCell>
              <TableCell>
                {item.publishedAt
                  ? new Date(item.publishedAt).toLocaleDateString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                    })
                  : '未知'}
              </TableCell>
              <TableCell>
                <div className='flex justify-end gap-1'>
                  <Button
                    variant='ghost'
                    size='icon'
                    className='size-8'
                    aria-label={
                      item.utilizationActions.includes('favorite')
                        ? '取消收藏'
                        : '收藏'
                    }
                    disabled={item.junk.isJunk}
                    onClick={(event) => {
                      event.stopPropagation()
                      void toggleFavorite(item)
                    }}
                  >
                    <Bookmark
                      className={
                        item.utilizationActions.includes('favorite')
                          ? 'fill-current'
                          : ''
                      }
                    />
                  </Button>
                  {item.url && (
                    <Button
                      asChild
                      variant='ghost'
                      size='icon'
                      className='size-8'
                      onClick={(event) => event.stopPropagation()}
                    >
                      <a
                        href={item.url}
                        target='_blank'
                        rel='noreferrer'
                        aria-label='打开原文'
                      >
                        <ExternalLink />
                      </a>
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
  const kindFilters: Array<{ value: string; label: string }> = [
    { value: 'all', label: '全部' },
    { value: 'video', label: '视频' },
    { value: 'image_post', label: '图文' },
    { value: 'article', label: '文章' },
    { value: 'short_post', label: '短帖' },
  ]
  const recommendationFilters: Array<{ value: string; label: string }> = [
    { value: 'all', label: '全部推荐' },
    { value: 'core', label: '核心' },
    { value: 'explore', label: '探索' },
    { value: 'none', label: '普通' },
  ]
  const sourceOptions = [
    { value: 'all', label: '全部平台' },
    { value: 'x', label: 'X' },
    { value: 'youtube', label: 'YouTube' },
    { value: 'rss', label: 'RSS' },
    { value: 'douyin', label: '抖音' },
    { value: 'wechat_channels', label: '视频号' },
    { value: 'xiaohongshu', label: '小红书' },
  ]
  const processOptions = [
    { value: 'all', label: '全部状态' },
    ...Object.entries(statusLabels).map(([value, label]) => ({ value, label })),
    { value: 'original-unavailable', label: '原文不可用' },
  ]
  const advancedFilterActive =
    filters.processStatus !== 'all' || filters.read !== 'all'
  const datePresets = [
    { value: 'week', label: '近一周', days: 7 },
    { value: 'month', label: '近一个月', days: 30 },
    { value: 'quarter', label: '近三个月', days: 90 },
    { value: 'half-year', label: '近半年', days: 180 },
  ]
  const dateLabel =
    filters.datePreset === 'custom' && filters.dateFrom && filters.dateTo
      ? `${filters.dateFrom.slice(5)}–${filters.dateTo.slice(5)}`
      : (datePresets.find((preset) => preset.value === filters.datePreset)
          ?.label ?? '日期')
  const list = (
    <div className='flex h-full w-full min-w-0 max-w-[100vw] flex-col overflow-hidden bg-background'>
      <PageHeader title={title} description={`${visible.length} 条真实内容`}>
        <div className='relative w-full min-w-28 sm:w-auto sm:flex-1 sm:basis-36 sm:max-w-[168px]'>
          <Search className='pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground' />
          <Input
            value={filters.query}
            onChange={(event) => setFilter('query', event.target.value)}
            placeholder='搜索内容'
            className='h-8 pl-8 text-xs shadow-none'
          />
        </div>

        <ButtonGroup aria-label='内容搜索与筛选' className='shrink-0'>
          <FilterDropdown
            label='内容类型'
            value={filters.kind ?? 'all'}
            onChange={(value) => setFilter('kind', value)}
            options={kindFilters.map((filter) => ({
              ...filter,
              label: filter.value === 'all' ? '全部类型' : filter.label,
            }))}
          />

          <FilterDropdown
            label='推荐等级'
            value={filters.recommendation}
            onChange={(value) => setFilter('recommendation', value)}
            options={recommendationFilters}
          />

          <FilterDropdown
            label='评分'
            value={filters.sort ?? 'newest'}
            onChange={(value) => setFilter('sort', value)}
            icon={ArrowDownWideNarrow}
            options={[
              { value: 'score-desc', label: '评分最高' },
              { value: 'newest', label: '最新发布' },
              { value: 'oldest', label: '最早发布' },
            ]}
          />

          <FilterDropdown
            label='平台'
            value={filters.sourceType ?? 'all'}
            onChange={(value) => setFilter('sourceType', value)}
            options={sourceOptions}
          />

          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant='outline'
                size='sm'
                className='h-8 max-w-32 gap-1.5 px-2.5 text-xs font-normal shadow-none'
                aria-label='日期范围'
              >
                <CalendarDays className='size-3.5 shrink-0' />
                <span className='truncate'>{dateLabel}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end' className='w-40'>
              <DropdownMenuLabel className='text-xs'>
                日期范围
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className='text-xs'
                onSelect={() => setDatePreset('all')}
              >
                不限时间
                {filters.datePreset === 'all' && (
                  <Check className='ml-auto size-3' />
                )}
              </DropdownMenuItem>
              {datePresets.map((preset) => (
                <DropdownMenuItem
                  key={preset.value}
                  className='text-xs'
                  onSelect={() => setDatePreset(preset.value, preset.days)}
                >
                  {preset.label}
                  {filters.datePreset === preset.value && (
                    <Check className='ml-auto size-3' />
                  )}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className='text-xs'>
                  自定义
                  {filters.datePreset === 'custom' && (
                    <Check className='ml-auto mr-2 size-3' />
                  )}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className='w-auto p-0'>
                  <Calendar
                    mode='range'
                    selected={customRange}
                    onSelect={(value) => {
                      setCustomRange(value)
                      if (value?.from && value.to) {
                        setFilters((current) => ({
                          ...current,
                          datePreset: 'custom',
                          dateFrom: formatLocalDate(value.from!),
                          dateTo: formatLocalDate(value.to!),
                        }))
                      }
                    }}
                    numberOfMonths={2}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant={advancedFilterActive ? 'secondary' : 'outline'}
                size='sm'
                className='h-8 gap-1.5 px-2.5 text-xs font-normal shadow-none'
                aria-label='更多筛选'
              >
                <SlidersHorizontal className='size-3.5' />
                筛选
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end' className='w-44'>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className='text-xs'>
                  处理状态
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className='w-40'>
                  <DropdownMenuRadioGroup
                    value={filters.processStatus}
                    onValueChange={(value) => setFilter('processStatus', value)}
                  >
                    {processOptions.map((option) => (
                      <DropdownMenuRadioItem
                        key={option.value}
                        value={option.value}
                        className='text-xs'
                      >
                        {option.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className='text-xs'>
                  阅读状态
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className='w-36'>
                  <DropdownMenuRadioGroup
                    value={filters.read}
                    onValueChange={(value) => setFilter('read', value)}
                  >
                    <DropdownMenuRadioItem value='all' className='text-xs'>
                      全部阅读
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value='unread' className='text-xs'>
                      未读
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value='read' className='text-xs'>
                      已读
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>

        <ButtonGroup aria-label='内容展示方式' className='shrink-0'>
          {viewMode === 'masonry' && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant='outline'
                  size='sm'
                  className='h-8 gap-1.5 px-2.5 text-xs font-normal shadow-none'
                  aria-label='卡片宽度'
                >
                  <Columns3 className='size-3.5' />
                  {selectedCardWidth.label}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end' className='min-w-32'>
                <DropdownMenuRadioGroup
                  value={cardWidth}
                  onValueChange={(value) =>
                    setCardWidth(value as ContentCardWidth)
                  }
                >
                  {cardWidthOptions.map((option) => (
                    <DropdownMenuRadioItem
                      key={option.value}
                      value={option.value}
                      className='text-xs'
                    >
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            variant={viewMode === 'masonry' ? 'secondary' : 'outline'}
            size='sm'
            className='size-8 p-0 shadow-none'
            aria-label='瀑布流'
            title='瀑布流'
            onClick={() => setViewMode('masonry')}
          >
            <LayoutGrid className='size-3.5' />
          </Button>
          <Button
            variant={viewMode === 'table' ? 'secondary' : 'outline'}
            size='sm'
            className='size-8 p-0 shadow-none'
            aria-label='表格'
            title='表格'
            onClick={() => setViewMode('table')}
          >
            <TableProperties className='size-3.5' />
          </Button>
        </ButtonGroup>
      </PageHeader>

      <div
        ref={scrollRef}
        data-slot='content-list-scroll'
        className='min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-20 lg:pb-4'
      >
        {error ? (
          <p className='text-destructive'>读取失败：{error}</p>
        ) : !items ? (
          <p className='text-muted-foreground'>正在读取真实内容…</p>
        ) : visible.length === 0 ? (
          <div className='grid h-48 place-items-center text-sm text-muted-foreground'>
            没有符合条件的内容
          </div>
        ) : (
          <div className='space-y-5'>
            {viewMode === 'table'
              ? renderTable(visible)
              : renderMasonry(visible)}
          </div>
        )}
      </div>
    </div>
  )
  if (mobile && selectedItem)
    return (
      <div className='fixed inset-0 z-50'>
        <Detail
          item={selectedItem}
          index={index}
          count={visible.length}
          onClose={close}
          onMove={move}
          onChanged={changed}
        />
      </div>
    )
  if (!selectedItem)
    return <div className='h-full min-h-0 overflow-hidden'>{list}</div>
  return (
    <ResizablePanelGroup
      orientation='horizontal'
      className='h-svh'
      defaultLayout={defaultLayout}
      onLayoutChanged={(layout, meta) => {
        if (meta.isUserInteraction) {
          localStorage.setItem(
            'qiushuiai-airadar:content-layout',
            JSON.stringify(layout)
          )
        }
      }}
    >
      <ResizablePanel id='content-list' defaultSize='38%' minSize='28%'>
        {list}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id='content-detail' defaultSize='62%' minSize='42%'>
        <Detail
          item={selectedItem}
          index={index}
          count={visible.length}
          onClose={close}
          onMove={move}
          onChanged={changed}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
