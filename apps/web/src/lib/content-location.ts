import type { ContentFilters } from './content-filters'

const filterKeys = [
  'query',
  'processStatus',
  'recommendation',
  'read',
  'junk',
  'dateFrom',
  'dateTo',
  'datePreset',
  'tag',
  'kind',
  'sourceType',
  'sort',
  'scoreRange',
] as const

export function resolveDatePreset(
  filters: ContentFilters,
  now = new Date()
): ContentFilters {
  const days = (
    {
      day: 1,
      'three-days': 3,
      week: 7,
      month: 30,
      quarter: 90,
      'half-year': 180,
    } as Record<string, number>
  )[filters.datePreset ?? '']
  if (!days) return filters
  const from = new Date(now)
  from.setDate(from.getDate() - days + 1)
  return {
    ...filters,
    dateFrom: from.toLocaleDateString('en-CA'),
    dateTo: now.toLocaleDateString('en-CA'),
  }
}

// A complete snapshot avoids depending on another browser's saved filters.
export function readContentFilters(
  search: string,
  defaults: ContentFilters
): ContentFilters {
  const params = new URLSearchParams(search)
  if (params.get('filters') !== '1')
    return resolveDatePreset({ ...defaults, recommendation: 'all' })
  const filters = { ...defaults }
  for (const key of filterKeys) filters[key] = params.get(key) ?? ''
  return resolveDatePreset({ ...filters, recommendation: 'all' })
}
export function writeContentFilters(url: URL, filters: ContentFilters): URL {
  const target = new URL(url)
  target.searchParams.set('filters', '1')
  for (const key of filterKeys) target.searchParams.set(key, filters[key] ?? '')
  return target
}
