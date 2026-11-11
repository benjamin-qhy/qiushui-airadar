import type { FeedItem, ScoreRange } from '@/types'

// Keep display, calendar filtering and chronological sorting on the same date.
export function contentDate(
  item: FeedItem
): { value: string; label: '发布' | '采集' } | undefined {
  if (item.publishedAt && Number.isFinite(Date.parse(item.publishedAt)))
    return { value: item.publishedAt, label: '发布' }
  if (item.firstInflowAt && Number.isFinite(Date.parse(item.firstInflowAt)))
    return { value: item.firstInflowAt, label: '采集' }
  return undefined
}

function localDateKey(value: string | undefined): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? undefined
    : date.toLocaleDateString('en-CA')
}

export interface ContentFilters {
  query: string
  processStatus: string
  recommendation: string
  read: string
  junk: string
  dateFrom: string
  dateTo: string
  datePreset?: string
  dateField?: 'published' | 'collected'
  tag?: string
  kind?: string
  sourceType?: string
  sort?: string
  scoreRange?: string
}

export type ContentScope =
  'daily' | 'all' | 'exceptions' | 'favorites' | 'junk' | 'unprocessed'

export function isExceptionalContent(item: FeedItem): boolean {
  return (
    item.processStatus !== 'unprocessed' &&
    !item.junk.isJunk &&
    (item.processStatus !== 'completed' ||
      item.totalScore === null ||
      (item.originalLanguage === 'en' &&
        !item.translatedToChinese &&
        !(
          item.analysis?.ruleVersion === 'aihot-41cee09' &&
          item.translationStatus === 'skipped'
        )))
  )
}

export function filterContentScope(
  items: FeedItem[],
  scope: ContentScope
): FeedItem[] {
  return items.filter((item) => {
    if (scope === 'unprocessed') return item.processStatus === 'unprocessed'
    if (scope === 'junk') return item.junk.isJunk
    if (scope === 'favorites')
      return item.utilizationActions.includes('favorite')
    if (scope === 'exceptions') return isExceptionalContent(item)
    if (item.junk.isJunk || item.processStatus === 'unprocessed') return false
    if (isExceptionalContent(item)) return false
    if (scope === 'all') return true
    return (
      item.processStatus === 'completed' &&
      (item.analysis?.ruleVersion === 'aihot-41cee09' ||
        item.recommendation === 'core' ||
        item.recommendation === 'explore')
    )
  })
}

export function filterContentItems(
  items: FeedItem[],
  filters: ContentFilters,
  scoreRanges: ScoreRange[] = []
): FeedItem[] {
  const query = filters.query.trim().toLowerCase()
  const scoreRange = scoreRanges.find(
    (range) => range.id === filters.scoreRange
  )
  return items.filter((item) => {
    const displayDate = localDateKey(
      filters.dateField === 'collected'
        ? item.firstInflowAt
        : contentDate(item)?.value
    )
    return (
      (filters.scoreRange === 'unscored'
        ? item.totalScore === null
        : !scoreRange ||
          (item.totalScore !== null && item.totalScore >= scoreRange.min)) &&
      (!query ||
        `${item.title} ${item.chineseTitle ?? ''} ${item.summary} ${item.keywordsText ?? ''} ${item.unprocessedReason ?? ''} ${item.source?.name ?? ''}`
          .toLowerCase()
          .includes(query)) &&
      (filters.processStatus === 'all' ||
        (filters.processStatus === 'original-unavailable'
          ? item.originalStatus === 'deleted' ||
            item.originalStatus === 'private'
          : item.processStatus === filters.processStatus)) &&
      (filters.recommendation === 'all' ||
        item.recommendation === filters.recommendation) &&
      (filters.read === 'all' || item.read === (filters.read === 'read')) &&
      (filters.junk === 'all' ||
        item.junk.isJunk === (filters.junk === 'junk')) &&
      (!filters.tag ||
        filters.tag === 'all' ||
        item.topics.includes(filters.tag)) &&
      (!filters.kind || filters.kind === 'all' || item.kind === filters.kind) &&
      (!filters.sourceType ||
        filters.sourceType === 'all' ||
        item.source?.type === filters.sourceType) &&
      ((!filters.dateFrom && !filters.dateTo) ||
        (Boolean(displayDate) &&
          (!filters.dateFrom || displayDate! >= filters.dateFrom) &&
          (!filters.dateTo || displayDate! <= filters.dateTo)))
    )
  })
}
