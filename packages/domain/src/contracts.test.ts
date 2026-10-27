import { describe, expect, it } from 'vitest'
import {
  analysisRunSchema,
  contentSchema,
  discoverySchema,
  parameterVersionSchema,
  providerSchema,
  sourceSchema,
  taskSchema,
} from './index.js'

describe('qiushui-airadar domain contracts', () => {
  it('accepts one connected set of versioned records', () => {
    const source = sourceSchema.parse({
      id: 'source-openai-rss',
      slug: 'openai_news',
      name: 'OpenAI News',
      type: 'rss',
      externalIdentity: 'https://openai.com/news/rss.xml',
      status: 'enabled',
    })
    const content = contentSchema.parse({
      id: 'content-1',
      kind: 'article',
      canonicalUrl: 'https://openai.com/news/example',
      title: 'Example',
    })
    expect(
      discoverySchema.parse({
        id: 'discovery-1',
        sourceId: source.id,
        contentId: content.id,
        externalId: 'entry-1',
        discoveredAt: '2026-09-14T00:00:00.000Z',
      })
    ).toBeTruthy()
    expect(
      taskSchema.parse({
        id: 'task-1',
        type: 'discover',
        status: 'pending',
        attempt: 0,
        parameterVersionId: 'parameters-1',
      })
    ).toBeTruthy()
    expect(
      analysisRunSchema.parse({
        id: 'analysis-1',
        contentId: content.id,
        status: 'pending',
        promptVersion: 'summary-v1',
        profileVersionId: 'profile-1',
        model: 'test-model',
      })
    ).toBeTruthy()
    expect(
      parameterVersionSchema.parse({
        id: 'parameters-1',
        version: 1,
        createdAt: '2026-09-14T00:00:00.000Z',
        values: {},
      })
    ).toBeTruthy()
    expect(
      providerSchema.parse({
        id: 'native-rss',
        sourceType: 'rss',
        enabled: true,
        priority: 1,
      })
    ).toBeTruthy()
  })

  it('rejects secrets in business records', () => {
    expect(() =>
      sourceSchema.parse({
        id: 'source-1',
        slug: 'x',
        name: 'X',
        type: 'x',
        externalIdentity: 'OpenAI',
        status: 'enabled',
        apiKey: 'must-not-pass',
      })
    ).toThrow()
    expect(() =>
      providerSchema.parse({
        id: 'tikhub',
        sourceType: 'x',
        enabled: true,
        priority: 1,
        token: 'must-not-pass',
      })
    ).toThrow()
    for (const key of [
      'tikhubToken',
      'privateKey',
      'credential',
      'bearer',
      'clientSecret',
      'signingKey',
    ]) {
      expect(() =>
        parameterVersionSchema.parse({
          id: `parameters-${key}`,
          version: 1,
          createdAt: '2026-09-14T00:00:00.000Z',
          values: { provider: { [key]: 'must-not-pass' } },
        })
      ).toThrow('secret-like key')
    }
  })

  it('allows a secret name reference without storing its value', () => {
    expect(
      parameterVersionSchema.parse({
        id: 'parameters-with-reference',
        version: 1,
        createdAt: '2026-09-14T00:00:00.000Z',
        values: {
          provider: { tikhubToken: { secretRef: 'TIKHUB_TOKEN' } },
        },
      })
    ).toBeTruthy()
  })
})
