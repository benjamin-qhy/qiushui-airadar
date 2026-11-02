import { describe, expect, it } from 'vitest'
import { contentHref, listHref, pages, readRoute } from './navigation'
import { readContentFilters, writeContentFilters } from './content-location'
import type { ContentFilters } from './content-filters'

const defaults: ContentFilters = {
  query: '',
  processStatus: 'all',
  recommendation: 'all',
  read: 'all',
  junk: 'clean',
  dateFrom: '',
  dateTo: '',
  sort: 'newest',
}

describe('page and content addresses', () => {
  it.each(pages)('opens %s through both new and legacy addresses', (page) => {
    expect(readRoute(new URL(`http://local/${page}`)).page).toBe(page)
    expect(readRoute(new URL(`http://local/?page=${page}`)).page).toBe(page)
  })
  it('round trips platform IDs, slashes, dots and non-ASCII characters', () => {
    const id = 'rss:https://example.test/文章.1?a=b#c'
    const href = contentHref(id, 'favorites', '?query=AI&filters=1')
    const url = new URL(href, 'http://local')
    expect(readRoute(url)).toEqual({ page: 'favorites', contentId: id })
    expect(listHref('favorites', url.search)).toBe(
      '/favorites?query=AI&filters=1'
    )
    expect(
      readRoute(new URL(`http://local/content/${encodeURIComponent(id)}`))
    ).toEqual({ page: 'all', contentId: id })
  })
  it('handles malformed content addresses without crashing', () => {
    expect(readRoute(new URL('http://local/content/%ZZ'))).toEqual({
      page: 'all',
    })
  })
  it('restores a complete filter snapshot independently of saved browser preferences', () => {
    const filters = {
      ...defaults,
      query: '中文 AI',
      read: 'unread',
      dateFrom: '2026-11-01',
      dateTo: '2026-11-02',
      kind: 'article',
    }
    const url = writeContentFilters(
      new URL('http://local/all?models-tab=providers'),
      filters
    )
    expect(
      readContentFilters(url.search, {
        ...defaults,
        query: '另一浏览器',
        sort: 'oldest',
      })
    ).toMatchObject(filters)
    expect(url.searchParams.get('models-tab')).toBe('providers')
  })
})
