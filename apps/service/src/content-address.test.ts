import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { initializeSingleTableConfig } from '@qiushui-airadar/config'
import { SingleTableRepository } from '@qiushui-airadar/runtime'
import { createSingleTableServiceApp } from './single-table-service.js'

it('serves deep links and fetches content directly outside a filtered list', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'airadar-address-test-'))
  let service: ReturnType<typeof createSingleTableServiceApp> | undefined
  try {
    const configRoot = await initializeSingleTableConfig(
      path.resolve(import.meta.dirname, '../../../config'),
      root
    )
    const repository = await SingleTableRepository.open(root)
    const row = await repository.saveOriginal({
      platform: 'x',
      sourceType: 'x',
      sourceAccountId: 'test',
      sourceAccountName: 'Test',
      externalContentId: 'old.item',
      title: 'Older item',
      body: 'Original body',
      kind: 'short_post',
      format: 'plain_text',
      language: 'zh',
    })
    // Direct lookup must not depend on the keyword-filtered list or scope.
    await repository.setManualJunk(row.id, true, 'other', 'Test')
    repository.close()
    const webRoot = path.join(root, 'web')
    await mkdir(webRoot)
    await writeFile(
      path.join(webRoot, 'index.html'),
      '<title>address test</title>'
    )
    service = createSingleTableServiceApp({
      dataRoot: root,
      configRoot,
      webRoot,
    })
    const address = await service.start({ host: '127.0.0.1', port: 0 })
    const base = `http://${address.host}:${address.port}`
    const encodedId = encodeURIComponent(row.id)
    const filtered = await fetch(
      `${base}/api/contents?keyword=not-matching-this-item`
    )
    expect(await filtered.json()).toMatchObject({ items: [] })
    const detail = await fetch(`${base}/api/contents/${encodedId}`)
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({
      item: { id: row.id, title: 'Older item', junk: { isJunk: true } },
    })
    expect((await fetch(`${base}/api/contents/missing`)).status).toBe(404)
    for (const route of [
      '/models',
      `/content/${encodedId}`,
      '/content/x%3Aname.with.dots',
    ]) {
      const page = await fetch(`${base}${route}`)
      expect(page.status).toBe(200)
      expect(page.headers.get('content-type')).toContain('text/html')
      expect(await page.text()).toContain('address test')
    }
    expect((await fetch(`${base}/api/missing`)).status).toBe(404)
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404)
  } finally {
    await service?.stop()
    await rm(root, { recursive: true, force: true })
  }
})
