import type { FeedItem } from '@/types'

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
  kind?: string
  sourceType?: string
  sort?: string
}

export type ContentScope =
  'daily' | 'all' | 'exceptions' | 'favorites' | 'junk' | 'unprocessed'

export function isExceptionalContent(item: FeedItem): boolean {
  return (
    item.processStatus !== 'unprocessed' &&
    !item.junk.isJunk &&
    (item.processStatus !== 'completed' ||
      item.totalScore === null ||
      (item.originalLanguage === 'en' && !item.translatedToChinese))
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
      (item.recommendation === 'core' || item.recommendation === 'explore')
    )
  })
}

export function filterContentItems(
  items: FeedItem[],
  filters: ContentFilters
): FeedItem[] {
  const query = filters.query.trim().toLowerCase()
  return items.filter((item) => {
    const inflowDate = localDateKey(item.firstInflowAt)
    return (
      (!query ||
        `${item.title} ${item.chineseTitle ?? ''} ${item.summary} ${item.keywordsText ?? ''} ${item.valueSummary ?? ''} ${item.unprocessedReason ?? ''} ${item.source?.name ?? ''}`
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
      (!filters.kind || filters.kind === 'all' || item.kind === filters.kind) &&
      (!filters.sourceType ||
        filters.sourceType === 'all' ||
        item.source?.type === filters.sourceType) &&
      ((!filters.dateFrom && !filters.dateTo) ||
        (Boolean(inflowDate) &&
          (!filters.dateFrom || inflowDate! >= filters.dateFrom) &&
          (!filters.dateTo || inflowDate! <= filters.dateTo)))
    )
  })
}
