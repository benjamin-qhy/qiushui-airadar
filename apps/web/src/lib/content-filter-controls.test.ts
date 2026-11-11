import { describe, expect, it } from 'vitest'
import { filterContentItems, type ContentFilters } from './content-filters'
import { readContentFilters, resolveDatePreset, writeContentFilters } from './content-location'
import type { FeedItem } from '../types'

const defaults: ContentFilters = {
  query: '',
  processStatus: 'all',
  recommendation: 'all',
  read: 'all',
  junk: 'all',
  dateFrom: '',
  dateTo: '',
  kind: 'all',
  tag: 'all',
  sourceType: 'all',
}
const base: FeedItem = {
  id: 'a',
  title: 'English title',
  chineseTitle: '中文标题',
  body: '',
  summary: '摘要',
  keywordsText: '关键词',
  topics: ['AI'],
  kind: 'article',
  totalScore: 50,
  scores: {},
  recommendation: 'none',
  processStatus: 'completed',
  read: false,
  utilizationActions: [],
  junk: { isJunk: false, source: 'none' },
  firstInflowAt: '2026-11-09T00:00:00+08:00',
  source: { id: 's', name: '信源名', type: 'x' },
}
describe('header filter controls', () => {
  it.each(['English', '中文标题', '摘要', '关键词', '信源名'])(
    'searches %s',
    (query) => {
      expect(filterContentItems([base], { ...defaults, query })).toHaveLength(1)
    }
  )
  it.each(['video', 'audio', 'image_post', 'article', 'short_post'] as const)(
    'filters kind %s',
    (kind) => {
      const item = { ...base, kind }
      expect(
        filterContentItems([item, { ...base, kind: undefined }], {
          ...defaults,
          kind,
        })
      ).toEqual([item])
    }
  )
  it.each([
    'x',
    'youtube',
    'rss',
    'douyin',
    'wechat_channels',
    'xiaohongshu',
  ] as const)('filters platform %s', (type) => {
    const item = { ...base, source: { ...base.source!, type } }
    expect(
      filterContentItems([item, { ...base, source: undefined }], {
        ...defaults,
        sourceType: type,
      })
    ).toEqual([item])
  })
  it.each([
    'unprocessed',
    'processing',
    'completed',
    'failed',
    'waiting-manual-transcription',
  ] as const)('filters status %s', (processStatus) => {
    const item = { ...base, processStatus }
    expect(filterContentItems([item], { ...defaults, processStatus })).toEqual([
      item,
    ])
    expect(
      filterContentItems([item], { ...defaults, processStatus: 'other' })
    ).toEqual([])
  })
  it.each(['read', 'unread'])('filters %s', (read) => {
    expect(
      filterContentItems([{ ...base, read: true }, base], { ...defaults, read })
    ).toEqual([read === 'read' ? { ...base, read: true } : base])
  })
  it('combines filters, includes both boundary days, excludes missing dates and restores all', () => {
    const items = [
      '2026-11-06T23:59:59+08:00',
      '2026-11-07T00:00:00+08:00',
      '2026-11-09T23:59:59+08:00',
      '2026-11-10T00:00:00+08:00',
      undefined,
    ].map((firstInflowAt, i) => ({ ...base, id: String(i), firstInflowAt }))
    expect(
      filterContentItems(items, {
        ...defaults,
        query: '中文',
        tag: 'AI',
        sourceType: 'x',
        kind: 'article',
        dateFrom: '2026-11-07',
        dateTo: '2026-11-09',
      }).map((x) => x.id)
    ).toEqual(['1', '2'])
    expect(
      filterContentItems(items, {
        ...defaults,
        dateFrom: '2026-11-09',
        dateTo: '2026-11-09',
      }).map((x) => x.id)
    ).toEqual(['2'])
    expect(filterContentItems(items, { ...defaults, tag: '不存在' })).toEqual(
      []
    )
    expect(filterContentItems(items, defaults)).toHaveLength(5)
  })
  it('neutralizes obsolete recommendation in saved settings and old URLs', () => {
    expect(
      readContentFilters('', { ...defaults, recommendation: 'core' })
        .recommendation
    ).toBe('all')
    expect(
      readContentFilters('?filters=1&recommendation=explore', defaults)
        .recommendation
    ).toBe('all')
  })
})

it.each([
  ['day', '2026-11-01'],
  ['three-days', '2026-10-30'],
  ['week', '2026-10-26'],
  ['month', '2026-10-03'],
  ['quarter', '2026-08-04'],
  ['half-year', '2026-05-06'],
])(
  'refreshes saved relative range %s across month boundaries',
  (datePreset, dateFrom) => {
    expect(
      resolveDatePreset(
        { ...defaults, datePreset, dateFrom: '2000-01-01' },
        new Date('2026-11-01T12:00:00+08:00')
      )
    ).toMatchObject({ dateFrom, dateTo: '2026-11-01' })
  }
)


it('uses platform publication date first and first collection as the stable fallback', () => {
  const items = [
    { ...base, id: 'old-publication', publishedAt: '2020-01-01T12:00:00+08:00' },
    { ...base, id: 'recent-publication', publishedAt: '2026-11-09T12:00:00+08:00', firstInflowAt: '2026-11-10T12:00:00+08:00' },
    { ...base, id: 'collection-fallback', discoveredAt: '2026-11-10T12:00:00+08:00' },
    { ...base, id: 'invalid-publication', publishedAt: 'invalid' },
  ]
  expect(filterContentItems(items, { ...defaults, dateFrom: '2026-11-09', dateTo: '2026-11-09' }).map(item => item.id))
    .toEqual(['recent-publication', 'collection-fallback', 'invalid-publication'])
})

it('filters inclusive score boundaries and keeps unscored separate while combining other filters', () => {
  const ranges = [{ id: 'high', min: 80, max: 89 }]
  const items = [null, 0, 79, 80, 89, 90, 100].map((totalScore, i) => ({ ...base, id: String(i), totalScore }))
  expect(filterContentItems(items, { ...defaults, scoreRange: 'high' }, ranges).map(item => item.totalScore)).toEqual([80, 89])
  expect(filterContentItems(items, { ...defaults, scoreRange: 'unscored' }, ranges).map(item => item.totalScore)).toEqual([null])
  expect(filterContentItems(items, { ...defaults, scoreRange: 'all' }, ranges)).toHaveLength(7)
  expect(filterContentItems(items, { ...defaults, scoreRange: 'high', query: '不存在' }, ranges)).toEqual([])
  expect(filterContentItems(items, { ...defaults, scoreRange: 'deleted-range' }, ranges)).toHaveLength(7)
})

it('shares selected score ranges in URLs and restores saved choices', () => {
  const filters = { ...defaults, scoreRange: 'score-80' }
  const url = writeContentFilters(new URL('http://localhost/content'), filters)
  expect(readContentFilters(url.search, defaults).scoreRange).toBe('score-80')
  expect(readContentFilters('', filters).scoreRange).toBe('score-80')
  expect(readContentFilters('?filters=1', defaults).scoreRange).toBe('')
})
