import { expect, it } from 'vitest'
import { screenYouTubeDiscovery } from './single-table-collector.js'
import type { SingleTableModelGateway } from './single-table-flow.js'

const profile = { interests: ['AI'], goals: ['工作流'], exclusions: ['体育'] }
const item = {
  externalId: 'video',
  kind: 'video' as const,
  title: 'A video',
  body: 'Description',
}
function gateway(text: string): SingleTableModelGateway {
  return {
    async complete() {
      return { text, provider: 'test', model: 'test', durationMs: 0 }
    },
  }
}
it('rejects only explicitly unrelated metadata with a reason', async () => {
  expect(
    await screenYouTubeDiscovery(
      item,
      gateway('{"exclude":true,"reason":"仅讲足球比赛"}'),
      profile
    )
  ).toEqual({ reason: 'YouTube 简介筛选：仅讲足球比赛' })
  for (const text of [
    '{"exclude":false}',
    '{"exclude":"true"}',
    '{"exclude":true}',
    'invalid',
  ])
    expect(await screenYouTubeDiscovery(item, gateway(text), profile)).toEqual(
      {}
    )
})
it('keeps missing descriptions without calling the model and filters non-normal scopes', async () => {
  let calls = 0
  const failing: SingleTableModelGateway = {
    async complete() {
      calls++
      throw Error('unavailable')
    },
  }
  expect(
    await screenYouTubeDiscovery({ ...item, body: undefined }, failing, profile)
  ).toEqual({})
  for (const videoScope of ['short', 'live', 'live-replay'] as const)
    expect(
      (await screenYouTubeDiscovery({ ...item, videoScope }, failing, profile))
        .reason
    ).toBeTruthy()
  expect(calls).toBe(0)
  expect(await screenYouTubeDiscovery(item, failing, profile)).toEqual({})
})
