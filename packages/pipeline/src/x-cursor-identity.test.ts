import { expect, it } from 'vitest'
import { finalizeCopy } from './x-post-writing.js'
it('recognizes lowercase Cursor in cloud agent and multi-model app contexts', () => {
  for (const text of [
    'Works great with cursor cloud agents',
    'apps that can use models from different labs like conductor, cursor and others',
  ]) {
    const result = finalizeCopy(
      { title: text, text, sourceKind: 'x_search', mainText: text },
      {
        titleZh: 'Cursor 的使用体验',
        summaryZh: '作者谈到 Cursor 的使用体验。',
      }
    )
    expect(result.summaryZh).toBe('作者谈到 Cursor 的使用体验。')
  }
})
it('does not treat a mouse cursor as the product', () => {
  expect(
    finalizeCopy(
      {
        title: 'Move the cursor',
        text: 'Move the cursor',
        sourceKind: 'x_search',
      },
      { titleZh: '体验', summaryZh: '使用 Cursor。' }
    ).summaryZh
  ).toBe('')
})
it('recognizes the official AWS account handle in source text', () => {
  const text = 'We run our engine on @awscloud Trainium.'
  expect(
    finalizeCopy(
      { title: text, text, sourceKind: 'x_search', mainText: text },
      { titleZh: 'AWS 推理引擎', summaryZh: '引擎运行在 AWS Trainium 上。' }
    ).summaryZh
  ).toBe('引擎运行在 AWS Trainium 上。')
})
