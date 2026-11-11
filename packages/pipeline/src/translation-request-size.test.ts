import { expect, it } from 'vitest'
import { splitTranslationDocument } from './document-translation.js'
it('bounds requests for large-capacity models without losing text', () => {
  const body = 'Long document content '.repeat(5000)
  const chunks = splitTranslationDocument(body, {
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    provider: 'openai',
    model: 'large',
  })
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.every((x) => Buffer.byteLength(x) <= 12000)).toBe(true)
  expect(chunks.join('')).toBe(body.trim())
})
