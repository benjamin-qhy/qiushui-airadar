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
  'kind',
  'sourceType',
  'sort',
] as const

// A complete snapshot avoids depending on another browser's saved filters.
export function readContentFilters(
  search: string,
  defaults: ContentFilters
): ContentFilters {
  const params = new URLSearchParams(search)
  if (params.get('filters') !== '1') return defaults
  const filters = { ...defaults }
  for (const key of filterKeys) filters[key] = params.get(key) ?? ''
  return filters
}
export function writeContentFilters(url: URL, filters: ContentFilters): URL {
  const target = new URL(url)
  target.searchParams.set('filters', '1')
  for (const key of filterKeys) target.searchParams.set(key, filters[key] ?? '')
  return target
}
