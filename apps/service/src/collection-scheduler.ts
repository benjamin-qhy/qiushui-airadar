import { readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

function fieldMatches(field: string, value: number, sunday = false): boolean {
  return field.split(',').some((entry) => {
    const [range = '*', stepText] = entry.split('/')
    const step = stepText ? Number(stepText) : 1
    const normalize = (n: number) => (sunday && n === 7 ? 0 : n)
    if (range === '*') return value % step === 0
    const [startText, endText] = range.split('-')
    const start = normalize(Number(startText))
    const end = normalize(Number(endText ?? startText))
    if (sunday && Number(endText) === 7 && start > end)
      return (value >= start || value <= end) && value % step === start % step
    return value >= start && value <= end && (value - start) % step === 0
  })
}

export function scheduledMinute(
  expression: string,
  timezone: string,
  now: Date
): string | null {
  const fields = expression.trim().split(/\s+/u)
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ] as const
  if (
    fields.length !== 5 ||
    fields.some((field, index) => {
      const [min, max] = ranges[index]!
      return (
        !/^[\d*,/-]+$/u.test(field) ||
        !Array.from({ length: max - min + 1 }, (_, n) => n + min).some((n) =>
          fieldMatches(field, n, index === 4)
        )
      )
    })
  )
    throw new Error('采集计划格式无效，请检查五段式定时表达式。')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const part = (type: string) => parts.find((item) => item.type === type)!.value
  const day = Number(part('day'))
  const weekday = new Date(
    Date.UTC(Number(part('year')), Number(part('month')) - 1, day)
  ).getUTCDay()
  const dom = fieldMatches(fields[2]!, day)
  const dow = fieldMatches(fields[4]!, weekday, true)
  const dayMatches =
    fields[2] !== '*' && fields[4] !== '*' ? dom || dow : dom && dow
  if (
    !dayMatches ||
    !fieldMatches(fields[0]!, Number(part('minute'))) ||
    !fieldMatches(fields[1]!, Number(part('hour'))) ||
    !fieldMatches(fields[3]!, Number(part('month')))
  )
    return null
  return `${timezone}|${expression}|${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}

interface Attempt {
  key: string
  at: string
  status: 'starting' | 'started' | 'failed'
  message?: string
}

export function createCollectionScheduler(options: {
  stateFile: string
  readPlan: () => Promise<{ expression: string; timezone: string }>
  trigger: () => Promise<{ accepted: boolean; message: string }>
  now?: () => Date
}) {
  let timer: ReturnType<typeof setInterval> | undefined
  let pending: Promise<void> | undefined
  let lastAttempt: Attempt | undefined
  let error: string | undefined
  async function save(attempt: Attempt) {
    const temporary = `${options.stateFile}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(attempt), { mode: 0o600 })
    await rename(temporary, options.stateFile)
    lastAttempt = attempt
  }
  async function run() {
    const plan = await options.readPlan()
    const now = (options.now ?? (() => new Date()))()
    const key = scheduledMinute(plan.expression, plan.timezone, now)
    error = undefined
    if (!lastAttempt) {
      try {
        lastAttempt = JSON.parse(
          await readFile(options.stateFile, 'utf8')
        ) as Attempt
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
    }
    if (!key || lastAttempt?.key === key) return
    // Claim the minute before calling the service so restarts cannot repeat it.
    const attempt: Attempt = { key, at: now.toISOString(), status: 'starting' }
    await save(attempt)
    try {
      const result = await options.trigger()
      await save({
        ...attempt,
        status: result.accepted ? 'started' : 'failed',
        message: result.message,
      })
    } catch (e) {
      await save({
        ...attempt,
        status: 'failed',
        message: e instanceof Error ? e.message : '定时采集启动失败。',
      })
    }
  }
  function tick() {
    if (pending) return pending
    pending = run()
      .catch((e: unknown) => {
        error = e instanceof Error ? e.message : '定时调度失败。'
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
  return {
    tick,
    start() {
      if (timer) return
      timer = setInterval(() => {
        void tick()
      }, 20_000)
      timer.unref()
      void tick()
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      await pending
    },
    status() {
      return { active: Boolean(timer), error, lastAttempt }
    },
  }
}
