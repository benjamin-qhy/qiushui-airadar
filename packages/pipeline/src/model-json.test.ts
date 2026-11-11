import { describe, expect, it } from 'vitest'
import { parseModelJson } from './single-table-flow.js'

describe('model response JSON escaping', () => {
  it('preserves literal LaTeX backslashes in translations', () => {
    expect(
      parseModelJson(String.raw`{"chineseBody":"公式 \(x\) 和 \alpha"}`)
    ).toEqual({ chineseBody: String.raw`公式 \(x\) 和 \alpha` })
  })
  it('preserves valid escapes and fixes raw newlines', () => {
    expect(parseModelJson('{"text":"a\nb\\t\\"c\\\\d"}')).toEqual({
      text: 'a\nb\t"c\\d',
    })
  })
  it('continues rejecting incomplete JSON', () => {
    expect(() => parseModelJson('{"text":"unfinished')).toThrow()
  })
})
