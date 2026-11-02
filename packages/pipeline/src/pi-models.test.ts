import { describe, expect, it } from 'vitest'

import { createApplicationModels } from './pi-models.js'
import {
  createSingleTableModelGateway,
  listSingleTableModels,
} from './single-table-flow.js'

describe('pi catalog upgrades', () => {
  it('keeps the installed DeepSeek default usable without changing its model ID', () => {
    const models = createApplicationModels()
    const model = models.getModel('deepseek', 'deepseek-v4-flash')
    expect(model).toMatchObject({
      id: 'deepseek-v4-flash',
      api: 'openai-completions',
      baseUrl: 'https://api.deepseek.com',
    })
    expect(models.getProvider('deepseek')?.stream).toBeTypeOf('function')
    const gateway = createSingleTableModelGateway(
      {
        read: async () => undefined,
        list: async () => [],
        modify: async () => undefined,
        delete: async () => {},
      },
      'deepseek',
      'deepseek-v4-flash'
    )
    for (const stage of ['classify', 'score', 'translate'] as const)
      expect(gateway.getCapacity?.(stage)?.model).toBe('deepseek-v4-flash')
  })

  it('exposes the updated OpenAI catalog while retaining saved Codex routes', () => {
    expect(listSingleTableModels('openai').map((model) => model.id)).toContain(
      'gpt-6.1-sol'
    )
    const ids = listSingleTableModels('openai-codex').map((model) => model.id)
    expect(ids).toEqual(expect.arrayContaining(['gpt-6.1-sol', 'gpt-5.5']))
    expect(new Set(ids).size).toBe(ids.length)
  })
})
