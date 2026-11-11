import { expect, it, vi } from 'vitest'
import {
  checkPostCopy,
  postLanguageProblems,
  finalizeCopy,
  parseTranslateOutput,
} from './x-post-writing.js'
const input = {
  title: 'New release',
  text: 'We published 12 examples.',
  sourceKind: 'x_search',
}
const draft = {
  titleZh: '重磅！新增示例',
  summaryZh: '我们发布了 12 个示例。',
  reasonZh: null,
}
it('keeps the first copy when a wording revision changes a number or the subject', async () => {
  for (const summaryZh of [
    '我们发布了 13 个示例。',
    'OpenAI 发布了 12 个示例。',
  ]) {
    const revise = vi.fn(async () => ({
      ...draft,
      titleZh: '新增示例',
      summaryZh,
    }))
    const copy = await checkPostCopy(input, draft, revise, [
      [/重磅/u, '直接写事实'],
    ])
    expect(revise).toHaveBeenCalledTimes(1)
    expect(copy).toMatchObject(draft)
  }
})
it('leaves original empty wording rules inactive and drops unsupported identities', async () => {
  const revise = vi.fn()
  await checkPostCopy(input, draft, revise)
  expect(revise).not.toHaveBeenCalled()
  expect(
    finalizeCopy(input, { ...draft, titleZh: 'OpenAI 发布示例' }).titleZh
  ).toBe('')
  expect(parseTranslateOutput('标题\n第一行\n第二行').summaryZh).toBe(
    '第一行\n第二行'
  )
})

it('accepts lowercase cursor in coding context but not a mouse pointer as product evidence', () => {
  const copy = { titleZh: '作者谈错失的机会', summaryZh: '作者提到了 Cursor。' }
  expect(
    finalizeCopy(
      {
        ...input,
        text: 'their cursor bag fumble; would have been on claude code',
      },
      copy
    ).summaryZh
  ).toBe(copy.summaryZh)
  expect(
    finalizeCopy({ ...input, text: 'Move the mouse cursor to the left' }, copy)
      .summaryZh
  ).toBe('')
})

it('flags a copied English sentence and stray foreign script but permits original names and hashtags', () => {
  const main = 'How it started vs. how it’s going.\nSee @PyCon #BuildInPublic'
  expect(
    postLanguageProblems({ ...draft, summaryZh: main }, main)
  ).toHaveLength(1)
  expect(
    postLanguageProblems({ ...draft, summaryZh: '使用აგენტ处理请求。' }, main)
  ).toHaveLength(1)
  expect(
    postLanguageProblems(
      { ...draft, summaryZh: '从最初到现在。\n@PyCon #BuildInPublic' },
      main
    )
  ).toEqual([])
})
