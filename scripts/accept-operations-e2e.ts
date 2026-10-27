const baseUrl = process.env.QIUSHUI_AIRADAR_ACCEPTANCE_URL
if (!baseUrl) throw new Error('QIUSHUI_AIRADAR_ACCEPTANCE_URL is required')

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init)
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`)
  return (await response.json()) as T
}

function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

const contents = await json<{
  items: Array<{ id: string; read: boolean }>
}>('/api/contents')
const selected = contents.items.slice(0, 2)
if (selected.length !== 2) throw new Error('Batch acceptance needs two items')
const ids = selected.map((item) => item.id)
let batchStarted = false
try {
  batchStarted = true
  await json('/api/contents/batch', post({ ids, operation: 'mark-read' }))
  const marked = await json<{ items: Array<{ id: string; read: boolean }> }>(
    '/api/contents'
  )
  if (!ids.every((id) => marked.items.find((item) => item.id === id)?.read)) {
    throw new Error('Batch mark-read did not persist')
  }
} finally {
  if (batchStarted) {
    for (const item of selected) {
      await json(
        `/api/contents/${encodeURIComponent(item.id)}/read`,
        post({ read: item.read })
      )
    }
  }
}

type ConfigResponse = {
  own: Record<string, unknown>
  effective: {
    values: { collection?: { batchLimit?: number } }
  }
  versions: Array<{ id: string }>
}
const before = await json<ConfigResponse>('/api/config?level=global')
const targetVersionId = before.versions[0]?.id
if (!targetVersionId) throw new Error('No parameter version to roll back to')
const beforeLimit = before.effective.values.collection?.batchLimit
if (typeof beforeLimit !== 'number') throw new Error('No effective batch limit')
const changedLimit = beforeLimit === 99 ? 98 : 99
let parameterChanged = false
try {
  parameterChanged = true
  await json(
    '/api/config/versions',
    post({
      scope: { level: 'global' },
      values: { collection: { batchLimit: changedLimit } },
      description: 'Issue #22 real acceptance change',
    })
  )
  const changed = await json<ConfigResponse>('/api/config?level=global')
  if (changed.effective.values.collection?.batchLimit !== changedLimit) {
    throw new Error('Parameter version did not become effective')
  }
} finally {
  if (parameterChanged) {
    await json('/api/config/rollback', post({ versionId: targetVersionId }))
  }
}
const rolledBack = await json<ConfigResponse>('/api/config?level=global')
if (rolledBack.effective.values.collection?.batchLimit !== beforeLimit) {
  throw new Error('Parameter rollback did not restore the prior value')
}

process.stdout.write(
  `${JSON.stringify({
    batchItems: ids.length,
    batchStateRestored: true,
    parameterChangedFrom: beforeLimit,
    parameterChangedTo: changedLimit,
    parameterRolledBackTo: beforeLimit,
  })}\n`
)
