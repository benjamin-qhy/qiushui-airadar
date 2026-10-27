import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { App, ContentCard, type FeedItem } from './app.js'
import { Detail } from './features/content-workspace.js'
import { CollectionProvidersPanel } from './features/collection-providers-panel.js'
import { CollectionStatus } from './features/collection-status.js'
import {
  filterContentItems,
  filterContentScope,
} from './lib/content-filters.js'

const item: FeedItem = {
  id: 'xiaohongshu:note-1',
  kind: 'image_post',
  title: '真实图文',
  body: '正文',
  summary: '全部图片附件已经保存。',
  topics: ['AI'],
  scores: { substance: 12 },
  totalScore: 80,
  recommendation: 'core',
  processStatus: 'completed',
  read: false,
  utilizationActions: [],
  junk: { isJunk: false, source: 'none' },
}

describe('complete web shell', () => {
  it('shows an honest combined total for collection runs recorded before the upgrade', () => {
    const html = renderToStaticMarkup(
      <CollectionStatus
        initial={{
          collection: {
            status: 'completed',
            startedAt: '2026-10-10T14:11:14.254Z',
            updatedAt: '2026-10-10T14:12:50.464Z',
            sources: [
              {
                sourceId: 'old-source',
                name: 'Old source',
                status: 'completed',
                discovered: 10,
                completed: 4,
                failed: 0,
                skipped: 6,
              },
            ],
          },
        }}
      />
    )
    expect(html).toContain('处理成功（含已有）')
    expect(html).toContain('这轮采集发生在升级前')
    expect(html).not.toContain('本轮新处理成功')
  })
  it('separates collection providers from business interface routing', () => {
    const html = renderToStaticMarkup(<CollectionProvidersPanel />)
    expect(html).toContain('采集供应商配置')
    expect(html).toContain('业务接口配置')
  })

  it('shows all primary pages without demo content', () => {
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('qiushui-airadar')
    expect(html).toContain('每日精选')
    expect(html).toContain('全部内容')
    expect(html).toContain('异常数据')
    expect(html).toContain('我的收藏')
    expect(html).toContain('垃圾内容')
    expect(html).toContain('信源管理')
    expect(html).toContain('采集设置')
    expect(html).toContain('模型管理')
    expect(html).toContain('运行状态')
    expect(html).toContain('运行日志')
    expect(html).toContain('系统配置')
    expect(html).toContain('data-slot="sidebar"')
    expect(html).toContain('aria-label="折叠侧栏"')
    expect(html).toContain('日期范围')
    expect(html).toContain('卡片宽度')
    expect(html).toContain('瀑布流')
    expect(html).toContain('aria-label="表格"')
    expect(html).toContain('正在读取真实内容')
    expect(html).not.toMatch(/Clerk|Sign in|Dashboard|Tasks|Users/u)
  })

  it('labels a real multimedia content shape', () => {
    const html = renderToStaticMarkup(<ContentCard item={item} />)
    expect(html).toContain('图文')
    expect(html).toContain('真实图文')
    expect(html).toContain('80 分')
  })

  it('shows why a rule classified a page as junk', () => {
    const html = renderToStaticMarkup(
      <ContentCard
        item={{
          ...item,
          totalScore: null,
          junk: {
            isJunk: true,
            source: 'rule',
            reason: 'other',
            note: '活动页：活动报名与介绍，不是文章正文',
          },
        }}
      />
    )
    expect(html).toContain('垃圾内容 · 活动页：活动报名与介绍，不是文章正文')
    expect(html).toContain('不参与评分')
  })

  it('explains missing scores using the processing state', () => {
    for (const [status, label] of [
      ['failed', '失败'],
      ['waiting-manual-transcription', '待人工转写'],
    ] as const) {
      const html = renderToStaticMarkup(
        <ContentCard
          item={{ ...item, totalScore: null, processStatus: status }}
        />
      )
      expect(html).toContain(label)
      expect(html).not.toContain('未评分')
    }
  })

  it('shows the Chinese paraphrase without translation status for English X posts', () => {
    const html = renderToStaticMarkup(
      <ContentCard
        item={{
          ...item,
          id: 'x:translated',
          kind: 'short_post',
          source: { id: 'x-test', name: 'X', type: 'x' },
          title: 'We shipped a new feature',
          chineseTitle: '我们推出了一项新功能',
          body: 'We shipped a new feature today.',
          originalLanguage: 'en',
          chineseTranslation: '我们今天推出了一项新功能。',
          translatedToChinese: true,
        }}
      />
    )
    expect(html).toContain('我们今天推出了一项新功能。')
    expect(html).not.toContain('<h2')
    expect(html).not.toContain('原文英文 · 已意译')
    expect(html).not.toContain('We shipped a new feature</h2>')
  })

  it('shows the full X post without duplicating its generated title or list tags', () => {
    const body = '第一段完整帖子。\n\n第二段也要在卡片内可读。'
    const html = renderToStaticMarkup(
      <ContentCard
        item={{
          ...item,
          kind: 'short_post',
          source: { id: 'x-test', name: 'X / 测试', type: 'x' },
          title: body.slice(0, 10),
          body,
          summary: '这不是卡片要展示的原帖正文',
        }}
      />
    )
    expect(html).toContain(body)
    expect(html).not.toContain('这不是卡片要展示的原帖正文')
    expect(html).not.toContain('<h2')
    expect(html).not.toContain('核心</span>')
    expect(html).not.toContain('>AI</span>')
    expect(html).not.toContain('max-h-[360px]')
    expect(html).not.toContain('overflow-auto')
  })

  it('shows the AI summary instead of the source transcript for videos', () => {
    const html = renderToStaticMarkup(
      <ContentCard
        item={{
          ...item,
          kind: 'video',
          title: '视频标题',
          body: '很长的原始英文字幕',
          summary: '给非技术读者看的中文总结',
          video: { thumbnailUrl: 'https://example.com/thumbnail.jpg' },
        }}
      />
    )
    expect(html).toContain('视频标题')
    expect(html).toContain('给非技术读者看的中文总结')
    expect(html).not.toContain('很长的原始英文字幕')
    expect(html).toContain('aria-label="复制内容"')
  })

  it('puts source in the first row and interaction counts before the date', () => {
    const html = renderToStaticMarkup(
      <Detail
        item={{
          ...item,
          kind: 'video',
          source: { id: 'youtube-ibm', name: 'IBM', type: 'youtube' },
          originalLanguage: 'en',
          publishedAt: '2026-09-18T08:00:00.000Z',
          interaction: {
            capturedAt: '2026-09-18T09:00:00.000Z',
            views: 120,
            likes: 8,
            comments: 0,
            shares: 0,
            saves: 0,
          },
        }}
        index={0}
        count={1}
        onClose={() => {}}
        onMove={() => {}}
        onChanged={() => {}}
      />
    )
    expect(html).toContain('80 分')
    expect(html).toContain('视频')
    expect(html).toContain('IBM')
    expect(html).not.toContain('原文英文 · 未意译')
    expect(html.indexOf('80 分')).toBeLessThan(
      html.indexOf('aria-label="收藏"')
    )
    expect(html.indexOf('IBM')).toBeLessThan(html.indexOf('真实图文</h2>'))
    const metadata = html.match(
      /<div aria-label="互动与发布时间"[^>]*>(.*?)<\/div>/u
    )?.[1]
    expect(metadata).toBeDefined()
    expect(metadata).toContain('120')
    expect(metadata).toContain('2026/9/18')
    expect(metadata!.indexOf('120')).toBeLessThan(
      metadata!.indexOf('2026/9/18')
    )
    expect(html.indexOf('120')).toBeGreaterThan(html.indexOf('真实图文</h2>'))
    for (const tab of ['AI 总结', '中文', '英文', '属性', '日志']) {
      expect(html).toContain(tab)
    }
    expect(html).toContain('aria-label="复制 AI 总结"')
    expect(html.indexOf('看完能获得什么</h3>')).toBeLessThan(
      html.indexOf('文章标签</h3>')
    )
    expect(html.indexOf('文章标签</h3>')).toBeLessThan(
      html.indexOf('AI 总结</h3>')
    )
    for (const action of ['做卡片', '做视频', '写文章', '建项目']) {
      expect(html).not.toContain(action)
    }
  })

  it('omits the English tab when no English document exists', () => {
    const html = renderToStaticMarkup(
      <Detail
        item={{
          ...item,
          originalLanguage: 'en',
          body: '',
          hasEnglishBody: false,
          processStatus: 'failed',
        }}
        index={0}
        count={1}
        onClose={() => {}}
        onMove={() => {}}
        onChanged={() => {}}
      />
    )
    expect(html).toContain('AI 总结')
    expect(html).toContain('中文')
    expect(html).not.toContain('>英文</button>')
    expect(html).toContain(
      '暂无互动数据</span><span class="whitespace-nowrap">发布时间未知'
    )
  })

  it('supports combined process, read and junk filters', () => {
    const other: FeedItem = {
      ...item,
      id: 'x:2',
      title: '失败垃圾',
      processStatus: 'failed',
      read: true,
      junk: { isJunk: true, source: 'manual' },
    }
    expect(
      filterContentItems([item, other], {
        query: '垃圾',
        processStatus: 'failed',
        recommendation: 'all',
        read: 'read',
        junk: 'junk',
        dateFrom: '',
        dateTo: '',
      })
    ).toEqual([other])
    expect(
      filterContentItems([{ ...item, originalStatus: 'private' }], {
        query: '',
        processStatus: 'original-unavailable',
        recommendation: 'all',
        read: 'all',
        junk: 'all',
        dateFrom: '',
        dateTo: '',
      })
    ).toHaveLength(1)
    expect(
      filterContentItems(
        [
          {
            ...item,
            publishedAt: '2020-01-01T00:00:00.000Z',
            firstInflowAt: '2026-09-14T01:00:00.000Z',
          },
          {
            ...item,
            id: 'x:outside-range',
            firstInflowAt: '2026-09-07T01:00:00.000Z',
          },
        ],
        {
          query: '',
          processStatus: 'all',
          recommendation: 'all',
          read: 'all',
          junk: 'all',
          dateFrom: '2026-09-08',
          dateTo: '2026-09-14',
        }
      )
    ).toHaveLength(1)
  })

  it('separates incomplete, unscored and untranslated English content from completed content', () => {
    const junk = {
      ...item,
      id: 'x:junk',
      totalScore: null,
      junk: { isJunk: true, source: 'manual' as const },
    }
    const ordinary = {
      ...item,
      id: 'x:ordinary',
      recommendation: 'none' as const,
    }
    const failed = {
      ...item,
      id: 'x:failed',
      processStatus: 'failed' as const,
      totalScore: null,
    }
    const processing = {
      ...item,
      id: 'x:processing',
      processStatus: 'processing' as const,
    }
    const unscored = { ...item, id: 'x:unscored', totalScore: null }
    const untranslatedEnglish = {
      ...item,
      id: 'x:untranslated-en',
      originalLanguage: 'en' as const,
      translatedToChinese: false,
    }
    const untranslatedChinese = {
      ...item,
      id: 'x:untranslated-zh',
      originalLanguage: 'zh' as const,
      translatedToChinese: false,
    }
    const items = [
      item,
      junk,
      ordinary,
      failed,
      processing,
      unscored,
      untranslatedEnglish,
      untranslatedChinese,
    ]

    expect(filterContentScope(items, 'daily')).toEqual([
      item,
      untranslatedChinese,
    ])
    expect(filterContentScope(items, 'all')).toEqual([
      item,
      ordinary,
      untranslatedChinese,
    ])
    expect(filterContentScope(items, 'exceptions')).toEqual([
      failed,
      processing,
      unscored,
      untranslatedEnglish,
    ])
    expect(filterContentScope(items, 'junk')).toEqual([junk])
    const favorite = {
      ...failed,
      id: 'x:favorite',
      utilizationActions: ['favorite' as const],
    }
    expect(filterContentScope([...items, favorite], 'favorites')).toEqual([
      favorite,
    ])
  })
})
