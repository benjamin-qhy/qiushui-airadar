import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import {
  createCollectionScheduler,
  scheduledMinute,
} from './collection-scheduler.js'

it('matches 04:00 in Shanghai rather than the host timezone', () => {
  expect(
    scheduledMinute(
      '0 4 * * *',
      'Asia/Shanghai',
      new Date('2026-10-27T20:00:30Z')
    )
  ).not.toBeNull()
  expect(
    scheduledMinute(
      '0 4 * * *',
      'Asia/Shanghai',
      new Date('2026-10-27T04:00:00Z')
    )
  ).toBeNull()
  expect(() =>
    scheduledMinute('99 4 * * *', 'Asia/Shanghai', new Date())
  ).toThrow('格式无效')
})

it('starts once per scheduled minute across restarts and reads changed plans', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'airadar-schedule-'))
  let now = new Date('2026-10-27T19:59:00Z')
  let calls = 0
  let expression = '0 4 * * *'
  const options = {
    stateFile: path.join(root, 'schedule.json'),
    readPlan: async () => ({ expression, timezone: 'Asia/Shanghai' }),
    now: () => now,
    trigger: async () => {
      calls++
      return { accepted: true, message: 'started' }
    },
  }
  try {
    const scheduler = createCollectionScheduler(options)
    await scheduler.tick()
    expect(calls).toBe(0)
    now = new Date('2026-10-27T20:00:00Z')
    await Promise.all([scheduler.tick(), scheduler.tick()])
    expect(calls).toBe(1)
    const restarted = createCollectionScheduler(options)
    await restarted.tick()
    expect(calls).toBe(1)
    expression = '0 5 * * *'
    now = new Date('2026-10-28T20:00:00Z')
    await restarted.tick()
    expect(calls).toBe(1)
    now = new Date('2026-10-28T21:00:00Z')
    await restarted.tick()
    expect(calls).toBe(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('records a rejected model preflight and does not repeatedly trigger it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'airadar-schedule-error-'))
  let calls = 0
  const stateFile = path.join(root, 'schedule.json')
  const scheduler = createCollectionScheduler({
    stateFile,
    readPlan: async () => ({
      expression: '0 4 * * *',
      timezone: 'Asia/Shanghai',
    }),
    now: () => new Date('2026-10-27T20:00:00Z'),
    trigger: async () => {
      calls++
      return { accepted: false, message: '模型连接失败，请检查配置。' }
    },
  })
  try {
    await scheduler.tick()
    await scheduler.tick()
    expect(calls).toBe(1)
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toMatchObject({
      status: 'failed',
      message: '模型连接失败，请检查配置。',
    })
  } finally {
    await scheduler.stop()
    await rm(root, { recursive: true, force: true })
  }
})
